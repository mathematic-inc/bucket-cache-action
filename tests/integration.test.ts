import { beforeAll, afterAll, describe, expect, it } from "vitest";
import {
  S3Client,
  CreateBucketCommand,
  ListObjectsV2Command,
  ListMultipartUploadsCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { Storage } from "../src/storage.js";
import { S3Bucket } from "../src/storage/s3.js";
import { GcsBucket } from "../src/storage/gcs.js";
import { createServer, type AddressInfo } from "node:net";
import { once } from "node:events";
import { readConfig, namespace } from "../src/config.js";
import { CompressionMethod } from "../src/archive.js";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  chmod,
  stat,
  symlink,
  readlink,
} from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import path from "node:path";

const container = `mathematic-cache-test-${randomUUID()}`;
const coldContainer = `mathematic-cache-test-cold-${randomUUID()}`;
const bucket = "test-cache-bucket";
const hotBucket = "hot-cache-bucket";
const coldBucket = "cold-cache-bucket";
const credentials = {
  accessKeyId: "cache-test",
  secretAccessKey: "cache-test-password",
};
const coldCredentials = {
  accessKeyId: "cold-tier",
  secretAccessKey: "cold-tier-secret",
};
let directory: string;
let endpoint: string;
let coldEndpoint: string;
let client: S3Client;
let coldClient: S3Client;
let gcsEndpoint: string;
let gcs: ReturnType<typeof spawn> | undefined;

function values(key: string): Record<string, string> {
  return {
    bucket,
    region: "us-east-1",
    endpoint,
    "force-path-style": "true",
    path: "cache",
    key,
    "part-size-mib": "5",
    "fail-on-error": "true",
    "timeout-seconds": "30",
  };
}
function store(key: string) {
  const input = values(key);
  const config = readConfig((name) => input[name] || "", {
    GITHUB_REPOSITORY: "test/repository",
  });
  return new Storage(
    new S3Bucket(config.tiers[0]!, config, client),
    config,
    namespace(config, CompressionMethod.Gzip),
  );
}

async function action(
  kind: string,
  input: Record<string, string>,
  state: Record<string, string> = {},
  work = directory,
  overrides: NodeJS.ProcessEnv = {},
) {
  const id = randomUUID();
  const output = path.join(directory, `${id}.output`);
  const stateFile = path.join(directory, `${id}.state`);
  await writeFile(output, "");
  await writeFile(stateFile, "");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GITHUB_REPOSITORY: "test/repository",
    GITHUB_WORKSPACE: work,
    GITHUB_OUTPUT: output,
    GITHUB_STATE: stateFile,
    RUNNER_TEMP: path.join(directory, "temporary"),
    AWS_ACCESS_KEY_ID: credentials.accessKeyId,
    AWS_SECRET_ACCESS_KEY: credentials.secretAccessKey,
    AWS_SESSION_TOKEN: "",
    GOOGLE_APPLICATION_CREDENTIALS: "",
    AWS_REGION: "us-east-1",
    ...overrides,
  };
  for (const [key, value] of Object.entries(input))
    env[`INPUT_${key.replaceAll(" ", "_").toUpperCase()}`] = value;
  for (const [key, value] of Object.entries(state)) env[`STATE_${key}`] = value;
  const result = await new Promise<{ code: number | null; log: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [path.resolve(`dist/${kind}.cjs`)], { env, cwd: work });
    let log = "";
    child.stdout.on("data", (data) => {
      log += data.toString();
    });
    child.stderr.on("data", (data) => {
      log += data.toString();
    });
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, log }));
  });
  const parse = (text: string) =>
    Object.fromEntries(
      [...text.matchAll(/^([^\n]+)<<([^\n]+)\n([\s\S]*?)\n\2(?:\n|$)/gm)].map((match) => [
        match[1],
        match[3],
      ]),
    );
  return {
    ...result,
    outputs: parse(await readFile(output, "utf8")),
    state: parse(await readFile(stateFile, "utf8")),
  };
}

