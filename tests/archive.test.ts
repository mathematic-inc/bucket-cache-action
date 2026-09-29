import { afterEach, expect, it, vi } from "vitest";
import { link, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pack, unpack, digest } from "../src/archive.js";
import { CompressionMethod } from "../src/archive.js";

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
    await writeFile(path.join(cache, "package file.txt"), "dependency contents");
    const compression = CompressionMethod.Zstd;
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
      await pack(directory, [path.join(directory, "missing")], CompressionMethod.Gzip),
    ).toBeUndefined();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("round trips three hard links to each file outside the workspace", async () => {
  const directory = await mkdtemp(path.join(process.cwd(), "archive-test-"));
  const workspace = path.join(directory, "workspace");
  const cache = path.join(directory, "tools");
  const output = path.join(directory, "archive");
  const contents = Buffer.alloc(1024 * 1024, 42);
  try {
    await mkdir(workspace);
    await mkdir(cache);
    await mkdir(output);
    vi.stubEnv("GITHUB_WORKSPACE", workspace);
    for (let index = 0; index < 4; index++) {
      const tool = path.join(cache, String(index));
      await mkdir(tool);
      await writeFile(path.join(tool, "pnpm"), contents);
      await link(path.join(tool, "pnpm"), path.join(tool, "pnpx"));
      await link(path.join(tool, "pnpm"), path.join(tool, "pnx"));
    }
    const file = await pack(output, [cache], CompressionMethod.Zstd);
    expect(file).toBeDefined();
    await rm(cache, { recursive: true });
    await unpack(file!, CompressionMethod.Zstd);
    for (let index = 0; index < 4; index++) {
      for (const name of ["pnpm", "pnpx", "pnx"]) {
        const restored = await readFile(path.join(cache, String(index), name));
        expect(restored.equals(contents)).toBe(true);
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it.skipIf(process.platform !== "win32")(
  "restores a Windows home-directory cache across drive roots",
  async () => {
    const { homedir } = await import("node:os");
    const work = await mkdtemp(path.join(process.cwd(), "archive-test-"));
    const cache = await mkdtemp(path.join(homedir(), "bucket-cache-test-"));
    const output = path.join(work, "archive");
    try {
      await mkdir(output);
      vi.stubEnv("GITHUB_WORKSPACE", work);
      await writeFile(path.join(cache, "tool.txt"), "windows home cache");
      const file = await pack(output, [cache], CompressionMethod.Zstd);
      expect(file).toBeDefined();
      await rm(cache, { recursive: true });
      await unpack(file!, CompressionMethod.Zstd);
      expect(await readFile(path.join(cache, "tool.txt"), "utf8")).toBe("windows home cache");
    } finally {
      await rm(cache, { recursive: true, force: true });
      await rm(work, { recursive: true, force: true });
    }
  },
);

it("honors nested exclusions without treating at-prefixed file names as tar directives", async () => {
  const directory = await mkdtemp(path.join(process.cwd(), "archive-test-"));
  const cache = path.join(directory, "cache");
  const output = path.join(directory, "archive");
  try {
    await mkdir(cache);
    await mkdir(output);
    vi.stubEnv("GITHUB_WORKSPACE", directory);
    await writeFile(path.join(cache, "keep"), "included");
    await writeFile(path.join(cache, "omit"), "excluded");
    await writeFile(path.join(directory, "@literal"), "literal file");
    const file = await pack(
      output,
      [cache, `!${path.join(cache, "omit")}`, path.join(directory, "@literal")],
      CompressionMethod.Zstd,
    );
    await rm(cache, { recursive: true });
    await rm(path.join(directory, "@literal"));
    await unpack(file!, CompressionMethod.Zstd);
    expect(await readFile(path.join(cache, "keep"), "utf8")).toBe("included");
    await expect(readFile(path.join(cache, "omit"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(directory, "@literal"), "utf8")).toBe("literal file");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
