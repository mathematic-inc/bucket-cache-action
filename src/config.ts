import { CacheError, ConfigurationError } from "./errors.js";
import * as core from "@actions/core";
import { createHash } from "node:crypto";
import { z } from "zod";
import { CompressionMethod } from "./archive.js";
import { readTiers, skippedSchema, tierSchema } from "./tiers.js";
export type { Tier } from "./tiers.js";

const key = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (value) =>
      !value.includes(",") &&
      !Array.from(value).some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      ) &&
      !value.startsWith("/") &&
      !value.split("/").some((part) => part === "." || part === ".."),
    "Keys must not contain control characters, commas, or traversal segments",
  );

export const configSchema = z.object({
  // The tiers this runner uses, hot first, and those it skips.
  tiers: z.array(tierSchema).max(10),
  skipped: z.array(skippedSchema).max(10),
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
});
export type Config = z.infer<typeof configSchema>;

export const snapshotSchema = z.object({
  config: configSchema,
  compression: z.enum(CompressionMethod),
  namespace: z.string().min(1),
  matchedKey: z.string(),
  // The tier the match came from, empty on a miss.
  matchedTier: z.string(),
});
export type Snapshot = z.infer<typeof snapshotSchema>;

export function booleanInput(value: string, fallback: boolean): boolean {
  if (!value) return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new CacheError("Boolean inputs must be true or false");
}

// The single-bucket inputs, which the tiers input replaces, with the defaults
// action.yml gives them: a wrapper that passes those on hasn't given them.
const bucketInputs: Record<string, string> = {
  provider: "s3",
  bucket: "",
  region: "",
  endpoint: "",
  "force-path-style": "false",
  "role-to-assume": "",
  audience: "sts.amazonaws.com",
  "credentials-env-prefix": "",
  "connect-timeout-seconds": "",
  "credentials-file": "",
  "workload-identity-provider": "",
  "service-account": "",
  anonymous: "false",
};

// The single-bucket inputs as one tier, read as they always were.
function singleTier(input: (name: string) => string, env: NodeJS.ProcessEnv) {
  const provider = input("provider") || "s3";
  return {
    name: "default",
    save: true,
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
    credentialsEnvPrefix: input("credentials-env-prefix"),
    audience: input("audience") || "sts.amazonaws.com",
    connectTimeoutSeconds: input("connect-timeout-seconds")
      ? Number(input("connect-timeout-seconds"))
      : undefined,
  };
}

export function readConfig(input = core.getInput, env = process.env): Config {
  const lines = (name: string) =>
    input(name)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  const number = (name: string, fallback: number) => (input(name) ? Number(input(name)) : fallback);
  let storage: { tiers: unknown[]; skipped: unknown[] };
  if (input("tiers")) {
    const given = Object.entries(bucketInputs)
      .filter(([name, fallback]) => input(name) && input(name) !== fallback)
      .map(([name]) => name);
    if (given.length)
      throw new ConfigurationError(
        `Give tiers or the single-bucket inputs, not both; remove ${given.join(", ")}`,
      );
    storage = readTiers(input("tiers"), env);
  } else storage = { tiers: [singleTier(input, env)], skipped: [] };
  return configSchema.parse({
    ...storage,
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
      JSON.stringify(["mathematic-bucket-cache-v3", config.paths, compression, platform, arch]),
    )
    .digest("hex");
  const prefix = `${config.prefix.replace(/\/+$/, "")}/${config.repository}/${version}/`;
  if (Buffer.byteLength(prefix + config.key) > 1024)
    throw new CacheError("Bucket object key exceeds 1024 bytes");
  return prefix;
}
