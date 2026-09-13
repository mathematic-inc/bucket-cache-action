import { CacheError } from "../errors.js";
import {
  S3Client,
  HeadObjectCommand,
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
} from "@aws-sdk/client-s3";
import { STSClient, AssumeRoleWithWebIdentityCommand } from "@aws-sdk/client-sts";
import * as core from "@actions/core";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import type { Config } from "../config.js";

import type { Bucket, Entry, Page, Range } from "../storage.js";
import { status } from "../errors.js";
function createClient(config: Config): S3Client {
  return new S3Client({
    region: config.region,
    endpoint: config.endpoint || undefined,
    forcePathStyle: config.forcePathStyle,
    maxAttempts: 3,
    requestHandler: { connectionTimeout: 10000, socketTimeout: 60000 },
    credentials: config.role
      ? async () => {
          const sts = new STSClient({ region: config.region, maxAttempts: 3 });
          try {
            const token = await core.getIDToken(config.audience);
            const result = await sts.send(
              new AssumeRoleWithWebIdentityCommand({
                RoleArn: config.role,
                RoleSessionName: `cache-${process.env.GITHUB_RUN_ID || "action"}-${process.env.GITHUB_RUN_ATTEMPT || "1"}`,
                WebIdentityToken: token,
                DurationSeconds: 3600,
              }),
            );
            const credentials = result.Credentials;
            if (
              !credentials?.AccessKeyId ||
              !credentials.SecretAccessKey ||
              !credentials.SessionToken ||
              !credentials.Expiration
            )
              throw new CacheError("STS returned incomplete credentials");
            core.setSecret(credentials.AccessKeyId);
            core.setSecret(credentials.SecretAccessKey);
            core.setSecret(credentials.SessionToken);
            return {
              accessKeyId: credentials.AccessKeyId,
              secretAccessKey: credentials.SecretAccessKey,
              sessionToken: credentials.SessionToken,
              expiration: credentials.Expiration,
            };
          } finally {
            sts.destroy();
          }
        }
      : undefined,
  });
}

export class S3Bucket implements Bucket {
  readonly client: S3Client;
  constructor(
    readonly config: Config,
    client?: S3Client,
  ) {
    this.client = client || createClient(config);
  }
  close(): void {
    this.client.destroy();
  }
  async head(key: string, signal: AbortSignal): Promise<Entry | undefined> {
    try {
      const result = await this.client.send(
        new HeadObjectCommand({ Bucket: this.config.bucket, Key: key }),
        { abortSignal: signal },
      );
      return {
        key,
        size: result.ContentLength || 0,
        version: result.ETag || "",
        sha256: result.Metadata?.sha256 || "",
      };
    } catch (error) {
      if (status(error) === 404) return undefined;
      throw error;
    }
  }
  async list(prefix: string, token: string | undefined, signal: AbortSignal): Promise<Page> {
    const result = await this.client.send(
      new ListObjectsV2Command({
        Bucket: this.config.bucket,
        Prefix: prefix,
        ContinuationToken: token,
      }),
      { abortSignal: signal },
    );
    if (result.IsTruncated && !result.NextContinuationToken)
      throw new CacheError("S3 returned an invalid pagination token");
    return {
      items: (result.Contents || []).flatMap((item) =>
        item.Key && item.LastModified && item.Size
          ? [{ key: item.Key, modified: item.LastModified.getTime() }]
          : [],
      ),
      token: result.IsTruncated ? result.NextContinuationToken : undefined,
    };
  }
  async read(entry: Entry, start: number, end: number, signal: AbortSignal): Promise<Range> {
    const result = await this.client.send(
      new GetObjectCommand({
        Bucket: this.config.bucket,
        Key: entry.key,
        Range: `bytes=${start}-${end}`,
        IfMatch: entry.version,
      }),
      { abortSignal: signal },
    );
    if (!(result.Body instanceof Readable))
      throw new CacheError("S3 did not return a Node readable stream");
    return {
      body: result.Body,
      contentRange: result.ContentRange || "",
      length: result.ContentLength || 0,
    };
  }
  async upload(
    key: string,
    source: string,
    bytes: number,
    sha256: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    const params = { Bucket: this.config.bucket, Key: key };
    signal.throwIfAborted();
    if (bytes <= this.config.partSize) {
      const body = createReadStream(source);
      try {
        await this.client.send(
          new PutObjectCommand({
            ...params,
            Body: body,
            ContentLength: bytes,
            IfNoneMatch: "*",
            Metadata: { sha256 },
          }),
          { abortSignal: signal },
        );
        return true;
      } catch (error) {
        if (status(error) === 412) return false;
        throw error;
      } finally {
        body.destroy();
      }
    }

    const created = await this.client.send(
      new CreateMultipartUploadCommand({ ...params, Metadata: { sha256 } }),
      { abortSignal: signal },
    );
    if (!created.UploadId) throw new CacheError("S3 did not return a multipart upload ID");
    const upload = { ...params, UploadId: created.UploadId };
    const cancel = new AbortController();
    const combined = AbortSignal.any([signal, cancel.signal]);
    const partSize = Math.max(this.config.partSize, Math.ceil(bytes / 10000));
    const count = Math.ceil(bytes / partSize);
    const parts: { PartNumber: number; ETag: string }[] = [];
    let next = 0;
    let completed = false;
    let failure: unknown;
    try {
      const worker = async () => {
        try {
          while (next < count) {
            const index = next++;
            const start = index * partSize;
            const end = Math.min(start + partSize, bytes) - 1;
            for (let attempt = 0; ; attempt++) {
              const body = createReadStream(source, { start, end });
              try {
                combined.throwIfAborted();
                const result = await this.client.send(
                  new UploadPartCommand({
                    ...upload,
                    PartNumber: index + 1,
                    Body: body,
                    ContentLength: end - start + 1,
                  }),
                  { abortSignal: combined },
                );
                if (!result.ETag) throw new CacheError("S3 did not return a multipart ETag");
                parts.push({ PartNumber: index + 1, ETag: result.ETag });
                break;
              } catch (error) {
                if (combined.aborted || attempt === 2 || status(error) === 403) throw error;
              } finally {
                body.destroy();
              }
            }
          }
        } catch (error) {
          cancel.abort();
          throw error;
        }
      };
      const results = await Promise.allSettled(
        Array.from({ length: Math.min(this.config.concurrency, count) }, worker),
      );
      const failure = results.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
      await this.client.send(
        new CompleteMultipartUploadCommand({
          ...upload,
          IfNoneMatch: "*",
          MultipartUpload: {
            Parts: parts.sort((a, b) => a.PartNumber - b.PartNumber),
          },
        }),
        { abortSignal: combined },
      );
      completed = true;
    } catch (error) {
      failure = error;
    } finally {
      if (!completed) {
        // Cleanup has its own deadline: the transfer signal may already be
        // aborted. This also covers conditional completion conflicts.
        try {
          await this.client.send(new AbortMultipartUploadCommand(upload), {
            abortSignal: AbortSignal.timeout(30000),
          });
        } catch (error) {
          if (status(error) !== 404)
            failure = failure
              ? new AggregateError([failure, error], "Upload and cleanup failed")
              : error;
        }
      }
    }
    if (failure) {
      if (status(failure) === 412) return false;
      throw failure;
    }
    return true;
  }
}
