import { describe, expect, it } from "vitest";
import { readConfig } from "../src/config.js";
import { ConfigurationError } from "../src/errors.js";

const lan = `- name: lan
  bucket-env: RR_S3_BUCKET
  region-env: RR_S3_REGION
  endpoint-env: RR_S3_ENDPOINT
  force-path-style: true
  credentials-env-prefix: RR_S3
  connect-timeout-seconds: 2
`;
const aws = `- name: aws
  bucket: my-ci-cache
  region: us-east-1
  role-to-assume: arn:aws:iam::123456789012:role/ci-cache
`;
const fleet = {
  RR_S3_BUCKET: "office-cache",
  RR_S3_REGION: "us-east-1",
  RR_S3_ENDPOINT: "http://10.0.0.5:9000",
  RR_S3_ACCESS_KEY_ID: "office-access",
  RR_S3_SECRET_ACCESS_KEY: "office-secret",
};

function config(
  tiers: string,
  env: NodeJS.ProcessEnv = fleet,
  inputs: Record<string, string> = {},
) {
  const values: Record<string, string> = { path: "cache", key: "key", tiers, ...inputs };
  return readConfig((name) => values[name] || "", { GITHUB_REPOSITORY: "owner/repo", ...env });
}
function problems(tiers: string, env: NodeJS.ProcessEnv = fleet): string {
  try {
    config(tiers, env);
  } catch (error) {
    if (error instanceof ConfigurationError) return error.message;
    throw error;
  }
  throw new Error("The tiers were accepted");
}

