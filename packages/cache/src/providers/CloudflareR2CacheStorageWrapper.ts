import { CloudflareR2CacheProvider } from "./CloudflareR2CacheProvider.js";
import type { CloudflareR2CacheStorageConfig } from "@lage-run/config";
import type { Logger } from "@lage-run/logger";
import type { Target } from "@lage-run/target-graph";
import type { Logger as BackfillLogger } from "backfill-logger";

/**
 * Wrapper that adapts the CloudflareR2CacheProvider to the backfill cache storage interface
 */
export class CloudflareR2CacheStorageWrapper {
  private r2Provider: CloudflareR2CacheProvider;
  private target: Target;

  constructor(
    config: CloudflareR2CacheStorageConfig,
    cwd: string,
    logger: Logger,
    backfillLogger: BackfillLogger
  ) {
    this.r2Provider = new CloudflareR2CacheProvider({
      ...config.options,
      root: cwd,
      logger,
    });

    // Create a minimal target for the R2 provider
    this.target = {
      id: "backfill-target",
      cwd,
      depSpecs: [],
      dependents: [],
      dependencies: [],
      task: "cache",
      label: "cache",
      outputs: ["**/*"],
    };
  }

  async fetch(hash: string): Promise<boolean> {
    return this.r2Provider.fetch(hash, this.target);
  }

  async put(hash: string, outputGlob: string[]): Promise<void> {
    const targetWithOutputs = {
      ...this.target,
      outputs: outputGlob,
    };
    return this.r2Provider.put(hash, targetWithOutputs);
  }
}