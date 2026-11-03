import { CacheError, status } from "./errors.js";
import { open } from "node:fs/promises";
import type { Readable } from "node:stream";
import type { Config, Tier } from "./config.js";
import { digest, size } from "./archive.js";
import { S3Bucket } from "./storage/s3.js";
import { GcsBucket } from "./storage/gcs.js";

export interface Entry {
  key: string;
  size: number;
  version: string;
  sha256: string;
}
export interface Page {
  items: { key: string; modified: number }[];
  token?: string;
}
export interface Range {
  body: Readable;
  contentRange: string;
  length: number;
}
export interface Bucket {
  // Signs in and heads key: the tier's first request. With once, it is made a
  // single time, so a tier that can't be reached is passed over within its
  // connect timeout. Either failure throws Unavailable.
  connect(key: string, signal: AbortSignal, once: boolean): Promise<Entry | undefined>;
  head(key: string, signal: AbortSignal): Promise<Entry | undefined>;
  list(prefix: string, token: string | undefined, signal: AbortSignal): Promise<Page>;
  read(entry: Entry, start: number, end: number, signal: AbortSignal): Promise<Range>;
  upload(
    key: string,
    source: string,
    bytes: number,
    sha256: string,
    signal: AbortSignal,
  ): Promise<boolean>;
  close?(): void;
}
export function createStorage(config: Config, tier: Tier, namespace: string): Storage {
  return new Storage(
    tier.provider === "s3" ? new S3Bucket(tier, config) : new GcsBucket(tier, config),
    config,
    namespace,
  );
}
export class Storage {
  constructor(
    readonly bucket: Bucket,
    readonly config: Config,
    readonly namespace: string,
  ) {}
  close(): void {
    this.bucket.close?.();
  }
  private checked(entry: Entry, key: string): Entry {
    if (
      !entry.size ||
      entry.size > this.config.maxSize ||
      !entry.version ||
      !/^[a-f0-9]{64}$/.test(entry.sha256)
    )
      throw new CacheError("Cache has invalid size, version, or SHA-256 metadata");
    return { ...entry, key };
  }
  private async head(key: string, signal: AbortSignal): Promise<Entry | undefined> {
    const entry = await this.bucket.head(this.namespace + key, signal);
    return entry && this.checked(entry, key);
  }
  /** Signs in and looks up the exact key, as the first request to the bucket. */
  async connect(signal: AbortSignal, once = false): Promise<Entry | undefined> {
    const entry = await this.bucket.connect(this.namespace + this.config.key, signal, once);
    return entry && this.checked(entry, this.config.key);
  }
  /** The newest object under one restore key. */
  async fallback(prefix: string, signal: AbortSignal): Promise<Entry | undefined> {
    let token: string | undefined;
    let newest: { key: string; modified: number } | undefined;
    for (let page = 0; ; page++) {
      if (page === 1000)
        throw new CacheError("Cache lookup exceeded 1000 pages; narrow restore-keys");
      const result = await this.bucket.list(this.namespace + prefix, token, signal);
      for (const object of result.items) {
        if (!object.key?.startsWith(this.namespace + prefix) || !object.modified) continue;
        const modified = object.modified;
        if (
          !newest ||
          modified > newest.modified ||
          (modified === newest.modified && object.key > newest.key)
        )
          newest = { key: object.key, modified };
      }
      if (!result.token) break;
      if (!result.token || result.token === token)
        throw new CacheError("Bucket returned an invalid pagination token");
      token = result.token;
    }
    return newest && this.head(newest.key.slice(this.namespace.length), signal);
  }

  async download(entry: Entry, destination: string, signal: AbortSignal): Promise<void> {
    const file = await open(destination, "w");
    const cancel = new AbortController();
    const combined = AbortSignal.any([signal, cancel.signal]);
    let next = 0;
    try {
      await file.truncate(entry.size);
      const worker = async () => {
        try {
          while (next < entry.size) {
            const start = next;
            next += this.config.partSize;
            const end = Math.min(start + this.config.partSize, entry.size) - 1;
            for (let attempt = 0; ; attempt++) {
              let body: Readable | undefined;
              const abort = () => body?.destroy(new CacheError("Cache download aborted"));
              combined.addEventListener("abort", abort, { once: true });
              try {
                const result = await this.bucket.read(
                  { ...entry, key: this.namespace + entry.key },
                  start,
                  end,
                  combined,
                );
                body = result.body;
                if (
                  result.contentRange !== `bytes ${start}-${end}/${entry.size}` ||
                  result.length !== end - start + 1
                )
                  throw new CacheError("Bucket returned an invalid byte range");
                let offset = start;
                for await (const value of body) {
                  const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
                  if (offset + chunk.length > end + 1)
                    throw new CacheError("Bucket returned an oversized byte range");
                  let written = 0;
                  while (written < chunk.length) {
                    const { bytesWritten } = await file.write(
                      chunk,
                      written,
                      chunk.length - written,
                      offset,
                    );
                    if (!bytesWritten)
                      throw new CacheError("Cache download could not write to disk");
                    offset += bytesWritten;
                    written += bytesWritten;
                  }
                }
                if (offset !== end + 1)
                  throw new CacheError("Bucket returned a truncated byte range");
                break;
              } catch (error) {
                if (
                  combined.aborted ||
                  attempt === 2 ||
                  status(error) === 403 ||
                  status(error) === 412
                )
                  throw error;
              } finally {
                combined.removeEventListener("abort", abort);
                body?.destroy();
              }
            }
          }
        } catch (error) {
          cancel.abort();
          throw error;
        }
      };
      const results = await Promise.allSettled(
        Array.from(
          {
            length: Math.min(this.config.concurrency, Math.ceil(entry.size / this.config.partSize)),
          },
          worker,
        ),
      );
      const failed = results.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    } finally {
      await file.close();
    }
    if ((await digest(destination)) !== entry.sha256)
      throw new CacheError("Downloaded cache failed SHA-256 verification");
  }

  async upload(key: string, source: string, signal: AbortSignal): Promise<boolean> {
    // Avoid hashing/transferring archives that another job already published.
    // Provider-side creation preconditions still resolve concurrent misses.
    if (await this.bucket.head(this.namespace + key, signal)) return false;
    const bytes = await size(source, this.config.maxSize);
    const sha256 = await digest(source);
    signal.throwIfAborted();
    return this.bucket.upload(this.namespace + key, source, bytes, sha256, signal);
  }
}