// Starts a disposable MinIO server with its own credentials, and answers its endpoint.
async function minio(name: string, data: string, user: string, password: string) {
  await mkdir(data);
  execFileSync(
    "docker",
    [
      "run",
      "--detach",
      "--rm",
      "--name",
      name,
      ...(process.platform === "linux"
        ? ["--user", `${process.getuid?.()}:${process.getgid?.()}`]
        : []),
      "--publish",
      "127.0.0.1::9000",
      "--mount",
      `type=bind,source=${data},target=/data`,
      "--env",
      `MINIO_ROOT_USER=${user}`,
      "--env",
      `MINIO_ROOT_PASSWORD=${password}`,
      "quay.io/thanos/minio@sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e",
      "server",
      "/data",
    ],
    { stdio: "pipe" },
  );
  const port = execFileSync("docker", ["port", name, "9000/tcp"], {
    encoding: "utf8",
  }).trim();
  const address = `http://${port}`;
  const deadline = Date.now() + 20000;
  while (true) {
    try {
      if ((await fetch(`${address}/minio/health/ready`)).ok) break;
    } catch (error) {
      if (Date.now() > deadline) throw error;
    }
    if (Date.now() > deadline) throw new Error("MinIO startup timed out");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return address;
}

beforeAll(async () => {
  directory = await mkdtemp(path.join(process.cwd(), ".test-cache-"));
  await mkdir(path.join(directory, "temporary"));
  [endpoint, coldEndpoint] = await Promise.all([
    minio(
      container,
      path.join(directory, "s3"),
      credentials.accessKeyId,
      credentials.secretAccessKey,
    ),
    minio(
      coldContainer,
      path.join(directory, "s3-cold"),
      coldCredentials.accessKeyId,
      coldCredentials.secretAccessKey,
    ),
  ]);
  client = new S3Client({
    endpoint,
    region: "us-east-1",
    forcePathStyle: true,
    credentials,
  });
  await client.send(new CreateBucketCommand({ Bucket: bucket }));
  await client.send(new CreateBucketCommand({ Bucket: hotBucket }));
  coldClient = new S3Client({
    endpoint: coldEndpoint,
    region: "us-east-1",
    forcePathStyle: true,
    credentials: coldCredentials,
  });
  await coldClient.send(new CreateBucketCommand({ Bucket: coldBucket }));
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("No emulator port");
  const gcsPort = address.port;
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  gcsEndpoint = `http://127.0.0.1:${gcsPort}`;
  const binary =
    process.env.FAKE_GCS_SERVER ||
    path.resolve(
      ".test-tools",
      process.platform === "win32" ? "fake-gcs-server.exe" : "fake-gcs-server",
    );
  gcs = spawn(
    binary,
    [
      "-scheme",
      "http",
      "-host",
      "127.0.0.1",
      "-port",
      String(gcsPort),
      "-external-url",
      gcsEndpoint,
      "-backend",
      "memory",
      "-log-level",
      "error",
    ],
    { stdio: "ignore" },
  );
  const gcsDeadline = Date.now() + 20000;
  while (true) {
    if (gcs.exitCode !== null) throw new Error("GCS emulator exited during startup");
    try {
      if ((await fetch(`${gcsEndpoint}/storage/v1/b`)).ok) break;
    } catch (error) {
      if (Date.now() > gcsDeadline) throw error;
    }
    if (Date.now() > gcsDeadline) throw new Error("GCS emulator startup timed out");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const created = await fetch(`${gcsEndpoint}/storage/v1/b`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: bucket }),
  });
  if (!created.ok) throw new Error("Could not create emulator GCS bucket");
}, 30000);
afterAll(async () => {
  client?.destroy();
  coldClient?.destroy();
  if (gcs && gcs.exitCode === null) {
    const exited = once(gcs, "exit");
    gcs.kill();
    await exited;
  }
  try {
    execFileSync("docker", ["rm", "--force", container, coldContainer], { stdio: "ignore" });
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
  }
});

