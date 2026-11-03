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
  type Tier,
} from "./config.js";
import { temporaryDirectory, pack, unpack, cleanup } from "./archive.js";
import { createStorage, type Entry, type Storage } from "./storage.js";
import { CacheError, ConfigurationError, Unavailable, describe } from "./errors.js";

function configuration(): Config | undefined {
  try {
    return readConfig();
  } catch (error) {
    core.setFailed(
      error instanceof ConfigurationError
        ? `Invalid cache configuration: ${error.message}`
        : "Invalid cache configuration; check the action input names, values, and GITHUB_REPOSITORY.",
    );
    return undefined;
  }
}

function report(phase: string, error: unknown, fatal: boolean): void {
  const message = `Bucket cache ${phase} failed: ${describe(error)}`;
  if (fatal) core.setFailed(message);
  else core.warning(message);
}

interface Open {
  tier: Tier;
  storage: Storage;
}
// What saving came to in one tier.
type Outcome = "saved" | "held" | "lacking";

// The present tiers one phase uses, hot first, each with its storage open. With
// several tiers, one that can't be signed in to or reached is passed over; with
// one, its failure is the phase's, as a single bucket's always was.
class Tiers {
  readonly open: Open[];
  readonly passed = new Set<Open>();
  readonly several: boolean;
  constructor(
    readonly config: Config,
    namespace: string,
    tiers = config.tiers,
  ) {
    this.several = config.tiers.length + config.skipped.length > 1;
    this.open = tiers.map((tier) => ({ tier, storage: createStorage(config, tier, namespace) }));
  }
  // Says which tiers this runner skips, and why: one whose variables aren't set,
  // as on a runner outside the fleet; one whose variable holds a malformed value
  // with a warning, or failing the step with fail-on-error.
  announce(): void {
    if (!this.several) return;
    for (const { name, reason, malformed } of this.config.skipped) {
      if (malformed && this.config.failOnError) throw new CacheError(`Tier ${name}: ${reason}`);
      if (malformed) core.warning(`Tier ${name} skipped: ${reason}`);
      else core.info(`Tier ${name} skipped: ${reason}`);
    }
  }
  close(): void {
    for (const { storage } of this.open) storage.close();
  }
  // Why no tier can answer: one tier's own reason, else that none could.
  none(): CacheError {
    const skipped = this.config.skipped[0];
    return new CacheError(
      !this.several && skipped ? skipped.reason : "No cache tier was available",
    );
  }
  // A message names the tier only when there is another to tell it from.
  in(preposition: string, open: Open): string {
    return this.several ? ` ${preposition} tier ${open.tier.name}` : "";
  }
  named(open: Open, error: unknown): unknown {
    return this.several ? new CacheError(`${describe(error)} (tier ${open.tier.name})`) : error;
  }
  skip(open: Open, error: Unavailable): void {
    core.warning(`Tier ${open.tier.name} skipped: ${error.message}`);
    this.passed.add(open);
  }
  // The hottest tier that answered: restoring asks each tier hotter than a match
  // before it, so the first one not passed over has answered.
  first(): Open | undefined {
    return this.open.find((open) => !this.passed.has(open));
  }

  // Restoring: the exact key in each tier, hot to cold, then the first restore
  // key in each tier, then the second, so a more specific key beats a hotter
  // tier. A tier that fails is passed over while another is left; an error other
  // than being unreachable fails the job with fail-on-error, per tier.
  async find(signal: AbortSignal): Promise<(Open & { entry: Entry }) | undefined> {
    this.announce();
    if (!this.open.length) throw this.none();
    const attempt = async (open: Open, step: () => Promise<Entry | undefined>) => {
      try {
        return await step();
      } catch (error) {
        const unavailable = error instanceof Unavailable;
        if (!this.several) throw unavailable ? error.cause : error;
        if (unavailable) this.skip(open, error);
        else if (this.config.failOnError) throw this.named(open, error);
        else {
          report("restore", this.named(open, error), false);
          this.passed.add(open);
        }
        if (this.open.every((tier) => this.passed.has(tier))) throw this.none();
        return undefined;
      }
    };
    const usable = () => this.open.filter((open) => !this.passed.has(open));
    for (const open of usable()) {
      const entry = await attempt(open, () => open.storage.connect(signal, this.several));
      if (entry) return { ...open, entry };
    }
    for (const prefix of this.config.restoreKeys)
      for (const open of usable()) {
        const entry = await attempt(open, () => open.storage.fallback(prefix, signal));
        if (entry) return { ...open, entry };
      }
    return undefined;
  }
}

