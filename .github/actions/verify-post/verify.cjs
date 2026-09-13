const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { randomUUID } = require("node:crypto");
if (!process.env.STATE_verify) {
  fs.appendFileSync(process.env.GITHUB_STATE, "verify=true\n");
} else {
  const output = path.join(
    process.env.RUNNER_TEMP,
    `post-output-${randomUUID()}`,
  );
  fs.writeFileSync(output, "");
  try {
    const result = spawnSync(
      process.execPath,
      [path.resolve("dist/restore.cjs")],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          "INPUT_FORCE-PATH-STYLE": "true",
          "INPUT_LOOKUP-ONLY": "true",
          "INPUT_FAIL-ON-ERROR": "true",
          "INPUT_FAIL-ON-CACHE-MISS": "false",
          GITHUB_OUTPUT: output,
        },
      },
    );
    process.stdout.write(result.stdout || "");
    process.stderr.write(result.stderr || "");
    if (result.error) throw result.error;
    if (result.status !== 0)
      throw new Error("Post-save verification lookup failed");
    const content = fs.readFileSync(output, "utf8");
    const hit = /^cache-hit<<([^\n]+)\n(true|false)\n\1/m.exec(content)?.[2];
    if (hit !== process.env.INPUT_EXPECTED)
      throw new Error(
        `Expected cache-hit=${process.env.INPUT_EXPECTED}, received ${hit}`,
      );
    console.log("Verified post-job cache policy");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    fs.rmSync(output, { force: true });
    spawnSync("docker", ["rm", "--force", "cache-post-test"], {
      stdio: "inherit",
    });
  }
}
