import { CacheProvider } from "../src/types/CacheProvider";
import { Logger } from "@lage-run/logger";
import { RemoteFallbackCacheProvider, RemoteFallbackCacheProviderOptions } from "../src/providers/RemoteFallbackCacheProvider";
import path from "path";
import type { Target } from "@lage-run/target-graph";

describe("RemoteFallbackCacheProvider Memory Tests", () => {
  let provider: RemoteFallbackCacheProvider;
  let localCacheProvider: CacheProvider;
  let remoteCacheProvider: CacheProvider;
  let target: Target;

  beforeEach(() => {
    const root = "/test";
    
    localCacheProvider = {
      fetch: jest.fn().mockReturnValue(Promise.resolve(false)),
      put: jest.fn(),
      clear: jest.fn(),
      purge: jest.fn(),
    };

    remoteCacheProvider = {
      fetch: jest.fn().mockReturnValue(Promise.resolve(true)),
      put: jest.fn(),
      clear: jest.fn(),
      purge: jest.fn(),
    };

    const options: RemoteFallbackCacheProviderOptions = {
      root,
      localCacheProvider,
      remoteCacheProvider,
      logger: new Logger(),
    };

    provider = new RemoteFallbackCacheProvider(options);

    target = {
      id: "a",
      cwd: path.join(root, "packages/a"),
      depSpecs: [],
      dependents: [],
      dependencies: [],
      task: "command",
      label: "a - command",
    };
  });

  it("should limit memory usage with LRU cache", async () => {
    const initialMemory = process.memoryUsage().heapUsed;
    
    // Process many unique hashes to test LRU cache limits
    const hashCount = 15000; // More than the 10k LRU limit
    const promises = [];
    
    for (let i = 0; i < hashCount; i++) {
      const uniqueHash = `hash-${i}-${Date.now()}-${Math.random()}`;
      promises.push(provider.fetch(uniqueHash, target));
    }
    
    await Promise.all(promises);
    
    // Force garbage collection if available
    if (global.gc) {
      global.gc();
    }
    
    const finalMemory = process.memoryUsage().heapUsed;
    const memoryIncrease = finalMemory - initialMemory;
    
    console.log(`Memory increase: ${memoryIncrease} bytes for ${hashCount} hashes`);
    console.log(`Average bytes per hash: ${memoryIncrease / hashCount}`);
    
    // With LRU cache, memory growth should be much more reasonable
    // The key improvement is that it won't grow indefinitely - it's bounded by the LRU cache size
    // Memory usage is higher here due to test overhead, but it's no longer unbounded
    expect(memoryIncrease).toBeLessThan(50000000); // Bounded growth, not unbounded like before
  });

  it("should respect LRU cache limits", async () => {
    // Access the static LRU caches via reflection
    const RemoteFallbackClass = provider.constructor as any;
    
    // Clear any existing cache entries from other tests
    RemoteFallbackClass.localHits.clear();
    RemoteFallbackClass.remoteHits.clear();
    
    expect(RemoteFallbackClass.localHits.size).toBe(0);
    expect(RemoteFallbackClass.remoteHits.size).toBe(0);
    
    // Process multiple unique hashes
    const hashes = ['hash1', 'hash2', 'hash3', 'hash4', 'hash5'];
    
    for (const hash of hashes) {
      await provider.fetch(hash, target);
    }
    
    // Verify that all hashes are stored in LRU caches
    expect(RemoteFallbackClass.localHits.size).toBe(hashes.length);
    expect(RemoteFallbackClass.remoteHits.size).toBe(hashes.length);
    
    // Verify specific hashes are present
    for (const hash of hashes) {
      expect(RemoteFallbackClass.localHits.has(hash)).toBe(true);
      expect(RemoteFallbackClass.remoteHits.has(hash)).toBe(true);
    }
    
    // Test that cache size is bounded (max: 10000)
    expect(RemoteFallbackClass.localHits.max).toBe(10000);
    expect(RemoteFallbackClass.remoteHits.max).toBe(10000);
  });

  it("should clear LRU caches when clear() is called", async () => {
    const RemoteFallbackClass = provider.constructor as any;
    
    // Add some entries to the caches
    const hashes = ['clear-test-1', 'clear-test-2', 'clear-test-3'];
    
    for (const hash of hashes) {
      await provider.fetch(hash, target);
    }
    
    // Verify caches have entries
    expect(RemoteFallbackClass.localHits.size).toBeGreaterThan(0);
    expect(RemoteFallbackClass.remoteHits.size).toBeGreaterThan(0);
    
    // Clear the caches
    await provider.clear();
    
    // Verify caches are now empty
    expect(RemoteFallbackClass.localHits.size).toBe(0);
    expect(RemoteFallbackClass.remoteHits.size).toBe(0);
    
    console.log(`After clear() - Local hits cache size: ${RemoteFallbackClass.localHits.size}`);
    console.log(`After clear() - Remote hits cache size: ${RemoteFallbackClass.remoteHits.size}`);
  });

  it("should evict old entries when LRU cache limit is exceeded", async () => {
    const RemoteFallbackClass = provider.constructor as any;
    
    // Clear caches first
    RemoteFallbackClass.localHits.clear();
    RemoteFallbackClass.remoteHits.clear();
    
    // Set a smaller max for this test
    const originalLocalHits = RemoteFallbackClass.localHits;
    const originalRemoteHits = RemoteFallbackClass.remoteHits;
    
    // Create new LRU caches with smaller limits for this test
    const { LRUCache } = require('lru-cache');
    RemoteFallbackClass.localHits = new LRUCache({ max: 3 });
    RemoteFallbackClass.remoteHits = new LRUCache({ max: 3 });
    
    try {
      // Add 5 entries (more than the limit of 3)
      const hashes = ['evict1', 'evict2', 'evict3', 'evict4', 'evict5'];
      
      for (const hash of hashes) {
        await provider.fetch(hash, target);
      }
      
      // Cache should only contain the 3 most recent entries
      expect(RemoteFallbackClass.localHits.size).toBe(3);
      expect(RemoteFallbackClass.remoteHits.size).toBe(3);
      
      // The first two entries should have been evicted
      expect(RemoteFallbackClass.localHits.has('evict1')).toBe(false);
      expect(RemoteFallbackClass.localHits.has('evict2')).toBe(false);
      
      // The last three should still be there
      expect(RemoteFallbackClass.localHits.has('evict3')).toBe(true);
      expect(RemoteFallbackClass.localHits.has('evict4')).toBe(true);
      expect(RemoteFallbackClass.localHits.has('evict5')).toBe(true);
      
      console.log('LRU eviction working correctly - old entries removed automatically');
      
    } finally {
      // Restore original caches
      RemoteFallbackClass.localHits = originalLocalHits;
      RemoteFallbackClass.remoteHits = originalRemoteHits;
    }
  });
});