describe("real S3 transfers and packaged action", () => {
  it("streams multipart data, restores ranges, and refuses a concurrent overwrite", async () => {
    const cache = store("multipart");
    const file = path.join(directory, "source");
    const restored = path.join(directory, "restored");
    const content = randomBytes(12 * 1024 ** 2);
    await writeFile(file, content);
    const results = await Promise.all([
      cache.upload("multipart", file, AbortSignal.timeout(30000)),
      cache.upload("multipart", file, AbortSignal.timeout(30000)),
    ]);
    expect(results.sort((a, b) => Number(a) - Number(b))).toEqual([false, true]);
    const entry = await cache.connect(AbortSignal.timeout(30000));
    expect(entry).toBeDefined();
    await cache.download(entry!, restored, AbortSignal.timeout(30000));
    expect(await readFile(restored)).toEqual(content);
    expect(
      (await client.send(new ListMultipartUploadsCommand({ Bucket: bucket }))).Uploads || [],
    ).toEqual([]);
  }, 60000);
  it("rejects corrupt cache metadata without extracting data", async () => {
    const cache = store("corrupt");
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: cache.namespace + "corrupt",
        Body: "unverified archive",
      }),
    );
    await expect(cache.connect(AbortSignal.timeout(5000))).rejects.toThrow("metadata");
  });
  it("saves only in the post phase, preserving file modes and symlinks", async () => {
    const work = path.join(directory, "workspace");
    await mkdir(work);
    const input = values("post-lifecycle");
    const restored = await action("index", { ...input, "save-if": "false" }, {}, work);
    expect(restored.code, restored.log).toBe(0);
    expect(restored.outputs["cache-hit"]).toBe("false");
    expect(
      (await client.send(new ListObjectsV2Command({ Bucket: bucket }))).Contents?.some((object) =>
        object.Key?.endsWith("/post-lifecycle"),
      ),
    ).toBe(false);
    await mkdir(path.join(work, "cache"));
    await writeFile(path.join(work, "cache", "tool"), "installed tool");
    await chmod(path.join(work, "cache", "tool"), 0o755);
    await symlink("tool", path.join(work, "cache", "link"));
    const saved = await action(
      "index",
      { ...input, key: "changed-after-main", "save-if": "true" },
      restored.state,
      work,
    );
    expect(saved.code, saved.log).toBe(0);
    expect(saved.log).toContain("Bucket cache saved");
    await rm(path.join(work, "cache"), { recursive: true });
    const hit = await action("index", { ...input, "save-if": "false" }, {}, work);
    expect(hit.code, hit.log).toBe(0);
    expect(hit.outputs["cache-hit"]).toBe("true");
    expect(hit.outputs.tier).toBe("default");
    expect(hit.log).not.toContain("tier");
    expect(await readFile(path.join(work, "cache", "tool"), "utf8")).toBe("installed tool");
    expect((await stat(path.join(work, "cache", "tool"))).mode & 0o777).toBe(0o755);
    expect(await readlink(path.join(work, "cache", "link"))).toBe("tool");
    const skipped = await action("index", { ...input, "save-if": "true" }, hit.state, work);
    expect(skipped.log).toContain("Skipping cache save: exact hit");
  }, 60000);
  it("signs both phases with credentials the runner's environment holds under a prefix", async () => {
    const work = path.join(directory, "prefixed");
    await mkdir(work);
    const input = { ...values("prefixed-credentials"), "credentials-env-prefix": "RUNNER_S3" };
    const environment = {
      AWS_ACCESS_KEY_ID: "deployment-access",
      AWS_SECRET_ACCESS_KEY: "deployment-secret",
      RUNNER_S3_ACCESS_KEY_ID: credentials.accessKeyId,
      RUNNER_S3_SECRET_ACCESS_KEY: credentials.secretAccessKey,
    };
    const restored = await action("index", input, {}, work, environment);
    expect(restored.code, restored.log).toBe(0);
    expect(restored.log).toContain("Bucket cache miss");
    await mkdir(path.join(work, "cache"));
    await writeFile(path.join(work, "cache", "tool"), "installed tool");
    const saved = await action(
      "index",
      { ...input, "save-if": "true" },
      restored.state,
      work,
      environment,
    );
    expect(saved.code, saved.log).toBe(0);
    expect(saved.log).toContain("Bucket cache saved");
    const unset = await action("index", { ...input, "fail-on-error": "false" }, {}, work, {
      ...environment,
      RUNNER_S3_SECRET_ACCESS_KEY: "",
    });
    expect(unset.code, unset.log).toBe(0);
    expect(unset.log).toContain(
      "RUNNER_S3_ACCESS_KEY_ID and RUNNER_S3_SECRET_ACCESS_KEY must both be set",
    );
  }, 60000);
  it("does not save when the final save-if expression is false", async () => {
    const input = values("no-post-save");
    const first = await action("index", input);
    expect(first.code, first.log).toBe(0);
    const result = await action("index", { ...input, "save-if": "false" }, first.state);
    expect(result.code, result.log).toBe(0);
    expect(result.log).toContain("save-if is false");
  });
});

