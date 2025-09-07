import { S3Client, GetObjectCommand, PutObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { Transform, pipeline } from "stream";
import { promisify } from "util";
import * as tar from "tar-fs";
import * as fs from "fs";
import * as path from "path";
import type { CacheProvider } from "../types/CacheProvider.js";
import type { Logger } from "@lage-run/logger";
import type { Target } from "@lage-run/target-graph";

const pipelineAsync = promisify(pipeline);

export interface CloudflareR2CacheProviderOptions {
  /**
   * Cloudflare R2 account ID
   */
  accountId: string;
  
  /**
   * R2 bucket name
   */
  bucket: string;
  
  /**
   * R2 API token with read/write permissions
   */
  apiToken: string;
  
  /**
   * Optional custom endpoint URL (defaults to Cloudflare R2)
   */
  endpoint?: string;
  
  /**
   * Optional region (defaults to 'auto')
   */
  region?: string;
  
  /**
   * Maximum file size to download/upload (in bytes)
   */
  maxSize?: number;
  
  /**
   * Root directory for cache operations
   */
  root: string;
  
  /**
   * Logger instance
   */
  logger: Logger;
}

/**
 * Timeout stream that emits an error if input hasn't started after a timeout
 */
class TimeoutStream extends Transform {
  private timeout: NodeJS.Timeout;

  constructor(timeoutMs: number, message: string) {
    super();
    this.timeout = setTimeout(() => {
      this.destroy(new Error(message));
    }, timeoutMs);
  }

  _transform(chunk: any, _encoding: string, callback: Function) {
    clearTimeout(this.timeout);
    this.push(chunk);
    callback();
  }
}

/**
 * Cloudflare R2 Cache Provider
 * 
 * Provides remote caching using Cloudflare R2 storage (S3-compatible API)
 */
export class CloudflareR2CacheProvider implements CacheProvider {
  private s3Client: S3Client;
  private options: CloudflareR2CacheProviderOptions;

  constructor(options: CloudflareR2CacheProviderOptions) {
    this.options = options;
    
    const endpoint = options.endpoint || `https://${options.accountId}.r2.cloudflarestorage.com`;
    
    this.s3Client = new S3Client({
      region: options.region || 'auto',
      endpoint,
      credentials: {
        accessKeyId: options.apiToken,
        secretAccessKey: options.apiToken,
      },
      // R2 requires path-style bucket access
      forcePathStyle: false,
    });
  }

  async fetch(hash: string, target: Target): Promise<boolean> {
    const { logger, bucket, maxSize } = this.options;
    
    if (!hash) {
      return false;
    }

    try {
      // Check object size if maxSize is configured
      if (maxSize) {
        const headCommand = new HeadObjectCommand({
          Bucket: bucket,
          Key: hash,
        });
        
        const headResponse = await this.s3Client.send(headCommand);
        
        if (headResponse.ContentLength && headResponse.ContentLength > maxSize) {
          logger.silly(`R2 object too large to download: ${hash}, size: ${headResponse.ContentLength} bytes`, { target });
          return false;
        }
      }

      // Download the object
      const getCommand = new GetObjectCommand({
        Bucket: bucket,
        Key: hash,
      });

      const response = await this.s3Client.send(getCommand);
      
      if (!response.Body) {
        throw new Error("No body in R2 response");
      }

      // Extract the tar stream directly to the target directory
      const extractStream = tar.extract(target.cwd);
      const timeoutStream = new TimeoutStream(
        10 * 60 * 1000, // 10 minutes
        `R2 fetch request for ${hash} timed out`
      );

      await pipelineAsync(
        response.Body as NodeJS.ReadableStream,
        timeoutStream,
        extractStream
      );

      logger.silly(`Successfully fetched cache from R2: ${hash}`, { target });
      return true;

    } catch (error: any) {
      if (error.name === 'NoSuchKey' || error.$metadata?.httpStatusCode === 404) {
        logger.silly(`Cache miss in R2: ${hash}`, { target });
        return false;
      }

      let message = error.message || String(error);
      logger.silly(`R2 cache fetch failed: ${message}`, { target });
      return false;
    }
  }

  async put(hash: string, target: Target): Promise<void> {
    const { logger, bucket, maxSize } = this.options;
    
    if (!hash) {
      return;
    }

    try {
      const outputGlob = target.outputs || ["**/*"];
      
      // Check total size if maxSize is configured
      if (maxSize) {
        let totalSize = 0;
        for (const glob of outputGlob) {
          // Simple size estimation - in production you'd want proper glob expansion
          const globPath = path.resolve(target.cwd, glob);
          if (fs.existsSync(globPath)) {
            const stat = await fs.promises.stat(globPath);
            totalSize += stat.size;
          }
        }
        
        if (totalSize > maxSize) {
          logger.silly(`Output too large for R2 upload: ${hash}, size: ${totalSize} bytes`, { target });
          return;
        }
      }

      // Create tar stream from the files
      const tarStream = tar.pack(target.cwd, { 
        entries: outputGlob.length === 1 && outputGlob[0] === "**/*" 
          ? undefined // Let tar-fs handle globbing
          : outputGlob 
      });

      // Upload to R2
      const putCommand = new PutObjectCommand({
        Bucket: bucket,
        Key: hash,
        Body: tarStream,
        ContentType: 'application/x-tar',
      });

      await this.s3Client.send(putCommand);
      
      logger.silly(`Successfully uploaded cache to R2: ${hash}`, { target });

    } catch (error: any) {
      let message = error.message || String(error);
      logger.silly(`R2 cache put failed: ${message}`, { target });
      // Don't throw - caching failures shouldn't break the build
    }
  }

  async clear(): Promise<void> {
    // R2 doesn't have a built-in "clear all" operation
    // This would require listing and deleting objects, which is expensive
    // For now, this is a no-op - individual objects will expire based on R2 lifecycle rules
    this.options.logger.silly("R2 cache clear requested - no action taken (configure R2 lifecycle rules instead)");
  }

  async purge(sinceDays: number): Promise<void> {
    // Similar to clear(), purging would require listing objects by date
    // This is better handled by R2 lifecycle rules
    this.options.logger.silly(`R2 cache purge requested for ${sinceDays} days - no action taken (configure R2 lifecycle rules instead)`);
  }
}