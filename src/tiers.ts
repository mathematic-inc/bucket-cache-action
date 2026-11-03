import { LineCounter, parseDocument } from "yaml";
import { z } from "zod";
import { ConfigurationError } from "./errors.js";

const endpoint = z.string().refine((value) => {
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
}, "Endpoint must be an HTTP(S) URL without credentials, query, or fragment");

// One bucket the cache is kept in, and how to reach it. The single-bucket
// inputs are one tier named "default"; the tiers input lists several, hot first.
export const tierSchema = z
  .object({
    name: z
      .string()
      .regex(
        /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/,
        "Tier names are at most 64 letters, digits, '.', '_' and '-'",
      ),
    save: z.boolean(),
    provider: z.enum(["s3", "gcs"]),
    credentialsFile: z.string(),
    workloadIdentityProvider: z.string(),
    serviceAccount: z.string(),
    anonymous: z.boolean(),
    bucket: z.string().min(3).max(222),
    region: z.string(),
    endpoint,
    forcePathStyle: z.boolean(),
    role: z
      .string()
      .refine(
        (value) => !value || /^arn:aws(?:-[a-z0-9-]+)?:iam::\d{12}:role\/.+$/.test(value),
        "Must be an IAM role ARN",
      ),
    credentialsEnvPrefix: z
      .string()
      .regex(/^(?:[A-Za-z_][A-Za-z0-9_]*)?$/, "Must be an environment variable prefix"),
    audience: z.string().min(1),
    connectTimeoutSeconds: z.number().int().min(1).max(300).optional(),
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
    if (
      config.provider === "gcs" &&
      (config.role ||
        config.forcePathStyle ||
        config.credentialsEnvPrefix ||
        config.connectTimeoutSeconds !== undefined)
    )
      ctx.addIssue({
        code: "custom",
        message: "S3 authentication/addressing options cannot be used with GCS",
      });
    if (config.role && config.credentialsEnvPrefix)
      ctx.addIssue({
        code: "custom",
        message: "Select role-to-assume or credentials-env-prefix, not both",
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
        !/^[a-zA-Z0-9_.-]+@[a-zA-Z0-9-]+\.iam\.gserviceaccount\.com$/.test(config.serviceAccount))
    )
      ctx.addIssue({
        code: "custom",
        path: ["serviceAccount"],
        message: "A GCS service account requires a workload identity provider",
      });
    if (config.workloadIdentityProvider && config.credentialsFile)
      ctx.addIssue({
        code: "custom",
        message: "Select workload identity or an ADC credentials file, not both",
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
          message: "Anonymous GCS access requires a loopback emulator without credentials",
        });
      }
    }
  });
export type Tier = z.infer<typeof tierSchema>;

// A tier this runner skips: one it doesn't give every value it needs, as a runner
// outside the fleet whose cache it names, or one whose environment holds a
// malformed value, which a step warns of.
export const skippedSchema = z.object({
  name: z.string(),
  reason: z.string(),
  malformed: z.boolean(),
});
export type Skipped = z.infer<typeof skippedSchema>;

const variable = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "Must be an environment variable's name");
const entrySchema = z.strictObject({
  name: z.string(),
  provider: z.enum(["s3", "gcs"]).optional(),
  bucket: z.string().optional(),
  "bucket-env": variable.optional(),
  region: z.string().optional(),
  "region-env": variable.optional(),
  endpoint: z.string().optional(),
  "endpoint-env": variable.optional(),
  "force-path-style": z.boolean().optional(),
  "role-to-assume": z.string().optional(),
  "role-to-assume-env": variable.optional(),
  audience: z.string().optional(),
  "credentials-env-prefix": z.string().optional(),
  "connect-timeout-seconds": z.number().optional(),
  "credentials-file": z.string().optional(),
  "credentials-file-env": variable.optional(),
  "workload-identity-provider": z.string().optional(),
  "workload-identity-provider-env": variable.optional(),
  "service-account": z.string().optional(),
  "service-account-env": variable.optional(),
  anonymous: z.boolean().optional(),
  save: z.boolean().optional(),
});
type Entry = z.infer<typeof entrySchema>;

