import { describe, expect, it } from "vitest";
import { readConfig, namespace, booleanInput, snapshotSchema } from "../src/config.js";
import { CompressionMethod } from "../src/archive.js";
import { describe as describeError, CacheError } from "../src/errors.js";

function config(overrides: Record<string, string> = {}) {
  const values: Record<string, string> = {
    bucket: "test-cache-bucket",
    region: "us-east-1",
    path: "node_modules\n.cache",
    key: "pnpm/development/lock",
    ...overrides,
  };
  return readConfig((name) => values[name] || "", {
    GITHUB_REPOSITORY: "owner/repository",
  });
}

describe("cache configuration", () => {
  it("requires explicit S3 storage and never infers a RunsOn bucket", () => {
    expect(() => config({ bucket: "" })).toThrow();
    expect(() => config({ region: "" })).toThrow();
  });
  it("normalizes multiline paths without reordering exclusion patterns", () => {
    expect(config({ path: "  dist\r\n!dist/private\n\n.cache  " }).paths).toEqual([
      "dist",
      "!dist/private",
      ".cache",
    ]);
  });
  it.each([
    "",
    "/absolute",
    "../escape",
    "prefix/../escape",
    "bad,key",
    "bad\nkey",
    "x".repeat(513),
  ])("rejects invalid key %j", (key) => {
    expect(() => config({ key })).toThrow();
  });
  it.each(["0", "33", "NaN", "1.5"])("bounds concurrency %s", (concurrency) => {
    expect(() => config({ concurrency })).toThrow();
  });
  it.each(["0", "4", "513", "Infinity"])("bounds transfer parts %s", (value) => {
    expect(() => config({ "part-size-mib": value })).toThrow();
  });
  it("rejects endpoint credentials and query parameters", () => {
    expect(() => config({ endpoint: "https://user:secret@example.com" })).toThrow();
    expect(() => config({ endpoint: "https://example.com?token=secret" })).toThrow();
    expect(
      config({ endpoint: "http://127.0.0.1:9000", "force-path-style": "true" }).tiers[0]!
        .forcePathStyle,
    ).toBe(true);
  });
  it("takes static S3 credentials from an environment prefix, never with a role or GCS", () => {
    expect(config({ "credentials-env-prefix": "RUNNER_S3" }).tiers[0]!.credentialsEnvPrefix).toBe(
      "RUNNER_S3",
    );
    expect(config().tiers[0]!.credentialsEnvPrefix).toBe("");
    expect(() => config({ "credentials-env-prefix": "RUNNER-S3" })).toThrow();
    expect(() => config({ "credentials-env-prefix": "3RUNNER" })).toThrow();
    expect(() =>
      config({
        "credentials-env-prefix": "RUNNER_S3",
        "role-to-assume": "arn:aws:iam::123456789012:role/cache",
      }),
    ).toThrow();
    expect(config({ provider: "gcs", region: "" }).tiers[0]!.provider).toBe("gcs");
    expect(() =>
      config({ provider: "gcs", region: "", "credentials-env-prefix": "RUNNER_S3" }),
    ).toThrow();
  });
  it("defaults the connect timeout and bounds it, for S3 only", () => {
    expect(config().tiers[0]!.connectTimeoutSeconds).toBeUndefined();
    expect(config({ "connect-timeout-seconds": "5" }).tiers[0]!.connectTimeoutSeconds).toBe(5);
    expect(() => config({ provider: "gcs", region: "", "connect-timeout-seconds": "5" })).toThrow();
  });
  it.each(["0", "301", "1.5", "NaN"])("bounds the connect timeout %s", (value) => {
    expect(() => config({ "connect-timeout-seconds": value })).toThrow();
  });
  it("separates platforms, architectures, paths, and compression", () => {
    const c = config();
    const values = [
      namespace(c, CompressionMethod.Gzip, "linux", "x64"),
      namespace(c, CompressionMethod.Gzip, "darwin", "x64"),
      namespace(c, CompressionMethod.Gzip, "linux", "arm64"),
      namespace(c, CompressionMethod.Zstd, "linux", "x64"),
      namespace(config({ path: "other" }), CompressionMethod.Gzip, "linux", "x64"),
    ];
    expect(new Set(values).size).toBe(values.length);
    expect(values[0]).toMatch(/^cache\/owner\/repository\/[a-f0-9]{64}\/$/);
  });
  it("keeps the storage namespace stable across exact and fallback keys", () => {
    expect(namespace(config(), CompressionMethod.Gzip)).toBe(
      namespace(config({ key: "changed", "restore-keys": "older/" }), CompressionMethod.Gzip),
    );
  });
  it("rejects overlong S3 object paths even with valid individual inputs", () => {
    expect(() =>
      namespace(config({ key: "x".repeat(512), prefix: "y".repeat(512) }), CompressionMethod.Gzip),
    ).toThrow("1024");
  });
  it("rejects unknown boolean spellings", () => {
    expect(booleanInput("", true)).toBe(true);
    expect(booleanInput("false", true)).toBe(false);
    expect(() => booleanInput("yes", false)).toThrow();
  });
  it("validates stored nonsecret post-job configuration", () => {
    expect(() =>
      snapshotSchema.parse({
        config: config(),
        compression: "unsupported",
        namespace: "cache/",
        matchedKey: "",
      }),
    ).toThrow();
  });
  it("redacts arbitrary SDK exception messages", () => {
    const error = new Error("https://secret:password@bucket?token=secret");
    error.name = "AccessDenied";
    expect(describeError(error)).toBe("AccessDenied");
    expect(describeError(new CacheError("Cache digest does not match"))).toBe(
      "Cache digest does not match",
    );
  });
});
