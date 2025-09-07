import { createBackfillCacheConfig } from "../src/backfillWrapper";
import { BackfillCacheProvider } from "../src/providers/BackfillCacheProvider";
import { Logger } from "@lage-run/logger";
import path from "path";
import * as fs from "fs";
import * as os from "os";
import type { Target } from "@lage-run/target-graph";

// Mock AWS SDK for integration tests
jest.mock("@aws-sdk/client-s3");

const mockS3 = require("@aws-sdk/client-s3");

describe("Cloudflare R2 Integration", () => {
  let tempDir: string;
  let logger: Logger;
  let target: Target;

  beforeEach(() => {
    jest.clearAllMocks();
    
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lage-r2-integration-"));
    
    // Create a minimal package.json for backfill config
    fs.writeFileSync(path.join(tempDir, "package.json"), JSON.stringify({
      name: "test-package",
      version: "1.0.0"
    }));
    
    logger = new Logger();

    target = {
      id: "test-package",
      cwd: tempDir,
      depSpecs: [],
      dependents: [],
      dependencies: [],
      task: "build",
      label: "test-package - build",
      outputs: ["dist/**/*"],
    };

    // Setup mock S3 client
    mockS3.__mockSend = jest.fn();
    mockS3.S3Client.mockImplementation(() => ({
      send: mockS3.__mockSend,
    }));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    delete process.env.BACKFILL_CACHE_PROVIDER;
    delete process.env.BACKFILL_CACHE_PROVIDER_OPTIONS;
    jest.clearAllTimers();
  });

  afterAll(() => {
    jest.restoreAllMocks();
  });

  describe("Configuration", () => {
    it("should handle R2 config passed directly to createBackfillCacheConfig", () => {
      const dummyLogger = { error: jest.fn(), warn: jest.fn(), info: jest.fn() } as any;
      const config = createBackfillCacheConfig(
        tempDir,
        {
          cacheStorageConfig: {
            provider: "cloudflare-r2" as const,
            options: {
              accountId: "test-account-123",
              bucket: "my-cache-bucket",
              apiToken: "secret-token",
              maxSize: 50 * 1024 * 1024, // 50MB
            },
          },
        },
        dummyLogger
      );

      expect(config.cacheStorageConfig?.provider).toBe("cloudflare-r2");
      
      if (config.cacheStorageConfig?.provider === "cloudflare-r2") {
        expect(config.cacheStorageConfig.options).toEqual({
          accountId: "test-account-123",
          bucket: "my-cache-bucket",
          apiToken: "secret-token",
          maxSize: 50 * 1024 * 1024,
        });
      }
    });

    it("should preserve R2 config when merging with backfill defaults", () => {
      const dummyLogger = { error: jest.fn(), warn: jest.fn(), info: jest.fn() } as any;
      const r2Config = {
        provider: "cloudflare-r2" as const,
        options: {
          accountId: "env-account",
          bucket: "env-bucket", 
          apiToken: "env-token",
        },
      };

      const config = createBackfillCacheConfig(
        tempDir,
        { cacheStorageConfig: r2Config },
        dummyLogger
      );

      expect(config.cacheStorageConfig?.provider).toBe("cloudflare-r2");
    });
  });

  describe("BackfillCacheProvider with R2", () => {
    it("should create R2 cache provider when configured", async () => {
      const cacheOptions = {
        cacheStorageConfig: {
          provider: "cloudflare-r2" as const,
          options: {
            accountId: "test-account",
            bucket: "test-bucket",
            apiToken: "test-token",
          },
        },
      };

      const provider = new BackfillCacheProvider({
        root: tempDir,
        logger,
        cacheOptions,
      });

      // Mock successful R2 operations
      mockS3.__mockSend.mockResolvedValueOnce({ ContentLength: 1000 }); // HeadObject
      mockS3.__mockSend.mockResolvedValueOnce({ Body: null }); // GetObject - will fail but that's ok for this test

      const result = await provider.fetch("test-hash", target);
      expect(result).toBe(false); // Will fail due to null body, but that's expected

      // Verify S3 client was called with correct parameters
      expect(mockS3.S3Client).toHaveBeenCalledWith({
        region: "auto",
        endpoint: "https://test-account.r2.cloudflarestorage.com",
        credentials: {
          accessKeyId: "test-token",
          secretAccessKey: "test-token",
        },
        forcePathStyle: false,
      });
    });

    it("should fall back to backfill providers for non-R2 configs", async () => {
      const cacheOptions = {
        cacheStorageConfig: {
          provider: "local" as const,
        },
      };

      const provider = new BackfillCacheProvider({
        root: tempDir,
        logger,
        cacheOptions,
      });

      // This should use the regular backfill local cache provider
      const result = await provider.fetch("test-hash", target);
      expect(result).toBe(false); // Cache miss is expected

      // Should not have called S3
      expect(mockS3.S3Client).not.toHaveBeenCalled();
    });
  });

  describe("R2 Configuration Options", () => {
    it("should support all R2 configuration options", () => {
      const dummyLogger = { error: jest.fn(), warn: jest.fn(), info: jest.fn() } as any;
      const config = createBackfillCacheConfig(
        tempDir,
        {
          cacheStorageConfig: {
            provider: "cloudflare-r2" as const,
            options: {
              accountId: "my-account-id",
              bucket: "my-cache-bucket",
              apiToken: "my-r2-token",
              endpoint: "https://custom.r2.endpoint.com",
              region: "us-west-2",
              maxSize: 100 * 1024 * 1024, // 100MB
            },
          },
        },
        dummyLogger
      );

      if (config.cacheStorageConfig?.provider === "cloudflare-r2") {
        expect(config.cacheStorageConfig.options).toEqual({
          accountId: "my-account-id",
          bucket: "my-cache-bucket",
          apiToken: "my-r2-token",
          endpoint: "https://custom.r2.endpoint.com",
          region: "us-west-2",
          maxSize: 100 * 1024 * 1024,
        });
      }
    });
  });

  describe("R2 vs Azure Configuration Priority", () => {
    it("should handle R2 config in backfill wrapper without credential processing", () => {
      const dummyLogger = { error: jest.fn(), warn: jest.fn(), info: jest.fn() } as any;
      const config = createBackfillCacheConfig(
        tempDir,
        {
          cacheStorageConfig: {
            provider: "cloudflare-r2" as const,
            options: {
              accountId: "test-account",
              bucket: "test-bucket",
              apiToken: "test-token",
            },
          },
        },
        dummyLogger
      );

      // Should preserve R2 config as-is without modifications
      expect(config.cacheStorageConfig?.provider).toBe("cloudflare-r2");
      if (config.cacheStorageConfig?.provider === "cloudflare-r2") {
        expect(config.cacheStorageConfig.options).toEqual({
          accountId: "test-account",
          bucket: "test-bucket",
          apiToken: "test-token",
        });
      }
    });

    it("should still process Azure credentials when Azure is configured", () => {
      const dummyLogger = { error: jest.fn(), warn: jest.fn(), info: jest.fn() } as any;
      const config = createBackfillCacheConfig(
        tempDir,
        {
          cacheStorageConfig: {
            provider: "azure-blob" as any,
            options: {
              connectionString: "AccountName=test;AccountKey=key123",
              container: "test-container",
            },
          },
        },
        dummyLogger
      );

      expect(config.cacheStorageConfig?.provider).toBe("azure-blob");
      // Should have added credential for non-SAS connection string
      expect((config.cacheStorageConfig as any).options.credential).toBeDefined();
    });
  });
});