// The fleet's cache on its own network, whose bucket, endpoint and credentials
// the runner's environment holds, then the cloud's, which is always there.
function hotTier(extra = ""): string {
  return `- name: hot
  bucket-env: HOT_S3_BUCKET
  region: us-east-1
  endpoint-env: HOT_S3_ENDPOINT
  force-path-style: true
  credentials-env-prefix: HOT_S3
  connect-timeout-seconds: 1
${extra}`;
}
function coldTier(extra = ""): string {
  return `- name: cold
  bucket: ${coldBucket}
  region: us-east-1
  endpoint: ${coldEndpoint}
  force-path-style: true
  credentials-env-prefix: COLD_S3
${extra}`;
}
function tiers(options: { hot?: string; cold?: string } = {}): string {
  return hotTier(options.hot) + coldTier(options.cold);
}
function fleet(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    // Neither tier signs as the job's AWS credentials.
    AWS_ACCESS_KEY_ID: "deployment-access",
    AWS_SECRET_ACCESS_KEY: "deployment-secret",
    HOT_S3_BUCKET: hotBucket,
    HOT_S3_ENDPOINT: endpoint,
    HOT_S3_ACCESS_KEY_ID: credentials.accessKeyId,
    HOT_S3_SECRET_ACCESS_KEY: credentials.secretAccessKey,
    COLD_S3_ACCESS_KEY_ID: coldCredentials.accessKeyId,
    COLD_S3_SECRET_ACCESS_KEY: coldCredentials.secretAccessKey,
    ...overrides,
  };
}
function tiered(key: string, tierList = tiers()): Record<string, string> {
  return {
    tiers: tierList,
    path: "cache",
    key,
    "part-size-mib": "5",
    "fail-on-error": "true",
    "timeout-seconds": "30",
  };
}
async function holds(tier: "hot" | "cold", key: string): Promise<boolean> {
  const [s3, name] = tier === "hot" ? [client, hotBucket] : [coldClient, coldBucket];
  const listed = await s3.send(new ListObjectsV2Command({ Bucket: name }));
  return (listed.Contents ?? []).some((object) => object.Key?.endsWith(`/${key}`));
}
// A workspace whose cache directory holds one file, saved straight into one tier.
async function seed(tier: "hot" | "cold", key: string, contents: string): Promise<void> {
  const work = await mkdtemp(path.join(directory, `seed-${tier}-`));
  await mkdir(path.join(work, "cache"));
  await writeFile(path.join(work, "cache", "tool"), contents);
  const saved = await action(
    "save",
    tiered(key, tier === "hot" ? hotTier() : coldTier()),
    {},
    work,
    fleet(),
  );
  expect(saved.code, saved.log).toBe(0);
  expect(await holds(tier, key)).toBe(true);
}
async function workspace(name: string): Promise<string> {
  const work = path.join(directory, name);
  await mkdir(work);
  return work;
}
async function install(work: string, contents: string): Promise<void> {
  await mkdir(path.join(work, "cache"), { recursive: true });
  await writeFile(path.join(work, "cache", "tool"), contents);
}

