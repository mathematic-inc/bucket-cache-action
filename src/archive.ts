import { CacheError } from "./errors.js";
// Archive handling follows runs-on/cache, reusing the pinned GitHub toolkit's
// GNU/BSD tar and Windows support. No GitHub cache service API is called.
import { createTar, extractTar } from "@actions/cache/lib/internal/tar.js";
import {
  getCacheFileName,
  resolvePaths,
} from "@actions/cache/lib/internal/cacheUtils.js";
import type { CompressionMethod } from "@actions/cache/lib/internal/constants.js";
import { createReadStream } from "node:fs";
import { mkdtemp, mkdir, rm, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";

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
  const paths = await resolvePaths(patterns);
  if (!paths.length) return undefined;
  if (
    paths.some((value) => /^[\-]/.test(value) || /[\x00-\x1f\x7f]/.test(value))
  ) {
    throw new CacheError(
      "A resolved cache path cannot be represented safely in the tar manifest",
    );
  }
  await createTar(directory, paths, compression);
  return path.join(directory, getCacheFileName(compression));
}

export async function unpack(
  file: string,
  compression: CompressionMethod,
): Promise<void> {
  await extractTar(file, compression);
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
