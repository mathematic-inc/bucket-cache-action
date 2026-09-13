import { build } from "esbuild";
import { readFile, writeFile, readdir, access } from "node:fs/promises";
import path from "node:path";

const result = await build({
  entryPoints: ["src/index.ts", "src/restore.ts", "src/save.ts"],
  bundle: true,
  platform: "node",
  target: "node24",
  format: "cjs",
  minify: true,
  outdir: "dist",
  outExtension: { ".js": ".cjs" },
  legalComments: "eof",
  metafile: true,
  logLevel: "info",
});
const packages = new Map();
for (const file of Object.keys(result.metafile.inputs)) {
  if (!file.includes("node_modules/")) continue;
  let directory = path.dirname(file);
  while (directory.includes("node_modules")) {
    try {
      await access(path.join(directory, "package.json"));
      const pkg = JSON.parse(
        await readFile(path.join(directory, "package.json"), "utf8"),
      );
      if (pkg.name && pkg.version) {
        packages.set(`${pkg.name}@${pkg.version}`, directory);
        break;
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    directory = path.dirname(directory);
  }
}
let notices = "Bundled third-party licenses\n";
for (const [name, directory] of [...packages].sort(([a], [b]) =>
  a.localeCompare(b, "en"),
)) {
  notices += `\n${"=".repeat(72)}\n${name}\n${"=".repeat(72)}\n`;
  const files = (await readdir(directory))
    .filter((file) => /^(license|copying|notice)(\.|$)/i.test(file))
    .sort();
  if (!files.length) {
    const pkg = JSON.parse(
      await readFile(path.join(directory, "package.json"), "utf8"),
    );
    notices += `License: ${pkg.license || "See package source"}\nSource: https://www.npmjs.com/package/${pkg.name}/v/${pkg.version}\n`;
  }
  for (const file of files)
    notices += `${await readFile(path.join(directory, file), "utf8")}\n`;
}
await writeFile("dist/licenses.txt", notices);
