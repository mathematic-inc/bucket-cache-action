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
import { createServer } from "node:net";
import { once } from "node:events";
import { readConfig, namespace } from "../src/config.js";
import { CompressionMethod } from "@actions/cache/lib/internal/constants.js";
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
const bucket = "test-cache-bucket";
const credentials = {
  accessKeyId: "cache-test",
  secretAccessKey: "cache-test-password",
};
let directory: string;
let endpoint: string;
let client: S3Client;
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
    new S3Bucket(config, client),
    config,
    namespace(config, CompressionMethod.Gzip),
  );
}

async function action(
  kind: string,
  input: Record<string, string>,
  state: Record<string, string> = {},
  work = directory,
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
  };
  for (const [key, value] of Object.entries(input))
    env[`INPUT_${key.replaceAll(" ", "_").toUpperCase()}`] = value;
  for (const [key, value] of Object.entries(state)) env[`STATE_${key}`] = value;
  const result = await new Promise<{ code: number | null; log: string }>(
    (resolve, reject) => {
      const child = spawn(
        process.execPath,
        [path.resolve(`dist/${kind}.cjs`)],
        { env, cwd: work },
      );
      let log = "";
      child.stdout.on("data", (data) => {
        log += data.toString();
      });
      child.stderr.on("data", (data) => {
        log += data.toString();
      });
      child.on("error", reject);
      child.on("exit", (code) => resolve({ code, log }));
    },
  );
  const parse = (text: string) =>
    Object.fromEntries(
      [...text.matchAll(/^([^\n]+)<<([^\n]+)\n([\s\S]*?)\n\2(?:\n|$)/gm)].map(
        (match) => [match[1], match[3]],
      ),
    );
  return {
    ...result,
    outputs: parse(await readFile(output, "utf8")),
    state: parse(await readFile(stateFile, "utf8")),
  };
}

beforeAll(async () => {
  directory = await mkdtemp(path.join(process.cwd(), ".test-cache-"));
  await mkdir(path.join(directory, "s3"));
  await mkdir(path.join(directory, "temporary"));
  execFileSync(
    "docker",
    [
      "run",
      "--detach",
      "--rm",
      "--name",
      container,
      "--publish",
      "127.0.0.1::9000",
      "--mount",
      `type=bind,source=${path.join(directory, "s3")},target=/data`,
      "--env",
      `MINIO_ROOT_USER=${credentials.accessKeyId}`,
      "--env",
      `MINIO_ROOT_PASSWORD=${credentials.secretAccessKey}`,
      "minio/minio@sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e",
      "server",
      "/data",
    ],
    { stdio: "pipe" },
  );
  const port = execFileSync("docker", ["port", container, "9000/tcp"], {
    encoding: "utf8",
  }).trim();
  endpoint = `http://${port}`;
  const deadline = Date.now() + 20000;
  while (true) {
    try {
      if ((await fetch(`${endpoint}/minio/health/ready`)).ok) break;
    } catch (error) {
      if (Date.now() > deadline) throw error;
    }
    if (Date.now() > deadline) throw new Error("MinIO startup timed out");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  client = new S3Client({
    endpoint,
    region: "us-east-1",
    forcePathStyle: true,
    credentials,
  });
  await client.send(new CreateBucketCommand({ Bucket: bucket }));
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const address = listener.address();
  if (!address || typeof address === "string")
    throw new Error("No emulator port");
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
    if (gcs.exitCode !== null)
      throw new Error("GCS emulator exited during startup");
    try {
      if ((await fetch(`${gcsEndpoint}/storage/v1/b`)).ok) break;
    } catch (error) {
      if (Date.now() > gcsDeadline) throw error;
    }
    if (Date.now() > gcsDeadline)
      throw new Error("GCS emulator startup timed out");
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
  if (gcs && gcs.exitCode === null) {
    const exited = once(gcs, "exit");
    gcs.kill();
    await exited;
  }
  try {
    execFileSync("docker", ["rm", "--force", container], { stdio: "ignore" });
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
    expect(results.sort()).toEqual([false, true]);
    const entry = await cache.lookup(AbortSignal.timeout(30000));
    expect(entry).toBeDefined();
    await cache.download(entry!, restored, AbortSignal.timeout(30000));
    expect(await readFile(restored)).toEqual(content);
    expect(
      (await client.send(new ListMultipartUploadsCommand({ Bucket: bucket })))
        .Uploads || [],
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
    await expect(cache.lookup(AbortSignal.timeout(5000))).rejects.toThrow(
      "metadata",
    );
  });
  it("saves only in the post phase, preserving file modes and symlinks", async () => {
    const work = path.join(directory, "workspace");
    await mkdir(work);
    const input = values("post-lifecycle");
    const restored = await action(
      "index",
      { ...input, "save-if": "false" },
      {},
      work,
    );
    expect(restored.code, restored.log).toBe(0);
    expect(restored.outputs["cache-hit"]).toBe("false");
    expect(
      (
        await client.send(new ListObjectsV2Command({ Bucket: bucket }))
      ).Contents?.some((object) => object.Key?.endsWith("/post-lifecycle")),
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
    const hit = await action(
      "index",
      { ...input, "save-if": "false" },
      {},
      work,
    );
    expect(hit.code, hit.log).toBe(0);
    expect(hit.outputs["cache-hit"]).toBe("true");
    expect(await readFile(path.join(work, "cache", "tool"), "utf8")).toBe(
      "installed tool",
    );
    expect((await stat(path.join(work, "cache", "tool"))).mode & 0o777).toBe(
      0o755,
    );
    expect(await readlink(path.join(work, "cache", "link"))).toBe("tool");
    const skipped = await action(
      "index",
      { ...input, "save-if": "true" },
      hit.state,
      work,
    );
    expect(skipped.log).toContain("Skipping cache save: exact hit");
  }, 60000);
  it("does not save when the final save-if expression is false", async () => {
    const input = values("no-post-save");
    const first = await action("index", input);
    expect(first.code, first.log).toBe(0);
    const result = await action(
      "index",
      { ...input, "save-if": "false" },
      first.state,
    );
    expect(result.code, result.log).toBe(0);
    expect(result.log).toContain("save-if is false");
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
    new GcsBucket(config),
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
    expect(
      await cache.upload("gcs-chunked", file, AbortSignal.timeout(30000)),
    ).toBe(true);
    expect(
      await cache.upload("gcs-chunked", file, AbortSignal.timeout(30000)),
    ).toBe(false);
    const entry = await cache.lookup(AbortSignal.timeout(10000));
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
    const first = await action(
      "index",
      { ...input, "save-if": "false" },
      {},
      work,
    );
    expect(first.code, first.log).toBe(0);
    expect(first.outputs["cache-hit"]).toBe("false");
    await mkdir(path.join(work, "cache"));
    await writeFile(path.join(work, "cache", "tool"), "installed from GCS");
    const saved = await action(
      "index",
      { ...input, "save-if": "true" },
      first.state,
      work,
    );
    expect(saved.code, saved.log).toBe(0);
    await rm(path.join(work, "cache"), { recursive: true });
    const hit = await action("restore", input, {}, work);
    expect(hit.code, hit.log).toBe(0);
    expect(hit.outputs["cache-hit"]).toBe("true");
    expect(await readFile(path.join(work, "cache", "tool"), "utf8")).toBe(
      "installed from GCS",
    );
  }, 60000);
});
