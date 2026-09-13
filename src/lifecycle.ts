import * as core from "@actions/core";
import path from "node:path";
import { CompressionMethod } from "./archive.js";
import {
  readConfig,
  namespace,
  snapshotSchema,
  booleanInput,
  type Config,
  type Snapshot,
} from "./config.js";
import { temporaryDirectory, pack, unpack, cleanup } from "./archive.js";
import { createStorage } from "./storage.js";
import { CacheError, describe } from "./errors.js";

function configuration(): Config | undefined {
  try {
    return readConfig();
  } catch {
    core.setFailed(
      "Invalid cache configuration; check the action input names, values, and GITHUB_REPOSITORY.",
    );
    return undefined;
  }
}

function report(phase: string, error: unknown, fatal: boolean): void {
  const message = `Bucket cache ${phase} failed: ${describe(error)}`;
  if (fatal) core.setFailed(message);
  else core.warning(message);
}

export async function restore(registerPost: boolean): Promise<void> {
  if (registerPost) core.saveState("phase", "post");
  core.setOutput("cache-hit", "false");
  core.setOutput("cache-matched-key", "");
  const config = configuration();
  if (!config) return;
  core.setOutput("cache-primary-key", config.key);
  let storage: ReturnType<typeof createStorage> | undefined;
  let directory: string | undefined;
  try {
    const compression = CompressionMethod.Zstd;
    const prefix = namespace(config, compression);
    storage = createStorage(config, prefix);
    const signal = AbortSignal.timeout(config.timeoutSeconds * 1000);
    const entry = await storage.lookup(signal);
    if (entry && !config.lookupOnly) {
      directory = await temporaryDirectory();
      const archive = path.join(directory, "download");
      await storage.download(entry, archive, signal);
      await unpack(archive, compression);
    }
    if (!entry && config.failOnMiss) throw new CacheError("No cache matched the requested keys");
    core.setOutput("cache-hit", String(entry?.key === config.key));
    core.setOutput("cache-matched-key", entry?.key || "");
    core.info(
      entry
        ? `Bucket cache ${config.lookupOnly ? "found" : "restored"} (${Math.ceil(entry.size / 1024 ** 2)} MiB)`
        : "Bucket cache miss",
    );
    // Arm the post phase only after a clean miss or a complete restore. No
    // credentials or OIDC tokens are stored in action state.
    if (registerPost && !config.lookupOnly) {
      const snapshot: Snapshot = {
        config,
        compression,
        namespace: prefix,
        matchedKey: entry?.key || "",
      };
      core.saveState("snapshot", JSON.stringify(snapshot));
    }
  } catch (error) {
    report("restore", error, config.failOnError || config.failOnMiss);
  } finally {
    storage?.close();
    if (directory) await cleanup(directory);
  }
}

async function saveSnapshot(snapshot: Snapshot): Promise<void> {
  const { config } = snapshot;
  if (snapshot.matchedKey === config.key || config.lookupOnly) {
    core.info("Skipping cache save: exact hit or lookup-only mode");
    return;
  }
  let storage: ReturnType<typeof createStorage> | undefined;
  let directory: string | undefined;
  try {
    directory = await temporaryDirectory();
    const archive = await pack(directory, config.paths, snapshot.compression);
    if (!archive) {
      core.info("Skipping cache save: no paths matched");
      return;
    }
    storage = createStorage(config, snapshot.namespace);
    const saved = await storage.upload(
      config.key,
      archive,
      AbortSignal.timeout(config.timeoutSeconds * 1000),
    );
    core.info(saved ? "Bucket cache saved" : "Bucket cache already saved by another job");
  } catch (error) {
    report("save", error, config.failOnError);
  } finally {
    storage?.close();
    if (directory) await cleanup(directory);
  }
}

export async function post(): Promise<void> {
  // GitHub re-evaluates with/default expressions before executing this phase.
  // Read the save decision now, but retain the restore phase's paths and key.
  if (!booleanInput(core.getInput("save-if"), false)) {
    core.info("Skipping cache save: save-if is false");
    return;
  }
  const serialized = core.getState("snapshot");
  if (!serialized) {
    core.info("Skipping cache save: restore did not complete");
    return;
  }
  const snapshot = snapshotSchema.parse(JSON.parse(serialized));
  await saveSnapshot(snapshot);
}

export async function save(): Promise<void> {
  const config = configuration();
  if (!config) return;
  const compression = CompressionMethod.Zstd;
  await saveSnapshot({
    config,
    compression,
    namespace: namespace(config, compression),
    matchedKey: "",
  });
}

export async function execute(run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (error) {
    core.setFailed(`Bucket cache action failed: ${describe(error)}`);
  }
}