describe("tiers, hot and cold, on two S3 servers", () => {
  it("misses in both tiers, then writes the save through to both", async () => {
    const work = await workspace("tiers-miss");
    const input = tiered("tiers-miss");
    const restored = await action("index", input, {}, work, fleet());
    expect(restored.code, restored.log).toBe(0);
    expect(restored.outputs).toMatchObject({ "cache-hit": "false", tier: "" });
    expect(restored.log).toContain("Bucket cache miss");
    await install(work, "installed in both");
    const saved = await action(
      "index",
      { ...input, "save-if": "true" },
      restored.state,
      work,
      fleet(),
    );
    expect(saved.code, saved.log).toBe(0);
    expect(saved.log).toContain("Bucket cache saved to tier hot");
    expect(saved.log).toContain("Bucket cache saved to tier cold");
    expect(await holds("hot", "tiers-miss")).toBe(true);
    expect(await holds("cold", "tiers-miss")).toBe(true);
  }, 60000);
  it("restores a hit only the cold tier holds, then promotes it to the hot one", async () => {
    await seed("cold", "tiers-promote", "from the cloud");
    expect(await holds("hot", "tiers-promote")).toBe(false);
    const work = await workspace("tiers-promote");
    const input = tiered("tiers-promote");
    const restored = await action("index", input, {}, work, fleet());
    expect(restored.code, restored.log).toBe(0);
    expect(restored.outputs).toMatchObject({ "cache-hit": "true", tier: "cold" });
    expect(restored.log).toContain("Bucket cache restored from tier cold");
    expect(await readFile(path.join(work, "cache", "tool"), "utf8")).toBe("from the cloud");
    const saved = await action(
      "index",
      { ...input, "save-if": "true" },
      restored.state,
      work,
      fleet(),
    );
    expect(saved.code, saved.log).toBe(0);
    expect(saved.log).toContain("Bucket cache saved to tier hot");
    expect(saved.log).not.toContain("to tier cold");
    expect(await holds("hot", "tiers-promote")).toBe(true);
    await rm(path.join(work, "cache"), { recursive: true });
    const again = await action("index", input, {}, work, fleet());
    expect(again.outputs).toMatchObject({ "cache-hit": "true", tier: "hot" });
    expect(await readFile(path.join(work, "cache", "tool"), "utf8")).toBe("from the cloud");
  }, 60000);
  it("takes an exact hit in the cold tier over a restore-key match in the hot one", async () => {
    await seed("hot", "tiers-exact-older", "an older build");
    await seed("cold", "tiers-exact", "this build");
    const work = await workspace("tiers-exact");
    const restored = await action(
      "restore",
      { ...tiered("tiers-exact"), "restore-keys": "tiers-exact-" },
      {},
      work,
      fleet(),
    );
    expect(restored.code, restored.log).toBe(0);
    expect(restored.outputs).toMatchObject({
      "cache-hit": "true",
      "cache-matched-key": "tiers-exact",
      tier: "cold",
    });
    expect(await readFile(path.join(work, "cache", "tool"), "utf8")).toBe("this build");
    const fallback = await action(
      "restore",
      { ...tiered("tiers-exact-newer"), "restore-keys": "tiers-exact" },
      {},
      await workspace("tiers-exact-fallback"),
      fleet(),
    );
    expect(fallback.outputs).toMatchObject({
      "cache-hit": "false",
      "cache-matched-key": "tiers-exact-older",
      tier: "hot",
    });
  }, 60000);
  it("takes a more specific restore key's match in the cold tier over a less specific one in the hot", async () => {
    await seed("hot", "tiers-specific-other", "another lockfile's build");
    await seed("cold", "tiers-specific-lock-older", "this lockfile's older build");
    const work = await workspace("tiers-specific");
    const restored = await action(
      "restore",
      {
        ...tiered("tiers-specific-lock-new"),
        "restore-keys": "tiers-specific-lock-\ntiers-specific-",
      },
      {},
      work,
      fleet(),
    );
    expect(restored.code, restored.log).toBe(0);
    expect(restored.outputs).toMatchObject({
      "cache-hit": "false",
      "cache-matched-key": "tiers-specific-lock-older",
      tier: "cold",
    });
    expect(await readFile(path.join(work, "cache", "tool"), "utf8")).toBe(
      "this lockfile's older build",
    );
  }, 60000);
  it("passes over the hot tier when its server is down, even with fail-on-error", async () => {
    const listener = createServer();
    listener.listen(0, "127.0.0.1");
    await once(listener, "listening");
    const { port } = listener.address() as AddressInfo;
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    const down = fleet({ HOT_S3_ENDPOINT: `http://127.0.0.1:${port}` });
    await seed("cold", "tiers-down", "while the office is down");
    const work = await workspace("tiers-down");
    const input = tiered("tiers-down");
    const started = Date.now();
    const restored = await action("index", input, {}, work, down);
    expect(restored.code, restored.log).toBe(0);
    expect(Date.now() - started).toBeLessThan(15000);
    expect(restored.log).toContain("Tier hot skipped: No connection (ECONNREFUSED)");
    expect(restored.outputs).toMatchObject({ "cache-hit": "true", tier: "cold" });
    const saved = await action(
      "index",
      { ...input, "save-if": "true" },
      restored.state,
      work,
      down,
    );
    expect(saved.code, saved.log).toBe(0);
    expect(saved.log).toContain("Tier hot skipped: No connection (ECONNREFUSED)");
    expect(await holds("hot", "tiers-down")).toBe(false);
  }, 60000);
  it("passes over the hot tier on a runner without its credentials or bucket", async () => {
    await seed("cold", "tiers-outside", "outside the fleet");
    for (const [missing, reason] of [
      [
        { HOT_S3_ACCESS_KEY_ID: "", HOT_S3_SECRET_ACCESS_KEY: "" },
        "Tier hot skipped: HOT_S3_ACCESS_KEY_ID and HOT_S3_SECRET_ACCESS_KEY are not set",
      ],
      [
        { HOT_S3_BUCKET: "", HOT_S3_ENDPOINT: "" },
        "Tier hot skipped: HOT_S3_BUCKET and HOT_S3_ENDPOINT are not set",
      ],
    ] as const) {
      const work = await workspace(`tiers-outside-${randomUUID()}`);
      const restored = await action("index", tiered("tiers-outside"), {}, work, fleet(missing));
      expect(restored.code, restored.log).toBe(0);
      expect(restored.log).toContain(reason);
      expect(restored.log).not.toContain("::warning::");
      const printed = restored.log.replace(/^::add-mask::.*$/gm, "");
      for (const secret of [credentials.secretAccessKey, coldCredentials.secretAccessKey])
        expect(printed).not.toContain(secret);
      expect(restored.outputs).toMatchObject({ "cache-hit": "true", tier: "cold" });
      expect(await readFile(path.join(work, "cache", "tool"), "utf8")).toBe("outside the fleet");
    }
  }, 60000);
  it("skips the hot tier when its variable holds a malformed value, unless fail-on-error", async () => {
    await seed("cold", "tiers-malformed", "despite the office's variables");
    const malformed = fleet({ HOT_S3_ENDPOINT: "s3.office.example:9000" });
    const reason =
      "HOT_S3_ENDPOINT doesn't hold a valid endpoint: Endpoint must be an HTTP(S) URL without credentials, query, or fragment";
    const work = await workspace("tiers-malformed");
    const input = { ...tiered("tiers-malformed"), "fail-on-error": "false" };
    const restored = await action("index", input, {}, work, malformed);
    expect(restored.code, restored.log).toBe(0);
    expect(restored.log).toContain(`::warning::Tier hot skipped: ${reason}`);
    expect(restored.log).not.toContain("s3.office.example");
    expect(restored.outputs).toMatchObject({ "cache-hit": "true", tier: "cold" });
    const failed = await action("index", tiered("tiers-malformed"), {}, work, malformed);
    expect(failed.code).toBe(1);
    expect(failed.log).toContain(`::error::Bucket cache restore failed: Tier hot: ${reason}`);
  }, 60000);
  it("saves to every tier but the one with save: false", async () => {
    const work = await workspace("tiers-read-only");
    const input = tiered("tiers-read-only", tiers({ cold: "  save: false\n" }));
    const restored = await action("index", input, {}, work, fleet());
    expect(restored.code, restored.log).toBe(0);
    await install(work, "saved to the office only");
    const saved = await action(
      "index",
      { ...input, "save-if": "true" },
      restored.state,
      work,
      fleet(),
    );
    expect(saved.code, saved.log).toBe(0);
    expect(await holds("hot", "tiers-read-only")).toBe(true);
    expect(await holds("cold", "tiers-read-only")).toBe(false);
  }, 60000);
  it("refuses tiers beside the single-bucket inputs", async () => {
    const refused = await action(
      "index",
      { ...values("tiers-both"), tiers: tiers() },
      {},
      directory,
      fleet(),
    );
    expect(refused.code).toBe(1);
    expect(refused.log).toContain(
      "Invalid cache configuration: Give tiers or the single-bucket inputs, not both; remove bucket, region, endpoint, force-path-style",
    );
  });
});

