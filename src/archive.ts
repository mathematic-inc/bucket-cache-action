import { CacheError } from "./errors.js";
import * as glob from "@actions/glob";
import * as tar from "tar";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, mkdir, rm, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { createZstdCompress, createZstdDecompress, createGzip, createGunzip } from "node:zlib";

export const CompressionMethod = { Gzip: "gzip", Zstd: "zstd" } as const;
export type CompressionMethod = (typeof CompressionMethod)[keyof typeof CompressionMethod];

export async function temporaryDirectory(): Promise<string> {
  const parent = process.env.RUNNER_TEMP || tmpdir();
  await mkdir(parent, { recursive: true });
  return mkdtemp(path.join(parent, "mathematic-cache-"));
}

export async function pack(
  directory: string,
  patterns: string[],
  compression: CompressionMethod,
): Promise<string | undefined> {
  const matcher = await glob.create(patterns.join("\n"), {
    implicitDescendants: true,
    followSymbolicLinks: false,
    omitBrokenSymbolicLinks: false,
  });
  const paths = await matcher.glob();
  if (!paths.length) return undefined;
  const workspace = process.env.GITHUB_WORKSPACE || process.cwd();
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
      cwd: process.env.GITHUB_WORKSPACE || process.cwd(),
      preservePaths: true,
      preserveOwner: false,
      chmod: true,
      strict: true,
    }),
  );
}

export async function digest(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

export async function size(file: string, maximum: number): Promise<number> {
  const bytes = (await stat(file)).size;
  if (!bytes || bytes > maximum)
    throw new CacheError("Cache archive is empty or exceeds max-size-mib");
  return bytes;
}

export async function cleanup(directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true });
}