// The values a tier may name the runner's environment variable for instead,
// since a fleet sets them on its runners, outside the workflow's env context.
const environmentKeys = {
  bucket: "bucket",
  region: "region",
  endpoint: "endpoint",
  "role-to-assume": "role",
  "credentials-file": "credentialsFile",
  "workload-identity-provider": "workloadIdentityProvider",
  "service-account": "serviceAccount",
} as const;
type EnvironmentKey = keyof typeof environmentKeys;

// The tier keys only one provider takes.
const providerKeys: Record<string, Tier["provider"]> = {
  region: "s3",
  "force-path-style": "s3",
  "role-to-assume": "s3",
  audience: "s3",
  "credentials-env-prefix": "s3",
  "connect-timeout-seconds": "s3",
  "credentials-file": "gcs",
  "workload-identity-provider": "gcs",
  "service-account": "gcs",
  anonymous: "gcs",
};

// Each Tier field's key in the list, for errors.
const fieldKeys: Record<string, string> = {
  credentialsFile: "credentials-file",
  workloadIdentityProvider: "workload-identity-provider",
  serviceAccount: "service-account",
  forcePathStyle: "force-path-style",
  role: "role-to-assume",
  credentialsEnvPrefix: "credentials-env-prefix",
  connectTimeoutSeconds: "connect-timeout-seconds",
};

// Checks that hold on other fields: an absent tier leaves them unchecked too.
const dependsOn: Record<string, string[]> = {
  serviceAccount: ["workloadIdentityProvider"],
  anonymous: ["endpoint", "credentialsFile", "workloadIdentityProvider"],
};

function and(names: string[]): string {
  return names.length < 3
    ? names.join(" and ")
    : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

// The rules on which keys a tier gives, before any value is read from the
// environment, so they hold on every runner, in the fleet or not.
function keyProblems(entry: Entry): string[] {
  const provider = entry.provider ?? "s3";
  const has = (key: EnvironmentKey) =>
    entry[key] !== undefined || entry[`${key}-env`] !== undefined;
  const problems: string[] = [];
  for (const key of Object.keys(entry)) {
    const owner = providerKeys[key.replace(/-env$/, "")];
    if (owner && owner !== provider)
      problems.push(`${key} is for ${owner === "s3" ? "S3" : "GCS"} tiers only`);
  }
  for (const key of Object.keys(environmentKeys) as EnvironmentKey[])
    if (entry[key] !== undefined && entry[`${key}-env`] !== undefined)
      problems.push(`Give ${key} or ${key}-env, not both`);
  if (!has("bucket")) problems.push("bucket or bucket-env is required");
  if (provider === "s3") {
    if (!has("region")) problems.push("region or region-env is required");
    const signIn = [has("role-to-assume"), entry["credentials-env-prefix"] !== undefined];
    if (!signIn.some(Boolean))
      problems.push("role-to-assume, role-to-assume-env or credentials-env-prefix is required");
    if (signIn.every(Boolean))
      problems.push("Select role-to-assume or credentials-env-prefix, not both");
    if (entry.audience !== undefined && !has("role-to-assume"))
      problems.push("audience is for role-to-assume only");
  } else {
    const signIn = [has("workload-identity-provider"), has("credentials-file"), entry.anonymous];
    if (signIn.filter(Boolean).length !== 1)
      problems.push(
        "Select one of workload-identity-provider, credentials-file or anonymous: true",
      );
    if (has("service-account") && !has("workload-identity-provider"))
      problems.push("service-account requires workload-identity-provider");
  }
  return problems;
}

// One tier of the list, with the values it takes from the environment read. A
// value that isn't set, or that breaks the rules a value written in the list
// keeps, skips the tier: the runner's environment is no mistake of the workflow's.
function readEntry(
  entry: Entry,
  env: NodeJS.ProcessEnv,
): { tier?: Tier; problems: string[]; skipped?: Omit<Skipped, "name"> } {
  const missing: string[] = [];
  const unread = new Set<string>();
  const sources = new Map<string, string>();
  const value = (key: EnvironmentKey) => {
    const name = entry[`${key}-env`];
    if (name === undefined) return entry[key] ?? "";
    sources.set(environmentKeys[key], name);
    const found = env[name];
    if (found) return found;
    missing.push(name);
    unread.add(environmentKeys[key]);
    return "";
  };
  const tier = {
    name: entry.name,
    save: entry.save ?? true,
    provider: entry.provider ?? "s3",
    credentialsFile: value("credentials-file"),
    workloadIdentityProvider: value("workload-identity-provider"),
    serviceAccount: value("service-account"),
    anonymous: entry.anonymous ?? false,
    bucket: value("bucket"),
    region: value("region"),
    endpoint: value("endpoint"),
    forcePathStyle: entry["force-path-style"] ?? false,
    role: value("role-to-assume"),
    credentialsEnvPrefix: entry["credentials-env-prefix"] ?? "",
    audience: entry.audience ?? "sts.amazonaws.com",
    connectTimeoutSeconds: entry["connect-timeout-seconds"],
  };
  // Credentials are read again in each phase, but a tier without them here
  // isn't present, as one without its bucket isn't.
  const prefix = tier.credentialsEnvPrefix;
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(prefix))
    for (const name of [`${prefix}_ACCESS_KEY_ID`, `${prefix}_SECRET_ACCESS_KEY`])
      if (!env[name]) missing.push(name);
  const parsed = tierSchema.safeParse(tier);
  const problems: string[] = [];
  const malformed: string[] = [];
  for (const issue of parsed.error?.issues ?? []) {
    const field = typeof issue.path[0] === "string" ? issue.path[0] : undefined;
    if (!field) problems.push(issue.message);
    else if ([field, ...(dependsOn[field] ?? [])].some((name) => unread.has(name))) continue;
    else if (sources.has(field))
      malformed.push(
        `${sources.get(field)} doesn't hold a valid ${fieldKeys[field] ?? field}: ${issue.message}`,
      );
    else problems.push(`${fieldKeys[field] ?? field}: ${issue.message}`);
  }
  if (missing.length)
    return {
      problems,
      skipped: {
        reason: `${and(missing)} ${missing.length > 1 ? "are" : "is"} not set`,
        malformed: false,
      },
    };
  if (malformed.length)
    return { problems, skipped: { reason: malformed.join("; "), malformed: true } };
  return { tier: parsed.data, problems };
}

