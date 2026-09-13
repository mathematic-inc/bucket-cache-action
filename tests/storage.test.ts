import { afterEach, describe, expect, it, vi } from "vitest";
import {
  S3Client,
  HeadObjectCommand,
  ListObjectsV2Command,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { Storage } from "../src/storage.js";
import { S3Bucket } from "../src/storage/s3.js";
import { readConfig } from "../src/config.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";

const contents = Buffer.from("verified archive");
const sha256 = createHash("sha256").update(contents).digest("hex");
const metadata = {
  ContentLength: contents.length,
  ETag: "etag",
  Metadata: { sha256 },
};
const missing = Object.assign(new Error("not found"), {
  $metadata: { httpStatusCode: 404 },
});
function setup(restoreKeys = "old/\nolder/") {
  const values: Record<string, string> = {
    bucket: "test-cache-bucket",
    region: "us-east-1",
    path: "cache",
    key: "exact",
    "restore-keys": restoreKeys,
  };
  const config = readConfig((key) => values[key] || "", {
    GITHUB_REPOSITORY: "owner/repo",
  });
  const client = new S3Client({
    region: "us-east-1",
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
  });
  return {
    storage: new Storage(new S3Bucket(config, client), config, "namespace/"),
    send: vi.spyOn(client, "send"),
  };
}
afterEach(() => {
  vi.restoreAllMocks();
});

describe("S3 key selection", () => {
  it("prefers an exact HEAD match without listing prefixes", async () => {
    const { storage, send } = setup();
    send.mockImplementation(async (command) => {
      expect(command).toBeInstanceOf(HeadObjectCommand);
      expect(command.input).toMatchObject({ Key: "namespace/exact" });
      return metadata;
    });
    expect((await storage.lookup(AbortSignal.timeout(1000)))?.key).toBe(
      "exact",
    );
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("selects the newest match across pages before considering the next prefix", async () => {
    const { storage, send } = setup();
    send.mockImplementation(async (command) => {
      if (command instanceof HeadObjectCommand) {
        if (command.input.Key === "namespace/exact") throw missing;
        expect(command.input.Key).toBe("namespace/old/newest");
        return metadata;
      }
      expect(command).toBeInstanceOf(ListObjectsV2Command);
      if (!(command instanceof ListObjectsV2Command))
        throw new Error("unexpected command");
      expect(command.input.Prefix).toBe("namespace/old/");
      if (!command.input.ContinuationToken)
        return {
          Contents: [
            { Key: "namespace/old/first", LastModified: new Date(1), Size: 1 },
          ],
          IsTruncated: true,
          NextContinuationToken: "page-2",
        };
      expect(command.input.ContinuationToken).toBe("page-2");
      return {
        Contents: [
          { Key: "namespace/old/newest", LastModified: new Date(2), Size: 1 },
        ],
        IsTruncated: false,
      };
    });
    expect((await storage.lookup(AbortSignal.timeout(1000)))?.key).toBe(
      "old/newest",
    );
  });
  it("does not reinterpret access denied as a cache miss", async () => {
    const { storage, send } = setup();
    const denied = Object.assign(new Error("denied"), {
      $metadata: { httpStatusCode: 403 },
    });
    send.mockRejectedValue(denied);
    await expect(storage.lookup(AbortSignal.timeout(1000))).rejects.toBe(
      denied,
    );
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("rejects invalid pagination instead of returning a partial match", async () => {
    const { storage, send } = setup();
    send.mockImplementation(async (command) => {
      if (command instanceof HeadObjectCommand) throw missing;
      return { IsTruncated: true };
    });
    await expect(storage.lookup(AbortSignal.timeout(1000))).rejects.toThrow(
      "pagination",
    );
  });
  it("rejects caches without a checksum before downloading", async () => {
    const { storage, send } = setup();
    send.mockImplementation(async () => ({ ...metadata, Metadata: {} }));
    await expect(storage.lookup(AbortSignal.timeout(1000))).rejects.toThrow(
      "metadata",
    );
  });
});

describe("S3 range download", () => {
  it("retries a truncated stream and verifies the complete SHA-256", async () => {
    const { storage, send } = setup();
    let attempts = 0;
    send.mockImplementation(async (command) => {
      expect(command).toBeInstanceOf(GetObjectCommand);
      expect(command.input).toMatchObject({
        IfMatch: "etag",
        Range: `bytes=0-${contents.length - 1}`,
      });
      attempts++;
      return {
        ContentRange: `bytes 0-${contents.length - 1}/${contents.length}`,
        ContentLength: contents.length,
        Body: Readable.from([
          attempts === 1 ? contents.subarray(0, 2) : contents,
        ]),
      };
    });
    const directory = await mkdtemp(
      path.join(process.env.RUNNER_TEMP || process.cwd(), "range-test-"),
    );
    try {
      const file = path.join(directory, "cache");
      await storage.download(
        { key: "exact", size: contents.length, version: "etag", sha256 },
        file,
        AbortSignal.timeout(2000),
      );
      expect(await readFile(file)).toEqual(contents);
      expect(attempts).toBe(2);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("rejects same-length corruption before extraction", async () => {
    const { storage, send } = setup();
    send.mockImplementation(async () => ({
      ContentRange: `bytes 0-${contents.length - 1}/${contents.length}`,
      ContentLength: contents.length,
      Body: Readable.from([Buffer.alloc(contents.length)]),
    }));
    const directory = await mkdtemp(
      path.join(process.env.RUNNER_TEMP || process.cwd(), "range-test-"),
    );
    try {
      await expect(
        storage.download(
          { key: "exact", size: contents.length, version: "etag", sha256 },
          path.join(directory, "cache"),
          AbortSignal.timeout(2000),
        ),
      ).rejects.toThrow("SHA-256");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