describe("tiers input", () => {
  it("reads each tier in order, its values from the list or the runner's environment", () => {
    const { tiers, skipped } = config(lan + aws);
    expect(skipped).toEqual([]);
    expect(tiers).toEqual([
      {
        name: "lan",
        save: true,
        provider: "s3",
        bucket: "office-cache",
        region: "us-east-1",
        endpoint: "http://10.0.0.5:9000",
        forcePathStyle: true,
        role: "",
        credentialsEnvPrefix: "RR_S3",
        audience: "sts.amazonaws.com",
        connectTimeoutSeconds: 2,
        credentialsFile: "",
        workloadIdentityProvider: "",
        serviceAccount: "",
        anonymous: false,
      },
      {
        name: "aws",
        save: true,
        provider: "s3",
        bucket: "my-ci-cache",
        region: "us-east-1",
        endpoint: "",
        forcePathStyle: false,
        role: "arn:aws:iam::123456789012:role/ci-cache",
        credentialsEnvPrefix: "",
        audience: "sts.amazonaws.com",
        connectTimeoutSeconds: undefined,
        credentialsFile: "",
        workloadIdentityProvider: "",
        serviceAccount: "",
        anonymous: false,
      },
    ]);
  });
  it("never keeps a credential's value, only its prefix", () => {
    expect(JSON.stringify(config(lan + aws))).not.toContain("office-secret");
  });
  it("takes GCS tiers, a read-only tier, a role's audience, and JSON", () => {
    const { tiers } = config(
      `${aws}  audience: sigstore
- name: google
  provider: gcs
  bucket: gcs-cache
  workload-identity-provider: projects/1/locations/global/workloadIdentityPools/github/providers/github
  service-account-env: GCS_SERVICE_ACCOUNT
  save: false
- {"name": "emulator", "provider": "gcs", "bucket": "local", "endpoint": "http://127.0.0.1:4443", "anonymous": true}
`,
      { GCS_SERVICE_ACCOUNT: "cache@project.iam.gserviceaccount.com" },
    );
    expect(tiers.map(({ name, provider, save }) => [name, provider, save])).toEqual([
      ["aws", "s3", true],
      ["google", "gcs", false],
      ["emulator", "gcs", true],
    ]);
    expect(tiers[0]!.audience).toBe("sigstore");
    expect(tiers[1]!.serviceAccount).toBe("cache@project.iam.gserviceaccount.com");
  });
  it("counts a tier absent when the runner doesn't set a value it names, saying which", () => {
    expect(config(lan + aws, {})).toMatchObject({
      tiers: [{ name: "aws" }],
      skipped: [
        {
          name: "lan",
          reason:
            "RR_S3_BUCKET, RR_S3_REGION, RR_S3_ENDPOINT, RR_S3_ACCESS_KEY_ID and RR_S3_SECRET_ACCESS_KEY are not set",
          malformed: false,
        },
      ],
    });
    expect(config(lan, { ...fleet, RR_S3_SECRET_ACCESS_KEY: "" }).skipped).toEqual([
      { name: "lan", reason: "RR_S3_SECRET_ACCESS_KEY is not set", malformed: false },
    ]);
  });
  it("leaves a check on a value the environment hasn't given until it does", () => {
    const google = `- name: google
  provider: gcs
  bucket: gcs-cache
  workload-identity-provider-env: GCS_PROVIDER
  service-account: cache@project.iam.gserviceaccount.com
`;
    expect(config(google, {}).skipped).toEqual([
      { name: "google", reason: "GCS_PROVIDER is not set", malformed: false },
    ]);
    expect(config(google, { GCS_PROVIDER: "projects/x" }).skipped).toEqual([
      {
        name: "google",
        reason:
          "GCS_PROVIDER doesn't hold a valid workload-identity-provider: Invalid GCS workload identity provider",
        malformed: true,
      },
    ]);
  });
  it("skips a tier whose variable holds a malformed value, naming the variable but not its value", () => {
    const read = config(lan + aws, { ...fleet, RR_S3_ENDPOINT: "https://user:hunter2@s3.example" });
    expect(read.tiers.map(({ name }) => name)).toEqual(["aws"]);
    expect(read.skipped).toEqual([
      {
        name: "lan",
        reason:
          "RR_S3_ENDPOINT doesn't hold a valid endpoint: Endpoint must be an HTTP(S) URL without credentials, query, or fragment",
        malformed: true,
      },
    ]);
    expect(JSON.stringify(read)).not.toContain("hunter2");
    expect(config(lan, { ...fleet, RR_S3_BUCKET: "Not_A_Bucket" }).skipped[0]!.reason).toBe(
      "RR_S3_BUCKET doesn't hold a valid bucket: Invalid bucket name for the selected provider",
    );
  });
  it("keeps a malformed value written in the workflow a configuration error", () => {
    expect(
      problems(
        lan.replace("endpoint-env: RR_S3_ENDPOINT", "endpoint: https://user:hunter2@s3.example"),
      ),
    ).toBe(
      "Tier 1 (lan): endpoint: Endpoint must be an HTTP(S) URL without credentials, query, or fragment",
    );
  });
  it("checks what the list itself gives on runners where a tier is absent", () => {
    expect(
      problems(lan.replace("connect-timeout-seconds: 2", "connect-timeout-seconds: 0"), {}),
    ).toBe("Tier 1 (lan): connect-timeout-seconds: Too small: expected number to be >=1");
  });
  it.each([
    ["tiers: [", "tiers is not valid YAML"],
    ["- name: a\n  name: b\n", "tiers is not valid YAML (DUPLICATE_KEY at line 2, column 3)"],
    ["name: aws\n", "tiers must be a YAML list of 1 to 10 tiers"],
    ["[]", "tiers must be a YAML list of 1 to 10 tiers"],
    [aws.repeat(11), "tiers must be a YAML list of 1 to 10 tiers"],
    ["- lan\n", "Tier 1: Invalid input: expected object, received string"],
    [`${aws}  buckets: other\n`, 'Tier 1 (aws): Unrecognized key: "buckets"'],
    [
      aws.replace("name: aws", "region-eu: x"),
      "Tier 1: name: Invalid input: expected string, received undefined",
    ],
    [
      aws.replace("name: aws", "name: -aws"),
      "Tier 1: name: Tier names are at most 64 letters, digits, '.', '_' and '-'",
    ],
    [aws + aws, "Tier 2 (aws): name is the same as tier 1's"],
    [`${aws}  bucket-env: RR_S3_BUCKET\n`, "Tier 1 (aws): Give bucket or bucket-env, not both"],
    [aws.replace("  bucket: my-ci-cache\n", ""), "Tier 1 (aws): bucket or bucket-env is required"],
    [aws.replace("  region: us-east-1\n", ""), "Tier 1 (aws): region or region-env is required"],
    [
      aws.replace("  role-to-assume: arn:aws:iam::123456789012:role/ci-cache\n", ""),
      "Tier 1 (aws): role-to-assume, role-to-assume-env or credentials-env-prefix is required",
    ],
    [
      `${aws}  credentials-env-prefix: RR_S3\n`,
      "Tier 1 (aws): Select role-to-assume or credentials-env-prefix, not both",
    ],
    [`${lan}  audience: sts.amazonaws.com\n`, "Tier 1 (lan): audience is for role-to-assume only"],
    [`${aws}  anonymous: false\n`, "Tier 1 (aws): anonymous is for GCS tiers only"],
    [
      "- name: g\n  provider: gcs\n  bucket: gcs-cache\n  anonymous: true\n  endpoint: http://127.0.0.1:1\n  region-env: R\n",
      "Tier 1 (g): region-env is for S3 tiers only",
    ],
    [
      "- name: g\n  provider: gcs\n  bucket: gcs-cache\n",
      "Tier 1 (g): Select one of workload-identity-provider, credentials-file or anonymous: true",
    ],
    [
      "- name: g\n  provider: gcs\n  bucket: gcs-cache\n  credentials-file: /adc.json\n  service-account: a@b.iam.gserviceaccount.com\n",
      "Tier 1 (g): service-account requires workload-identity-provider",
    ],
    [
      `${aws}  save: "false"\n`,
      "Tier 1 (aws): save: Invalid input: expected boolean, received string",
    ],
    [
      `${aws}  provider: azure\n`,
      'Tier 1 (aws): provider: Invalid option: expected one of "s3"|"gcs"',
    ],
    [
      lan.replace("RR_S3_BUCKET", "RR-S3-BUCKET"),
      "Tier 1 (lan): bucket-env: Must be an environment variable's name",
    ],
    [
      aws.replace("my-ci-cache", "My_Cache"),
      "Tier 1 (aws): bucket: Invalid bucket name for the selected provider",
    ],
    [
      aws.replace("arn:aws:iam::123456789012:role/ci-cache", "ci-cache"),
      "Tier 1 (aws): role-to-assume: Must be an IAM role ARN",
    ],
  ])("refuses %j", (tiers, expected) => {
    expect(problems(tiers)).toContain(expected);
  });
  it("reports every tier's problems at once, never echoing YAML it couldn't read", () => {
    expect(
      problems(aws.replace("us-east-1", "") + lan.replace("true", '"true"')).split("\n"),
    ).toEqual([
      "Tier 1 (aws): region: Invalid input: expected string, received null",
      "Tier 2 (lan): force-path-style: Invalid input: expected boolean, received string",
    ]);
    expect(problems("- name: aws\n  bucket: 'secret-value\n")).not.toContain("secret-value");
  });
  it("refuses the single-bucket inputs beside tiers, but not their defaults", () => {
    expect(() => config(aws, fleet, { bucket: "other", endpoint: "http://x" })).toThrow(
      "Give tiers or the single-bucket inputs, not both; remove bucket, endpoint",
    );
    expect(
      config(aws, fleet, {
        provider: "s3",
        audience: "sts.amazonaws.com",
        "force-path-style": "false",
        anonymous: "false",
      }).tiers,
    ).toHaveLength(1);
  });
  it("keeps the single-bucket inputs as one tier named default", () => {
    const values: Record<string, string> = {
      bucket: "test-cache",
      region: "us-east-1",
      path: "cache",
      key: "key",
    };
    const single = readConfig((name) => values[name] || "", { GITHUB_REPOSITORY: "owner/repo" });
    expect(single.tiers).toMatchObject([{ name: "default", save: true, bucket: "test-cache" }]);
    expect(single.skipped).toEqual([]);
  });
});