export async function restore(registerPost: boolean): Promise<void> {
  if (registerPost) core.saveState("phase", "post");
  core.setOutput("cache-hit", "false");
  core.setOutput("cache-matched-key", "");
  core.setOutput("tier", "");
  core.setOutput("first-tier", "");
  const config = configuration();
  if (!config) return;
  core.setOutput("cache-primary-key", config.key);
  let tiers: Tiers | undefined;
  let directory: string | undefined;
  try {
    const compression = CompressionMethod.Zstd;
    const prefix = namespace(config, compression);
    tiers = new Tiers(config, prefix);
    const signal = AbortSignal.timeout(config.timeoutSeconds * 1000);
    const found = await tiers.find(signal);
    core.setOutput("first-tier", tiers.first()?.tier.name || "");
    if (found && !config.lookupOnly) {
      directory = await temporaryDirectory();
      const archive = path.join(directory, "download");
      try {
        await found.storage.download(found.entry, archive, signal);
        await unpack(archive, compression);
      } catch (error) {
        throw tiers.named(found, error);
      }
    }
    if (!found && config.failOnMiss) throw new CacheError("No cache matched the requested keys");
    core.setOutput("cache-hit", String(found?.entry.key === config.key));
    core.setOutput("cache-matched-key", found?.entry.key || "");
    core.setOutput("tier", found?.tier.name || "");
    core.info(
      found
        ? `Bucket cache ${config.lookupOnly ? "found" : "restored"}${tiers.in("from", found)} (${Math.ceil(found.entry.size / 1024 ** 2)} MiB)`
        : "Bucket cache miss",
    );
    // Arm the post phase only after a clean miss or a complete restore. No
    // credentials or OIDC tokens are stored in action state.
    if (registerPost && !config.lookupOnly) {
      const snapshot: Snapshot = {
        config,
        compression,
        namespace: prefix,
        matchedKey: found?.entry.key || "",
        matchedTier: found?.tier.name || "",
      };
      core.saveState("snapshot", JSON.stringify(snapshot));
    }
  } catch (error) {
    report("restore", error, config.failOnError || config.failOnMiss);
  } finally {
    tiers?.close();
    if (directory) await cleanup(directory);
  }
}

// Saving writes through: to every present tier that saves and doesn't hold the
// exact key yet, at once. A hit from a colder tier is promoted to the hotter
// ones, and the colder ones stay complete for runners the hot one can't serve.
async function saveSnapshot(snapshot: Snapshot): Promise<void> {
  const { config } = snapshot;
  const exact = snapshot.matchedKey === config.key;
  const targets = config.tiers.filter(
    (tier) => tier.save && !(exact && tier.name === snapshot.matchedTier),
  );
  if (config.lookupOnly || (exact && !targets.length)) {
    core.info("Skipping cache save: exact hit or lookup-only mode");
    return;
  }
  if (!targets.length && config.tiers.length) {
    core.info("Skipping cache save: no present tier saves");
    return;
  }
  const tiers = new Tiers(config, snapshot.namespace, targets);
  let directory: string | undefined;
  // Tiers that hold the key once this phase is done, the exact hit's among them.
  let held = exact ? 1 : 0;
  const settle = (open: Open, result: PromiseSettledResult<Outcome>) => {
    if (result.status === "rejected") {
      const error: unknown = result.reason;
      if (error instanceof Unavailable && tiers.several) tiers.skip(open, error);
      else
        report(
          "save",
          tiers.named(open, error instanceof Unavailable ? error.cause : error),
          config.failOnError,
        );
      return undefined;
    }
    if (result.value === "saved") core.info(`Bucket cache saved${tiers.in("to", open)}`);
    if (result.value === "held")
      core.info(`Bucket cache already saved by another job${tiers.in("in", open)}`);
    if (result.value !== "lacking") held++;
    return result.value;
  };
  try {
    tiers.announce();
    if (!tiers.open.length) throw tiers.none();
    let lacking = tiers.open;
    if (exact) {
      // Ask the other tiers first, and pack the paths only if one lacks the key.
      const signal = AbortSignal.timeout(config.timeoutSeconds * 1000);
      const answers = await Promise.allSettled(
        lacking.map(async (open): Promise<Outcome> =>
          (await open.storage.connect(signal, tiers.several)) ? "held" : "lacking",
        ),
      );
      lacking = lacking.filter((open, index) => settle(open, answers[index]!) === "lacking");
      if (!lacking.length) return;
    }
    directory = await temporaryDirectory();
    const archive = await pack(directory, config.paths, snapshot.compression);
    if (!archive) {
      core.info("Skipping cache save: no paths matched");
      return;
    }
    const signal = AbortSignal.timeout(config.timeoutSeconds * 1000);
    const results = await Promise.allSettled(
      lacking.map(async (open): Promise<Outcome> => {
        if (!exact && (await open.storage.connect(signal, tiers.several))) return "held";
        return (await open.storage.upload(config.key, archive, signal)) ? "saved" : "held";
      }),
    );
    lacking.forEach((open, index) => settle(open, results[index]!));
    if (!held && tiers.passed.size === tiers.open.length)
      report("save", tiers.none(), config.failOnError);
  } catch (error) {
    report("save", error, config.failOnError);
  } finally {
    tiers.close();
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
    matchedTier: "",
  });
}

export async function execute(run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (error) {
    core.setFailed(`Bucket cache action failed: ${describe(error)}`);
  }
}
