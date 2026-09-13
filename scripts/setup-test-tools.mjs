import { mkdir, writeFile, access } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";

if (process.env.FAKE_GCS_SERVER) {
  await access(process.env.FAKE_GCS_SERVER);
} else {
  const platforms = {
    "darwin-arm64": [
      "Darwin_arm64",
      "9b10c6d7bcf918a5fdc89c00bb3e29a3c37b3718113f1adeef0cc5ec3f2ed78a",
    ],
    "linux-x64": [
      "Linux_amd64",
      "3001b2da1fd135eac3a2b38aa2e50c0dbcf89b9359380d4d2b9809c58ca9710b",
    ],
    "linux-arm64": [
      "Linux_arm64",
      "b48053046d5e3b569452ad3dfdde141c7059fafb072b73603947c6af59ba524c",
    ],
    "win32-x64": [
      "Windows_amd64",
      "e1c5f11fad5fd31406a940993b1dad4cbb805f0ca5dbaec76522e432a8fa8906",
    ],
  };
  const platform = platforms[`${process.platform}-${process.arch}`];
  if (!platform) throw new Error("Unsupported emulator test platform");
  const directory = path.resolve(".test-tools");
  await mkdir(directory, { recursive: true });
  const name = `fake-gcs-server_1.54.0_${platform[0]}.tar.gz`;
  const response = await fetch(
    `https://github.com/fsouza/fake-gcs-server/releases/download/v1.54.0/${name}`,
  );
  if (!response.ok)
    throw new Error(`Emulator download failed with HTTP ${response.status}`);
  const data = Buffer.from(await response.arrayBuffer());
  if (createHash("sha256").update(data).digest("hex") !== platform[1])
    throw new Error("Emulator checksum mismatch");
  const archive = path.join(directory, name);
  await writeFile(archive, data);
  execFileSync("tar", ["-xzf", archive, "-C", directory]);
}
