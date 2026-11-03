import { afterEach, expect, it, vi } from "vitest";
import * as core from "@actions/core";
import { STSClient, AssumeRoleWithWebIdentityCommand } from "@aws-sdk/client-sts";
import { S3Client } from "@aws-sdk/client-s3";
import { S3Bucket, clientConfig } from "../src/storage/s3.js";
import { readConfig, type Config } from "../src/config.js";
import { status, Unavailable } from "../src/errors.js";
import { createServer, type AddressInfo } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { once } from "node:events";
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
function bucketOf(config: Config) {
  return new S3Bucket(config.tiers[0]!, config);
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
  const bucket = bucketOf(config());
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
    const bucket = bucketOf(config(role));
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
    const bucket = bucketOf(config("", { "credentials-env-prefix": "RUNNER_S3" }));
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
  const bucket = bucketOf(config("", { "credentials-env-prefix": "RUNNER_S3" }));
  try {
    await expect(bucket.client.config.credentials()).rejects.toThrow(
      "RUNNER_S3_ACCESS_KEY_ID and RUNNER_S3_SECRET_ACCESS_KEY must both be set",
    );
  } finally {
    bucket.close();
  }
});
it("gives each connection to the bucket the configured deadline", () => {
  expect(clientConfig(config().tiers[0]!).requestHandler).toEqual({
    connectionTimeout: 10000,
    socketTimeout: 60000,
  });
  expect(
    clientConfig(config("", { "connect-timeout-seconds": "5" }).tiers[0]!).requestHandler,
  ).toEqual({
    connectionTimeout: 5000,
    socketTimeout: 60000,
  });
});

// A loopback port nothing listens on, and a server that refuses every request.
async function closedPort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
async function refusing(run: (endpoint: string) => Promise<void>) {
  const server = createHttpServer((_request, response) => {
    response.writeHead(403, { "Content-Type": "application/xml" });
    response.end("<Error><Code>AccessDenied</Code></Error>");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}
function prefixed(endpoint: string, connectTimeout = "1") {
  vi.stubEnv("RUNNER_S3_ACCESS_KEY_ID", "runner-access");
  vi.stubEnv("RUNNER_S3_SECRET_ACCESS_KEY", "runner-secret");
  return bucketOf(
    config("", {
      endpoint,
      "force-path-style": "true",
      "credentials-env-prefix": "RUNNER_S3",
      "connect-timeout-seconds": connectTimeout,
    }),
  );
}
it("calls a tier unavailable when it can't sign in, before any request", async () => {
  const bucket = prefixed(`http://127.0.0.1:${await closedPort()}`);
  vi.stubEnv("RUNNER_S3_SECRET_ACCESS_KEY", "");
  const send = vi.spyOn(S3Client.prototype, "send");
  try {
    const error = await bucket.connect("key", AbortSignal.timeout(5000), true).catch((e) => e);
    expect(error).toBeInstanceOf(Unavailable);
    expect(error.message).toBe(
      "Sign-in failed (RUNNER_S3_ACCESS_KEY_ID and RUNNER_S3_SECRET_ACCESS_KEY must both be set)",
    );
    expect(send).not.toHaveBeenCalled();
  } finally {
    bucket.close();
  }
});
it("makes a tier's first request once when another tier may answer, and calls no answer unavailable", async () => {
  // Windows refuses a closed loopback port only after retrying for about two seconds.
  const bucket = prefixed(`http://127.0.0.1:${await closedPort()}`, "10");
  const send = vi.spyOn(S3Client.prototype, "send");
  try {
    const error = await bucket.connect("key", AbortSignal.timeout(20000), true).catch((e) => e);
    expect(error).toBeInstanceOf(Unavailable);
    expect(error.message).toBe("No connection (ECONNREFUSED)");
    expect(send).toHaveBeenCalledTimes(1);
    expect(await (send.mock.contexts[0] as S3Client).config.maxAttempts()).toBe(1);
    send.mockRejectedValueOnce(Object.assign(new Error("refused"), { code: "ECONNREFUSED" }));
    await expect(bucket.connect("key", AbortSignal.timeout(20000), false)).rejects.toThrow(
      "No connection (ECONNREFUSED)",
    );
    expect(await (send.mock.contexts[1] as S3Client).config.maxAttempts()).toBe(3);
  } finally {
    bucket.close();
  }
}, 30000);
it("reports a tier that answers with a refusal, rather than passing it over", async () => {
  await refusing(async (endpoint) => {
    const bucket = prefixed(endpoint);
    try {
      const error = await bucket.connect("key", AbortSignal.timeout(5000), true).catch((e) => e);
      expect(error).not.toBeInstanceOf(Unavailable);
      expect(status(error)).toBe(403);
    } finally {
      bucket.close();
    }
  });
});
