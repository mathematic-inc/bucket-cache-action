import { afterEach, expect, it, vi } from "vitest";
import * as core from "@actions/core";
import { STSClient, AssumeRoleWithWebIdentityCommand } from "@aws-sdk/client-sts";
import { S3Bucket, clientConfig } from "../src/storage/s3.js";
import { readConfig } from "../src/config.js";
vi.mock("@actions/core", () => ({
  setSecret: vi.fn(),
  getIDToken: vi.fn(async () => "test-oidc-token"),
}));
function config(role = "", inputs: Record<string, string> = {}) {
  const values: Record<string, string> = {
    provider: "s3",
    bucket: "test-cache",
    region: "us-east-1",
    path: "cache",
    key: "key",
    "role-to-assume": role,
    ...inputs,
  };
  return readConfig((name) => values[name] || "", {
    GITHUB_REPOSITORY: "owner/repo",
  });
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});
it("uses the native AWS credential chain without mutating its environment", async () => {
  vi.stubEnv("AWS_ACCESS_KEY_ID", "cache-test-access");
  vi.stubEnv("AWS_SECRET_ACCESS_KEY", "cache-test-secret");
  vi.stubEnv("AWS_SESSION_TOKEN", "cache-test-session");
  vi.stubEnv("AWS_PROFILE", "");
  const bucket = new S3Bucket(config());
  try {
    const credentials = await bucket.client.config.credentials();
    expect(credentials.accessKeyId).toBe("cache-test-access");
    expect(credentials.secretAccessKey).toBe("cache-test-secret");
    expect(credentials.sessionToken).toBe("cache-test-session");
    expect(process.env.AWS_ACCESS_KEY_ID).toBe("cache-test-access");
    expect(core.getIDToken).not.toHaveBeenCalled();
  } finally {
    bucket.close();
  }
});
it("uses AWS STS with a fresh GitHub identity for each phase instead of inherited deployment credentials", async () => {
  vi.stubEnv("AWS_ACCESS_KEY_ID", "deployment-access");
  vi.stubEnv("AWS_SECRET_ACCESS_KEY", "deployment-secret");
  const role = "arn:aws:iam::123456789012:role/cache";
  const send = vi.spyOn(STSClient.prototype, "send").mockImplementation(async (command) => {
    expect(command).toBeInstanceOf(AssumeRoleWithWebIdentityCommand);
    expect(command.input).toMatchObject({
      RoleArn: role,
      WebIdentityToken: "test-oidc-token",
      DurationSeconds: 3600,
    });
    return {
      Credentials: {
        AccessKeyId: "cache-access",
        SecretAccessKey: "cache-secret",
        SessionToken: "cache-session",
        Expiration: new Date(Date.now() + 3600000),
      },
    };
  });
  for (let phase = 0; phase < 2; phase++) {
    const bucket = new S3Bucket(config(role));
    try {
      expect((await bucket.client.config.credentials()).accessKeyId).toBe("cache-access");
    } finally {
      bucket.close();
    }
  }
  expect(send).toHaveBeenCalledTimes(2);
  expect(core.getIDToken).toHaveBeenCalledWith("sts.amazonaws.com");
  expect(core.setSecret).toHaveBeenCalledWith("cache-session");
});
it("signs with static credentials from an environment prefix in place of AWS's", async () => {
  vi.stubEnv("AWS_ACCESS_KEY_ID", "deployment-access");
  vi.stubEnv("AWS_SECRET_ACCESS_KEY", "deployment-secret");
  vi.stubEnv("RUNNER_S3_ACCESS_KEY_ID", "runner-access");
  vi.stubEnv("RUNNER_S3_SECRET_ACCESS_KEY", "runner-secret");
  vi.stubEnv("RUNNER_S3_SESSION_TOKEN", "runner-session");
  for (let phase = 0; phase < 2; phase++) {
    const bucket = new S3Bucket(config("", { "credentials-env-prefix": "RUNNER_S3" }));
    try {
      expect(await bucket.client.config.credentials()).toMatchObject({
        accessKeyId: "runner-access",
        secretAccessKey: "runner-secret",
        sessionToken: "runner-session",
      });
    } finally {
      bucket.close();
    }
  }
  expect(core.getIDToken).not.toHaveBeenCalled();
  expect(core.setSecret).toHaveBeenCalledWith("runner-access");
  expect(core.setSecret).toHaveBeenCalledWith("runner-secret");
  expect(core.setSecret).toHaveBeenCalledWith("runner-session");
});
it("refuses incomplete prefixed credentials instead of signing with AWS's", async () => {
  vi.stubEnv("AWS_ACCESS_KEY_ID", "deployment-access");
  vi.stubEnv("AWS_SECRET_ACCESS_KEY", "deployment-secret");
  vi.stubEnv("RUNNER_S3_ACCESS_KEY_ID", "runner-access");
  vi.stubEnv("RUNNER_S3_SECRET_ACCESS_KEY", "");
  const bucket = new S3Bucket(config("", { "credentials-env-prefix": "RUNNER_S3" }));
  try {
    await expect(bucket.client.config.credentials()).rejects.toThrow(
      "RUNNER_S3_ACCESS_KEY_ID and RUNNER_S3_SECRET_ACCESS_KEY must both be set",
    );
  } finally {
    bucket.close();
  }
});
it("gives each connection to the bucket the configured deadline", () => {
  expect(clientConfig(config()).requestHandler).toEqual({
    connectionTimeout: 10000,
    socketTimeout: 60000,
  });
  expect(clientConfig(config("", { "connect-timeout-seconds": "5" })).requestHandler).toEqual({
    connectionTimeout: 5000,
    socketTimeout: 60000,
  });
});
