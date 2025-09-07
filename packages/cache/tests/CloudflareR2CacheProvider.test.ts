import { CloudflareR2CacheProvider } from "../src/providers/CloudflareR2CacheProvider";
import { Logger } from "@lage-run/logger";
import path from "path";
import * as fs from "fs";
import * as os from "os";
import type { Target } from "@lage-run/target-graph";

// Mock AWS SDK
jest.mock("@aws-sdk/client-s3", () => {
  const mockSend = jest.fn();
  const mockS3Client = jest.fn().mockImplementation(() => ({
    send: mockSend,
  }));

  return {
    S3Client: mockS3Client,
    GetObjectCommand: jest.fn(),
    PutObjectCommand: jest.fn(),
    HeadObjectCommand: jest.fn(),
    __mockSend: mockSend,
    __mockS3Client: mockS3Client,
  };
});

// Mock tar-fs
jest.mock("tar-fs", () => ({
  pack: jest.fn(),
  extract: jest.fn(() => ({
    on: jest.fn(),
    write: jest.fn(),
    end: jest.fn(),
  })),
}));

// Mock util
jest.mock("util", () => ({
  ...jest.requireActual("util"),
  promisify: (fn: any) => {
    if (fn.name === 'pipeline') {
      return jest.fn().mockResolvedValue(undefined);
    }
    return jest.requireActual("util").promisify(fn);
  },
}));

const mockS3 = require("@aws-sdk/client-s3");
const mockTar = require("tar-fs");