/** Reads the tiers input: an ordered YAML list of buckets, hot first. */
export function readTiers(
  text: string,
  env: NodeJS.ProcessEnv,
): { tiers: Tier[]; skipped: Skipped[] } {
  // Errors give a position and a code, never the excerpt prettyErrors would quote.
  const lines = new LineCounter();
  const document = parseDocument(text, {
    prettyErrors: false,
    uniqueKeys: true,
    lineCounter: lines,
  });
  const syntax = [...document.errors, ...document.warnings][0];
  if (syntax) {
    const { line, col } = lines.linePos(syntax.pos[0]);
    throw new ConfigurationError(
      `tiers is not valid YAML (${syntax.code} at line ${line}, column ${col})`,
    );
  }
  let list: unknown;
  try {
    list = document.toJS();
  } catch {
    throw new ConfigurationError("tiers is not valid YAML (its aliases expand too far)");
  }
  if (!Array.isArray(list) || list.length < 1 || list.length > 10)
    throw new ConfigurationError("tiers must be a YAML list of 1 to 10 tiers");
  const tiers: Tier[] = [];
  const skipped: Skipped[] = [];
  const problems: string[] = [];
  const names = new Map<string, number>();
  list.forEach((value: unknown, index) => {
    const raw =
      value && typeof value === "object" && "name" in value && typeof value.name === "string"
        ? value.name
        : undefined;
    const label = `Tier ${index + 1}${raw && tierSchema.shape.name.safeParse(raw).success ? ` (${raw})` : ""}`;
    const entry = entrySchema.safeParse(value);
    if (!entry.success) {
      for (const issue of entry.error.issues)
        problems.push(
          `${label}: ${issue.path.length ? `${issue.path.join(".")}: ` : ""}${issue.message}`,
        );
      return;
    }
    const first = names.get(entry.data.name);
    if (first !== undefined) problems.push(`${label}: name is the same as tier ${first + 1}'s`);
    else names.set(entry.data.name, index);
    const keys = keyProblems(entry.data);
    if (keys.length) {
      problems.push(...keys.map((problem) => `${label}: ${problem}`));
      return;
    }
    const read = readEntry(entry.data, env);
    problems.push(...read.problems.map((problem) => `${label}: ${problem}`));
    if (read.skipped) skipped.push({ name: entry.data.name, ...read.skipped });
    else if (read.tier) tiers.push(read.tier);
  });
  if (problems.length) throw new ConfigurationError(problems.join("\n"));
  return { tiers, skipped };
}
