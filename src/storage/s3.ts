import { createReadStream } from "node:fs";
import { Readable } from "node:stream";

import * as core from "@actions/core";
import {
  S3Client,
  type S3ClientConfig,
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

import type { Config, Tier } from "../config.js";
import { CacheError } from "../errors.js";
import { describe, status, toError, unanswered, Unavailable } from "../errors.js";
import type { Bucket, Entry, Page, Range } from "../storage.js";
import { nonEmpty } from "../utils.js";
// Static credentials that a self-hosted runner's environment holds under
// another prefix than AWS_, read again in each phase as the role's are fetched.
function environmentCredentials(prefix: string) {
  return () => {
    const accessKeyId = nonEmpty(process.env[`${prefix}_ACCESS_KEY_ID`]);
    const secretAccessKey = nonEmpty(process.env[`${prefix}_SECRET_ACCESS_KEY`]);
    const sessionToken = nonEmpty(process.env[`${prefix}_SESSION_TOKEN`]);
    if (accessKeyId === undefined || secretAccessKey === undefined) {
      return Promise.reject(
        new CacheError(`${prefix}_ACCESS_KEY_ID and ${prefix}_SECRET_ACCESS_KEY must both be set`),
      );
    }
    core.setSecret(accessKeyId);
    core.setSecret(secretAccessKey);
    if (sessionToken !== undefined) {
      core.setSecret(sessionToken);
    }
    return Promise.resolve({ accessKeyId, secretAccessKey, sessionToken });
  };
}

export function clientConfig(tier: Tier): S3ClientConfig {
  return {
    region: tier.region,
    endpoint: tier.endpoint || undefined,
    forcePathStyle: tier.forcePathStyle,
    maxAttempts: 3,
    requestHandler: {
      connectionTimeout: (tier.connectTimeoutSeconds ?? 10) * 1000,
      socketTimeout: 60000,
    },
    credentials: tier.role
      ? async () => {
          const sts = new STSClient({ region: tier.region, maxAttempts: 3 });
          try {
            const token = await core.getIDToken(tier.audience);
            const result = await sts.send(
              new AssumeRoleWithWebIdentityCommand({
                RoleArn: tier.role,
                RoleSessionName: `cache-${nonEmpty(process.env.GITHUB_RUN_ID) ?? "action"}-${nonEmpty(process.env.GITHUB_RUN_ATTEMPT) ?? "1"}`,
                WebIdentityToken: token,
                DurationSeconds: 3600,
              }),
            );
            const credentials = result.Credentials;
            const accessKeyId = nonEmpty(credentials?.AccessKeyId);
            const secretAccessKey = nonEmpty(credentials?.SecretAccessKey);
            const sessionToken = nonEmpty(credentials?.SessionToken);
            const expiration = credentials?.Expiration;
            if (
              accessKeyId === undefined ||
              secretAccessKey === undefined ||
              sessionToken === undefined ||
              expiration === undefined
            ) {
              throw new CacheError("STS returned incomplete credentials");
            }
            core.setSecret(accessKeyId);
            core.setSecret(secretAccessKey);
            core.setSecret(sessionToken);
            return { accessKeyId, secretAccessKey, sessionToken, expiration };
          } finally {
            sts.destroy();
          }
        }
      : tier.credentialsEnvPrefix
        ? environmentCredentials(tier.credentialsEnvPrefix)
        : undefined,
  };
}

export class S3Bucket implements Bucket {
  readonly client: S3Client;
  // Makes a tier's first request a single time, signed as the client is.
  private once: S3Client | undefined;
  constructor(
    readonly tier: Tier,
    readonly config: Config,
    client?: S3Client,
  ) {
    this.client = client ?? new S3Client(clientConfig(tier));
  }
  close(): void {
    this.client.destroy();
    this.once?.destroy();
  }
  async connect(key: string, signal: AbortSignal, once: boolean): Promise<Entry | undefined> {
    try {
      await this.client.config.credentials();
    } catch (error) {
      throw new Unavailable(`Sign-in failed (${describe(error)})`, error);
    }
    const client = once
      ? (this.once ??= new S3Client({
          ...clientConfig(this.tier),
          maxAttempts: 1,
          credentials: this.client.config.credentials,
        }))
      : this.client;
    try {
      return await this.head(key, signal, client);
    } catch (error) {
      throw (signal.aborted ? undefined : unanswered(error, "No connection")) ?? error;
    }
  }
  async head(key: string, signal: AbortSignal, client = this.client): Promise<Entry | undefined> {
    try {
      const result = await client.send(
        new HeadObjectCommand({ Bucket: this.tier.bucket, Key: key }),
        { abortSignal: signal },
      );
      return {
        key,
        size: result.ContentLength ?? 0,
        version: result.ETag ?? "",
        sha256: result.Metadata?.sha256 ?? "",
      };
    } catch (error) {
      if (status(error) === 404) {
        return undefined;
      }
      throw error;
    }
  }
  async list(prefix: string, token: string | undefined, signal: AbortSignal): Promise<Page> {
    const result = await this.client.send(
      new ListObjectsV2Command({
        Bucket: this.tier.bucket,
        Prefix: prefix,
        ContinuationToken: token,
      }),
      { abortSignal: signal },
    );
    const nextToken = nonEmpty(result.NextContinuationToken);
    if (result.IsTruncated === true && nextToken === undefined) {
      throw new CacheError("S3 returned an invalid pagination token");
    }
    const items: { key: string; modified: number }[] = [];
    for (const item of result.Contents ?? []) {
      const key = nonEmpty(item.Key);
      if (
        key !== undefined &&
        item.LastModified !== undefined &&
        item.Size !== undefined &&
        item.Size !== 0
      ) {
        items.push({ key, modified: item.LastModified.getTime() });
      }
    }
    return { items, token: result.IsTruncated === true ? nextToken : undefined };
  }
  async read(entry: Entry, start: number, end: number, signal: AbortSignal): Promise<Range> {
    const result = await this.client.send(
      new GetObjectCommand({
        Bucket: this.tier.bucket,
        Key: entry.key,
        Range: `bytes=${start}-${end}`,
        IfMatch: entry.version,
      }),
      { abortSignal: signal },
    );
    if (!(result.Body instanceof Readable)) {
      throw new CacheError("S3 did not return a Node readable stream");
    }
    return {
      body: result.Body,
      contentRange: result.ContentRange ?? "",
      length: result.ContentLength ?? 0,
    };
  }
  async upload(
    key: string,
    source: string,
    bytes: number,
    sha256: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    const params = { Bucket: this.tier.bucket, Key: key };
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
        if (status(error) === 412) {
          return false;
        }
        throw error;
      } finally {
        body.destroy();
      }
    }

    const created = await this.client.send(
      new CreateMultipartUploadCommand({ ...params, Metadata: { sha256 } }),
      { abortSignal: signal },
    );
    const uploadId = nonEmpty(created.UploadId);
    if (uploadId === undefined) {
      throw new CacheError("S3 did not return a multipart upload ID");
    }
    const upload = { ...params, UploadId: uploadId };
    const cancel = new AbortController();
    const combined = AbortSignal.any([signal, cancel.signal]);
    const partSize = Math.max(this.config.partSize, Math.ceil(bytes / 10000));
    const count = Math.ceil(bytes / partSize);
    const parts: { readonly PartNumber: number; readonly ETag: string }[] = [];
    let next = 0;
    let completed = false;
    let failure: Error | undefined;
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
                const etag = nonEmpty(result.ETag);
                if (etag === undefined) {
                  throw new CacheError("S3 did not return a multipart ETag");
                }
                parts.push({ PartNumber: index + 1, ETag: etag });
                break;
              } catch (error) {
                if (combined.aborted || attempt === 2 || status(error) === 403) {
                  throw error;
                }
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
      if (failure?.status === "rejected") {
        throw failure.reason;
      }
      await this.client.send(
        new CompleteMultipartUploadCommand({
          ...upload,
          IfNoneMatch: "*",
          MultipartUpload: {
            Parts: parts.toSorted((a, b) => a.PartNumber - b.PartNumber),
          },
        }),
        { abortSignal: combined },
      );
      completed = true;
    } catch (error) {
      failure = toError(error);
    } finally {
      if (!completed) {
        // Cleanup has its own deadline: the transfer signal may already be
        // aborted. This also covers conditional completion conflicts.
        try {
          await this.client.send(new AbortMultipartUploadCommand(upload), {
            abortSignal: AbortSignal.timeout(30000),
          });
        } catch (error) {
          if (status(error) !== 404) {
            failure =
              failure === undefined
                ? toError(error)
                : new AggregateError([failure, error], "Upload and cleanup failed");
          }
        }
      }
    }
    if (failure !== undefined) {
      if (status(failure) === 412) {
        return false;
      }
      throw failure;
    }
    return true;
  }
}
