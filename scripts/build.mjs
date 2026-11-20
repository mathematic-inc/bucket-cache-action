import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { build } from "esbuild";
import { z } from "zod";

/**
 * @typedef {{
 *   readonly directory: string;
 *   readonly id: string;
 *   readonly license: string | undefined;
 *   readonly name: string;
 *   readonly version: string;
 * }} Dependency
 */

const text = z
  .string()
  .optional()
  .transform((value) => (value === "" ? undefined : value));
const manifestSchema = z.looseObject({ name: text, version: text, license: text });

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
/** @type {Map<string, Dependency>} */
const dependencies = new Map();
for (const file of Object.keys(result.metafile.inputs)) {
  if (!file.includes("node_modules/")) {
    continue;
  }
  let directory = path.dirname(file);
  while (directory.includes("node_modules")) {
    try {
      const manifest = manifestSchema.parse(
        JSON.parse(await readFile(path.join(directory, "package.json"), "utf8")),
      );
      if (manifest.name !== undefined && manifest.version !== undefined) {
        const id = `${manifest.name}@${manifest.version}`;
        dependencies.set(id, {
          directory,
          id,
          license: manifest.license,
          name: manifest.name,
          version: manifest.version,
        });
        break;
      }
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
    }
    directory = path.dirname(directory);
  }
}
/** @type {(left: Dependency, right: Dependency) => number} */
const byId = (left, right) => left.id.localeCompare(right.id, "en");
let notices = "Bundled third-party licenses\n";
for (const { directory, id, license, name, version } of [...dependencies.values()].toSorted(byId)) {
  notices += `\n${"=".repeat(72)}\n${id}\n${"=".repeat(72)}\n`;
  const files = (await readdir(directory))
    .filter((file) => /^(license|copying|notice)(\.|$)/iv.test(file))
    .toSorted();
  if (files.length === 0) {
    notices += `License: ${license ?? "See package source"}\nSource: https://www.npmjs.com/package/${name}/v/${version}\n`;
  }
  for (const file of files) {
    notices += `${await readFile(path.join(directory, file), "utf8")}\n`;
  }
}
await writeFile("dist/licenses.txt", notices);