describe("CloudflareR2CacheProvider", () => {
  let provider: CloudflareR2CacheProvider;
  let mockLogger: Logger;
  let tempDir: string;
  let target: Target;

  beforeEach(() => {
    jest.clearAllMocks();

    mockLogger = new Logger();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lage-r2-test-"));

    const options = {
      accountId: "test-account-id",
      bucket: "test-bucket",
      apiToken: "test-api-token",
      root: tempDir,
      logger: mockLogger,
      maxSize: 1024 * 1024, // 1MB
    };

    provider = new CloudflareR2CacheProvider(options);

    target = {
      id: "test-package",
      cwd: tempDir,
      depSpecs: [],
      dependents: [],
      dependencies: [],
      task: "build",
      label: "test-package - build",
      outputs: ["lib/**/*", "dist/**/*"],
    };
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    jest.clearAllTimers();
  });

  afterAll(() => {
    jest.restoreAllMocks();
  });

  describe("constructor", () => {
    it("should initialize with default endpoint", () => {
      expect(mockS3.S3Client).toHaveBeenCalledWith({
        region: "auto",
        endpoint: "https://test-account-id.r2.cloudflarestorage.com",
        credentials: {
          accessKeyId: "test-api-token",
          secretAccessKey: "test-api-token",
        },
        forcePathStyle: false,
      });
    });

    it("should use custom endpoint when provided", () => {
      jest.clearAllMocks();

      new CloudflareR2CacheProvider({
        accountId: "test-account-id",
        bucket: "test-bucket",
        apiToken: "test-api-token",
        endpoint: "https://custom-endpoint.example.com",
        region: "us-east-1",
        root: tempDir,
        logger: mockLogger,
      });

      expect(mockS3.S3Client).toHaveBeenCalledWith({
        region: "us-east-1",
        endpoint: "https://custom-endpoint.example.com",
        credentials: {
          accessKeyId: "test-api-token",
          secretAccessKey: "test-api-token",
        },
        forcePathStyle: false,
      });
    });
  });

  describe("fetch", () => {
    const testHash = "abc123hash";

    it("should return false for empty hash", async () => {
      const result = await provider.fetch("", target);
      expect(result).toBe(false);
      expect(mockS3.__mockSend).not.toHaveBeenCalled();
    });

    it("should check object size when maxSize is configured", async () => {
      const headResponse = { ContentLength: 500 };
      mockS3.__mockSend.mockResolvedValueOnce(headResponse);

      // Mock a readable stream for the body
      const mockReadableStream = {
        pipe: jest.fn(),
        on: jest.fn(),
        read: jest.fn(),
      };
      const getResponse = { Body: mockReadableStream };
      mockS3.__mockSend.mockResolvedValueOnce(getResponse);

      const mockExtractStream = {
        on: jest.fn(),
        write: jest.fn(),
        end: jest.fn(),
      };
      mockTar.extract.mockReturnValue(mockExtractStream);

      const result = await provider.fetch(testHash, target);
      expect(result).toBe(true);

      // Should call HeadObject first
      expect(mockS3.HeadObjectCommand).toHaveBeenCalledWith({
        Bucket: "test-bucket",
        Key: testHash,
      });

      // Then GetObject
      expect(mockS3.GetObjectCommand).toHaveBeenCalledWith({
        Bucket: "test-bucket",
        Key: testHash,
      });
    });

    it("should return false if object is too large", async () => {
      const headResponse = { ContentLength: 2 * 1024 * 1024 }; // 2MB, larger than 1MB limit
      mockS3.__mockSend.mockResolvedValueOnce(headResponse);

      const result = await provider.fetch(testHash, target);
      expect(result).toBe(false);

      // Should only call HeadObject, not GetObject
      expect(mockS3.HeadObjectCommand).toHaveBeenCalled();
      expect(mockS3.GetObjectCommand).not.toHaveBeenCalled();
    });

    it("should return false for 404 errors", async () => {
      const error = new Error("Not found");
      error.name = "NoSuchKey";
      mockS3.__mockSend.mockRejectedValueOnce(error);

      const result = await provider.fetch(testHash, target);
      expect(result).toBe(false);
    });

    it("should return false for HTTP 404", async () => {
      const error = new Error("Not found");
      (error as any).$metadata = { httpStatusCode: 404 };
      mockS3.__mockSend.mockRejectedValueOnce(error);

      const result = await provider.fetch(testHash, target);
      expect(result).toBe(false);
    });

    it("should return false for other S3 errors", async () => {
      const error = new Error("Access denied");
      mockS3.__mockSend.mockRejectedValueOnce(error);

      const result = await provider.fetch(testHash, target);
      expect(result).toBe(false);
    });
  });

  describe("put", () => {
    const testHash = "abc123hash";

    it("should return early for empty hash", async () => {
      await provider.put("", target);
      expect(mockS3.__mockSend).not.toHaveBeenCalled();
    });

    it("should create tar stream and upload to R2", async () => {
      const mockTarStream = { pipe: jest.fn() };
      mockTar.pack.mockReturnValue(mockTarStream);
      mockS3.__mockSend.mockResolvedValueOnce({});

      await provider.put(testHash, target);

      expect(mockTar.pack).toHaveBeenCalledWith(tempDir, {
        entries: ["lib/**/*", "dist/**/*"],
      });

      expect(mockS3.PutObjectCommand).toHaveBeenCalledWith({
        Bucket: "test-bucket",
        Key: testHash,
        Body: mockTarStream,
        ContentType: "application/x-tar",
      });

      expect(mockS3.__mockSend).toHaveBeenCalledTimes(1);
    });

    it("should use default glob when outputs is **/*", async () => {
      target.outputs = ["**/*"];

      const mockTarStream = { pipe: jest.fn() };
      mockTar.pack.mockReturnValue(mockTarStream);
      mockS3.__mockSend.mockResolvedValueOnce({});

      await provider.put(testHash, target);

      expect(mockTar.pack).toHaveBeenCalledWith(tempDir, {
        entries: undefined, // Let tar-fs handle globbing
      });
    });

    it("should handle upload errors gracefully", async () => {
      const mockTarStream = { pipe: jest.fn() };
      mockTar.pack.mockReturnValue(mockTarStream);
      mockS3.__mockSend.mockRejectedValueOnce(new Error("Upload failed"));

      // Should not throw
      await expect(provider.put(testHash, target)).resolves.toBeUndefined();
    });

    it("should check total size when maxSize is configured", async () => {
      // Create test files
      const libDir = path.join(tempDir, "lib");
      const distDir = path.join(tempDir, "dist");
      fs.mkdirSync(libDir, { recursive: true });
      fs.mkdirSync(distDir, { recursive: true });
      
      // Create files that would exceed maxSize
      const largeContent = "x".repeat(600 * 1024); // 600KB each
      fs.writeFileSync(path.join(libDir, "file1.js"), largeContent);
      fs.writeFileSync(path.join(distDir, "file2.js"), largeContent);

      target.outputs = [`lib/file1.js`, `dist/file2.js`];

      await provider.put(testHash, target);

      // Should not upload because total size > 1MB limit
      expect(mockS3.__mockSend).not.toHaveBeenCalled();
    });
  });

  describe("clear", () => {
    it("should log that no action is taken", async () => {
      const logSpy = jest.spyOn(mockLogger, "silly");

      await provider.clear();

      expect(logSpy).toHaveBeenCalledWith(
        "R2 cache clear requested - no action taken (configure R2 lifecycle rules instead)"
      );
    });
  });

  describe("purge", () => {
    it("should log that no action is taken", async () => {
      const logSpy = jest.spyOn(mockLogger, "silly");

      await provider.purge(30);

      expect(logSpy).toHaveBeenCalledWith(
        "R2 cache purge requested for 30 days - no action taken (configure R2 lifecycle rules instead)"
      );
    });
  });
});