function gcsValues(key: string): Record<string, string> {
  return {
    provider: "gcs",
    bucket,
    endpoint: gcsEndpoint,
    anonymous: "true",
    path: "cache",
    key,
    "part-size-mib": "5",
    "fail-on-error": "true",
    "timeout-seconds": "30",
  };
}
function gcsStore(key: string) {
  const input = gcsValues(key);
  const config = readConfig((name) => input[name] || "", {
    GITHUB_REPOSITORY: "test/repository",
  });
  return new Storage(
    new GcsBucket(config.tiers[0]!, config),
    config,
    namespace(config, CompressionMethod.Gzip),
  );
}
describe("GCS emulator and packaged action", () => {
  it("resumes chunked uploads and pins range downloads to the object generation", async () => {
    const cache = gcsStore("gcs-chunked");
    const file = path.join(directory, "gcs-source");
    const destination = path.join(directory, "gcs-restored");
    const bytes = randomBytes(12 * 1024 ** 2);
    await writeFile(file, bytes);
    expect(await cache.upload("gcs-chunked", file, AbortSignal.timeout(30000))).toBe(true);
    expect(await cache.upload("gcs-chunked", file, AbortSignal.timeout(30000))).toBe(false);
    const entry = await cache.connect(AbortSignal.timeout(10000));
    expect(entry).toBeDefined();
    const rawResponse = await fetch(
      `${gcsEndpoint}/storage/v1/b/${bucket}/o/${encodeURIComponent(cache.namespace + "gcs-chunked")}?alt=media`,
    );
    const raw = Buffer.from(await rawResponse.arrayBuffer());
    expect(
      raw.equals(bytes),
      `Uploaded GCS bytes differ: ${raw.length} vs ${bytes.length}, first mismatch ${raw.findIndex((value, index) => value !== bytes[index])}`,
    ).toBe(true);
    await cache.download(entry!, destination, AbortSignal.timeout(30000));
    expect(await readFile(destination)).toEqual(bytes);
  }, 60000);
  it("runs the same restore/post lifecycle with GCS", async () => {
    const work = path.join(directory, "gcs-workspace");
    await mkdir(work);
    const input = gcsValues("gcs-post");
    const first = await action("index", { ...input, "save-if": "false" }, {}, work);
    expect(first.code, first.log).toBe(0);
    expect(first.outputs["cache-hit"]).toBe("false");
    await mkdir(path.join(work, "cache"));
    await writeFile(path.join(work, "cache", "tool"), "installed from GCS");
    const saved = await action("index", { ...input, "save-if": "true" }, first.state, work);
    expect(saved.code, saved.log).toBe(0);
    await rm(path.join(work, "cache"), { recursive: true });
    const hit = await action("restore", input, {}, work);
    expect(hit.code, hit.log).toBe(0);
    expect(hit.outputs["cache-hit"]).toBe("true");
    expect(await readFile(path.join(work, "cache", "tool"), "utf8")).toBe("installed from GCS");
  }, 60000);
});
