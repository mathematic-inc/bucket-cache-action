import { afterEach, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pack, unpack, digest } from "../src/archive.js";
import { CompressionMethod } from "@actions/cache/lib/internal/constants.js";
import { getCompressionMethod } from "@actions/cache/lib/internal/cacheUtils.js";

afterEach(() => vi.unstubAllEnvs());
it("round trips absolute cache paths containing spaces with the platform archive tools", async () => {
  const directory = await mkdtemp(path.join(process.cwd(), "archive-test-"));
  const workspace = path.join(directory, "workspace");
  const cache = path.join(directory, "outside workspace cache");
  const output = path.join(directory, "archive");
  try {
    await mkdir(workspace);
    await mkdir(cache);
    await mkdir(output);
    vi.stubEnv("GITHUB_WORKSPACE", workspace);
    await writeFile(
      path.join(cache, "package file.txt"),
      "dependency contents",
    );
    const compression = await getCompressionMethod();
    const file = await pack(output, [cache], compression);
    expect(file).toBeDefined();
    expect(await digest(file!)).toMatch(/^[a-f0-9]{64}$/);
    await rm(cache, { recursive: true });
    await unpack(file!, compression);
    expect(await readFile(path.join(cache, "package file.txt"), "utf8")).toBe(
      "dependency contents",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
it("does not create an archive when no files match", async () => {
  const directory = await mkdtemp(path.join(process.cwd(), "archive-test-"));
  try {
    expect(
      await pack(
        directory,
        [path.join(directory, "missing")],
        CompressionMethod.Gzip,
      ),
    ).toBeUndefined();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
