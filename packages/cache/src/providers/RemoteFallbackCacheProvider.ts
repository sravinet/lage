import { LRUCache } from "lru-cache";
import type { CacheProvider } from "../types/CacheProvider.js";
import type { Logger } from "@lage-run/logger";
import type { Target } from "@lage-run/target-graph";

export interface RemoteFallbackCacheProviderOptions {
  root: string;
  logger: Logger;

  localCacheProvider?: CacheProvider;
  remoteCacheProvider?: CacheProvider;

  writeRemoteCache?: boolean;
}

/**
 * Remote Fallback Cache Provider
 *
 * This backfill cache provider will fallback to a remote cache provider if the local cache does not contain the item.
 * It will also automatically populate the local cache with the remote cache.
 */
export class RemoteFallbackCacheProvider implements CacheProvider {
  private static localHits = new LRUCache<string, boolean>({ 
    max: 10000, // Limit to 10k entries to prevent memory leaks
    ttl: 1000 * 60 * 60 // 1 hour TTL
  });
  private static remoteHits = new LRUCache<string, boolean>({ 
    max: 10000, // Limit to 10k entries to prevent memory leaks
    ttl: 1000 * 60 * 60 // 1 hour TTL
  });

  constructor(private options: RemoteFallbackCacheProviderOptions) {}

  async fetch(hash: string, target: Target) {
    const { logger, remoteCacheProvider, localCacheProvider } = this.options;

    if (localCacheProvider) {
      const localHit = await localCacheProvider.fetch(hash, target);
      RemoteFallbackCacheProvider.localHits.set(hash, localHit);
      logger.silly(`local cache fetch: ${hash} ${localHit}`);
    }

    const localHit = RemoteFallbackCacheProvider.localHits.get(hash);
    if (!localHit && remoteCacheProvider) {
      const remoteHit = await remoteCacheProvider.fetch(hash, target);
      RemoteFallbackCacheProvider.remoteHits.set(hash, remoteHit);
      logger.silly(`remote fallback fetch: ${hash} ${remoteHit}`);

      // now save this into the localCacheProvider, if available
      if (localCacheProvider && remoteHit) {
        logger.silly(`local cache put, fetched cache from remote: ${hash}`);
        await localCacheProvider.put(hash, target);
      }

      return remoteHit;
    }

    return localHit || false;
  }

  async put(hash: string, target: Target) {
    const { logger, remoteCacheProvider, localCacheProvider, writeRemoteCache } = this.options;
    const putPromises: Promise<void>[] = [];

    // Write local cache if it doesn't already exist, or if the the hash isn't in the localHits
    const shouldWriteLocalCache = !this.isLocalHit(hash) && !!localCacheProvider;

    if (shouldWriteLocalCache) {
      logger.silly(`local cache put: ${hash}`);
      putPromises.push(localCacheProvider.put(hash, target));
    }

    // Write to remote if there is a no hit in the remote cache, and remote cache storage provider, and that the "writeRemoteCache" config flag is set to true
    const shouldWriteRemoteCache = !this.isRemoteHit(hash) && !!remoteCacheProvider && writeRemoteCache;

    if (shouldWriteRemoteCache) {
      logger.silly(`remote fallback put: ${hash}`);
      const remotePut = remoteCacheProvider.put(hash, target);
      putPromises.push(remotePut);
    }

    await Promise.all(putPromises);
  }

  private isRemoteHit(hash: string): boolean {
    return RemoteFallbackCacheProvider.remoteHits.get(hash) || false;
  }

  private isLocalHit(hash: string): boolean {
    return RemoteFallbackCacheProvider.localHits.get(hash) || false;
  }

  async clear(): Promise<void> {
    // Clear the hit caches to prevent memory buildup
    RemoteFallbackCacheProvider.localHits.clear();
    RemoteFallbackCacheProvider.remoteHits.clear();
    
    const { localCacheProvider } = this.options;
    if (localCacheProvider) {
      return localCacheProvider.clear();
    }
  }

  async purge(sinceDays: number): Promise<void> {
    const { localCacheProvider } = this.options;
    if (localCacheProvider) {
      return localCacheProvider.purge(sinceDays);
    }
  }
}
