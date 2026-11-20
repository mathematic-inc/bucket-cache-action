import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, mkdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { finished, pipeline } from "node:stream/promises";
import { createZstdCompress, createZstdDecompress, createGzip, createGunzip } from "node:zlib";

import * as glob from "@actions/glob";
import * as tar from "tar";

import { CacheError } from "./errors.js";
import { nonEmpty } from "./utils.js";

export const CompressionMethod = { Gzip: "gzip", Zstd: "zstd" } as const;
export type CompressionMethod = (typeof CompressionMethod)[keyof typeof CompressionMethod];

function workspaceDirectory(): string {
  return nonEmpty(process.env.GITHUB_WORKSPACE) ?? process.cwd();
}

export async function temporaryDirectory(): Promise<string> {
  const parent = nonEmpty(process.env.RUNNER_TEMP) ?? tmpdir();
  await mkdir(parent, { recursive: true });
  return mkdtemp(path.join(parent, "mathematic-cache-"));
}

export async function pack(
  directory: string,
  patterns: readonly string[],
  compression: CompressionMethod,
): Promise<string | undefined> {
  const matcher = await glob.create(patterns.join("\n"), {
    implicitDescendants: true,
    followSymbolicLinks: false,
    omitBrokenSymbolicLinks: false,
  });
  const paths = await matcher.glob();
  if (paths.length === 0) {
    return undefined;
  }
  const workspace = workspaceDirectory();
  const files = paths.map((file) => {
    const relative = path.relative(workspace, file).replaceAll("\\", "/") || ".";
    return path.isAbsolute(relative) ? relative : `./${relative}`;
  });
  const destination = path.join(directory, "cache.tar.compressed");
  // Caches may explicitly include directories outside the workspace. Only
  // principals trusted to supply executable dependencies may write a cache.
  await pipeline(
    tar.create(
      {
        cwd: workspace,
        preservePaths: true,
        portable: true,
        follow: false,
        // Concurrent packing can stall on three hard links outside cwd, as in
        // pnpm's tool directory. Process one entry at a time to avoid that race.
        jobs: 1,
        noDirRecurse: true,
        strict: true,
      },
      files,
    ),
    compression === "zstd" ? createZstdCompress() : createGzip(),
    createWriteStream(destination),
  );
  return destination;
}

export async function unpack(file: string, compression: CompressionMethod): Promise<void> {
  await pipeline(
    createReadStream(file),
    compression === "zstd" ? createZstdDecompress() : createGunzip(),
    tar.extract({
      cwd: workspaceDirectory(),
      preservePaths: true,
      preserveOwner: false,
      chmod: true,
      strict: true,
    }),
  );
}

export async function digest(file: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = createReadStream(file).on("data", (chunk: Buffer | string) => {
    hash.update(chunk);
  });
  await finished(stream);
  return hash.digest("hex");
}

export async function size(file: string, maximum: number): Promise<number> {
  const bytes = (await stat(file)).size;
  if (!bytes || bytes > maximum) {
    throw new CacheError("Cache archive is empty or exceeds max-size-mib");
  }
  return bytes;
}

export async function cleanup(directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true });
}
