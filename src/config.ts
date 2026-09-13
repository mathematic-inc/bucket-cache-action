import { CacheError } from "./errors.js";
import * as core from "@actions/core";
import { createHash } from "node:crypto";
import { z } from "zod";
import { CompressionMethod } from "@actions/cache/lib/internal/constants.js";

const key = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (value) =>
      !/[\x00-\x1f\x7f,]/.test(value) &&
      !value.startsWith("/") &&
      !value.split("/").some((part) => part === "." || part === ".."),
    "Keys must not contain control characters, commas, or traversal segments",
  );

export const configSchema = z
  .object({
    provider: z.enum(["s3", "gcs"]),
    credentialsFile: z.string(),
    workloadIdentityProvider: z.string(),
    serviceAccount: z.string(),
    anonymous: z.boolean(),
    bucket: z.string().min(3).max(222),
    region: z.string(),
    endpoint: z.string().refine((value) => {
      if (!value) return true;
      try {
        const url = new URL(value);
        return (
          ["http:", "https:"].includes(url.protocol) &&
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash
        );
      } catch {
        return false;
      }
    }, "Endpoint must be an HTTP(S) URL without credentials, query, or fragment"),
    forcePathStyle: z.boolean(),
    role: z
      .string()
      .refine(
        (value) =>
          !value ||
          /^arn:aws(?:-[a-z0-9-]+)?:iam::\d{12}:role\/.+$/.test(value),
      ),
    audience: z.string().min(1),
    paths: z.array(z.string().min(1)).min(1),
    key,
    restoreKeys: z.array(key).max(10),
    prefix: key,
    repository: z.string().regex(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/),
    lookupOnly: z.boolean(),
    failOnMiss: z.boolean(),
    failOnError: z.boolean(),
    timeoutSeconds: z.number().int().min(1).max(14400),
    concurrency: z.number().int().min(1).max(32),
    partSize: z
      .number()
      .int()
      .min(5 * 1024 * 1024)
      .max(512 * 1024 * 1024),
    maxSize: z
      .number()
      .int()
      .positive()
      .max(5 * 1024 ** 4),
  })
  .superRefine((config, ctx) => {
    const validBucket =
      config.provider === "s3"
        ? /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(config.bucket)
        : /^[a-z0-9][a-z0-9._-]+[a-z0-9]$/.test(config.bucket) &&
          config.bucket.split(".").every((part) => part.length <= 63);
    if (!validBucket)
      ctx.addIssue({
        code: "custom",
        path: ["bucket"],
        message: "Invalid bucket name for the selected provider",
      });
    if (config.provider === "s3" && !config.region)
      ctx.addIssue({
        code: "custom",
        path: ["region"],
        message: "S3 requires a region",
      });
    if (config.provider === "gcs" && (config.role || config.forcePathStyle))
      ctx.addIssue({
        code: "custom",
        message: "S3 authentication/addressing options cannot be used with GCS",
      });
    if (
      config.provider === "s3" &&
      (config.credentialsFile ||
        config.workloadIdentityProvider ||
        config.serviceAccount ||
        config.anonymous)
    )
      ctx.addIssue({
        code: "custom",
        message: "GCS authentication options cannot be used with S3",
      });
    if (
      config.workloadIdentityProvider &&
      !/^projects\/\d+\/locations\/global\/workloadIdentityPools\/[a-zA-Z0-9_-]+\/providers\/[a-zA-Z0-9_-]+$/.test(
        config.workloadIdentityProvider,
      )
    )
      ctx.addIssue({
        code: "custom",
        path: ["workloadIdentityProvider"],
        message: "Invalid GCS workload identity provider",
      });
    if (
      config.serviceAccount &&
      (!config.workloadIdentityProvider ||
        !/^[a-zA-Z0-9_.-]+@[a-zA-Z0-9-]+\.iam\.gserviceaccount\.com$/.test(
          config.serviceAccount,
        ))
    )
      ctx.addIssue({
        code: "custom",
        path: ["serviceAccount"],
        message: "A GCS service account requires a workload identity provider",
      });
    if (config.workloadIdentityProvider && config.credentialsFile)
      ctx.addIssue({
        code: "custom",
        message:
          "Select workload identity or an ADC credentials file, not both",
      });
    if (config.anonymous) {
      try {
        const url = new URL(config.endpoint);
        if (
          !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
          config.credentialsFile ||
          config.workloadIdentityProvider
        )
          throw new Error();
      } catch {
        ctx.addIssue({
          code: "custom",
          path: ["anonymous"],
          message:
            "Anonymous GCS access requires a loopback emulator without credentials",
        });
      }
    }
  });
export type Config = z.infer<typeof configSchema>;

export const snapshotSchema = z.object({
  config: configSchema,
  compression: z.enum(CompressionMethod),
  namespace: z.string().min(1),
  matchedKey: z.string(),
});
export type Snapshot = z.infer<typeof snapshotSchema>;

export function booleanInput(value: string, fallback: boolean): boolean {
  if (!value) return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new CacheError("Boolean inputs must be true or false");
}

export function readConfig(input = core.getInput, env = process.env): Config {
  const lines = (name: string) =>
    input(name)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  const number = (name: string, fallback: number) =>
    input(name) ? Number(input(name)) : fallback;
  const provider = input("provider") || "s3";
  return configSchema.parse({
    provider,
    credentialsFile:
      input("credentials-file") ||
      (provider === "gcs" ? env.GOOGLE_APPLICATION_CREDENTIALS || "" : ""),
    workloadIdentityProvider: input("workload-identity-provider"),
    serviceAccount: input("service-account"),
    anonymous: booleanInput(input("anonymous"), false),
    bucket: input("bucket"),
    region: input("region") || env.AWS_REGION || env.AWS_DEFAULT_REGION || "",
    endpoint: input("endpoint"),
    forcePathStyle: booleanInput(input("force-path-style"), false),
    role: input("role-to-assume"),
    audience: input("audience") || "sts.amazonaws.com",
    paths: lines("path"),
    key: input("key"),
    restoreKeys: lines("restore-keys"),
    prefix: input("prefix") || "cache",
    repository: env.GITHUB_REPOSITORY || "",
    lookupOnly: booleanInput(input("lookup-only"), false),
    failOnMiss: booleanInput(input("fail-on-cache-miss"), false),
    failOnError: booleanInput(input("fail-on-error"), false),
    timeoutSeconds: number("timeout-seconds", 600),
    concurrency: number("concurrency", 4),
    partSize: number("part-size-mib", 32) * 1024 ** 2,
    maxSize: number("max-size-mib", 102400) * 1024 ** 2,
  });
}

// The repository/version/key layout is derived from runs-on/cache. A separate
// format version intentionally prevents restoring its older, unchecked archives.
export function namespace(
  config: Config,
  compression: CompressionMethod,
  platform = process.platform,
  arch = process.arch,
): string {
  const version = createHash("sha256")
    .update(
      JSON.stringify([
        "mathematic-bucket-cache-v1",
        config.paths,
        compression,
        platform,
        arch,
      ]),
    )
    .digest("hex");
  const prefix = `${config.prefix.replace(/\/+$/, "")}/${config.repository}/${version}/`;
  if (Buffer.byteLength(prefix + config.key) > 1024)
    throw new CacheError("Bucket object key exceeds 1024 bytes");
  return prefix;
}
