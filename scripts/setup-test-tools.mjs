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
      "039d7a520869115b9bc1b354f73612d2dad0aa27b22104f111d8c94985007fe1",
    ],
    "linux-x64": [
      "Linux_amd64",
      "0f2f9f6884417acd5cc27126a9aa237ccc627372a4aa5008b399641de6db9469",
    ],
    "linux-arm64": [
      "Linux_arm64",
      "89a4b887a50834ce5844f47f9938a1203a89330e660b2af7851b858fa489fa96",
    ],
    "win32-x64": [
      "Windows_amd64",
      "79c1a92b6d666c6fc2a60439f8ebee9e01b918dad90cae6f003ade4a5877a566",
    ],
  };
  const platform = platforms[`${process.platform}-${process.arch}`];
  if (!platform) throw new Error("Unsupported emulator test platform");
  const directory = path.resolve(".test-tools");
  await mkdir(directory, { recursive: true });
  const name = `fake-gcs-server_1.56.1_${platform[0]}.tar.gz`;
  const response = await fetch(
    `https://github.com/fsouza/fake-gcs-server/releases/download/v1.56.1/${name}`,
  );
  if (!response.ok) throw new Error(`Emulator download failed with HTTP ${response.status}`);
  const data = Buffer.from(await response.arrayBuffer());
  if (createHash("sha256").update(data).digest("hex") !== platform[1])
    throw new Error("Emulator checksum mismatch");
  const archive = path.join(directory, name);
  await writeFile(archive, data);
  execFileSync("tar", ["-xzf", archive, "-C", directory]);
}
