import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompressionMethod } from "../src/archive.js";
import { namespace, readConfig, type Snapshot, type Tier } from "../src/config.js";
import { Unavailable } from "../src/errors.js";

// A tier's storage, as the lifecycle uses it.
function storage() {
  return {
    connect: vi.fn(),
    fallback: vi.fn(),
    download: vi.fn(),
    upload: vi.fn(),
    close: vi.fn(),
  };
}
const fixture = vi.hoisted(() => ({
  inputs: {} as Record<string, string>,
  state: {} as Record<string, string>,
  outputs: {} as Record<string, string>,
  failure: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
  tiers: {} as Record<string, ReturnType<typeof storage>>,
  opened: [] as string[],
  pack: vi.fn(),
  unpack: vi.fn(),
  cleanup: vi.fn(),
}));
vi.mock("@actions/core", () => ({
  getInput: (name: string) => fixture.inputs[name] || "",
  getState: (name: string) => fixture.state[name] || "",
  saveState: (name: string, value: string) => {
    fixture.state[name] = value;
  },
  setOutput: (name: string, value: string) => {
    fixture.outputs[name] = value;
  },
  setFailed: fixture.failure,
  warning: fixture.warning,
  info: fixture.info,
}));
vi.mock("../src/storage.js", () => ({
  createStorage: (_config: unknown, tier: Tier) => {
    fixture.opened.push(tier.name);
    const found = fixture.tiers[tier.name];
    if (!found) throw new Error(`No storage for tier ${tier.name}`);
    return found;
  },
}));
vi.mock("../src/archive.js", () => ({
  CompressionMethod: { Gzip: "gzip", Zstd: "zstd" },
  temporaryDirectory: async () => "/test/temporary",
  pack: fixture.pack,
  unpack: fixture.unpack,
  cleanup: fixture.cleanup,
}));

import { post, restore, execute, save } from "../src/lifecycle.js";

function tier(name: string): ReturnType<typeof storage> {
  const created = storage();
  created.connect.mockResolvedValue(undefined);
  created.fallback.mockResolvedValue(undefined);
  created.download.mockResolvedValue(undefined);
  created.upload.mockResolvedValue(true);
  fixture.tiers[name] = created;
  return created;
}
const unreachable = () => new Unavailable("No connection (ECONNREFUSED)", new Error("refused"));
const denied = () => Object.assign(new Error("denied"), { $metadata: { httpStatusCode: 403 } });
const message = (mock: typeof fixture.info) => mock.mock.calls.map(([text]) => String(text));

beforeEach(() => {
  vi.clearAllMocks();
  fixture.inputs = {
    bucket: "test-cache-bucket",
    region: "us-east-1",
    path: ".cache",
    key: "original",
    "save-if": "false",
  };
  fixture.state = {};
  fixture.outputs = {};
  fixture.tiers = {};
  fixture.opened = [];
  tier("default");
  fixture.pack.mockResolvedValue("/test/temporary/archive");
  fixture.unpack.mockResolvedValue(undefined);
  fixture.cleanup.mockResolvedValue(undefined);
  vi.stubEnv("GITHUB_REPOSITORY", "owner/repo");
});
afterEach(() => vi.unstubAllEnvs());

describe("automatic cache lifecycle", () => {
  it("reevaluates the post-job save decision while freezing the original paths and key", async () => {
    await restore(true);
    expect(fixture.pack).not.toHaveBeenCalled();
    fixture.inputs["save-if"] = "true";
    fixture.inputs.key = "changed-after-restore";
    fixture.inputs.path = "another-path";
    await post();
    expect(fixture.pack).toHaveBeenCalledWith("/test/temporary", [".cache"], "zstd");
    expect(fixture.tiers.default!.upload).toHaveBeenCalledWith(
      "original",
      "/test/temporary/archive",
      expect.any(AbortSignal),
    );
    expect(fixture.cleanup).toHaveBeenCalledWith("/test/temporary");
    expect(fixture.state.snapshot).not.toContain("secretAccessKey");
  });
  it("does not upload when save-if is false at job cleanup", async () => {
    await restore(true);
    await post();
    expect(fixture.tiers.default!.upload).not.toHaveBeenCalled();
  });
  it("does not save on exact hits", async () => {
    fixture.tiers.default!.connect.mockResolvedValue({ key: "original", size: 1 });
    await restore(true);
    fixture.inputs["save-if"] = "true";
    await post();
    expect(fixture.outputs["cache-hit"]).toBe("true");
    expect(fixture.pack).not.toHaveBeenCalled();
  });
  it("saves the primary key after a fallback restore", async () => {
    fixture.inputs["restore-keys"] = "older";
    fixture.tiers.default!.fallback.mockResolvedValue({ key: "older", size: 1 });
    await restore(true);
    fixture.inputs["save-if"] = "true";
    await post();
    expect(fixture.outputs["cache-hit"]).toBe("false");
    expect(fixture.outputs["cache-matched-key"]).toBe("older");
    expect(fixture.tiers.default!.upload).toHaveBeenCalledWith(
      "original",
      expect.any(String),
      expect.any(AbortSignal),
    );
  });
  it("never arms an automatic save after a failed or partial restore", async () => {
    fixture.inputs["restore-keys"] = "older";
    fixture.tiers.default!.fallback.mockResolvedValue({ key: "older", size: 1 });
    fixture.unpack.mockRejectedValue(new Error("archive failed"));
    await restore(true);
    fixture.inputs["save-if"] = "true";
    await post();
    expect(fixture.state.snapshot).toBeUndefined();
    expect(fixture.tiers.default!.upload).not.toHaveBeenCalled();
    expect(fixture.warning).toHaveBeenCalled();
  });
  it("lookup-only neither extracts nor saves", async () => {
    fixture.inputs["lookup-only"] = "true";
    fixture.tiers.default!.connect.mockResolvedValue({ key: "original", size: 1 });
    await restore(true);
    fixture.inputs["save-if"] = "true";
    await post();
    expect(fixture.tiers.default!.download).not.toHaveBeenCalled();
    expect(fixture.tiers.default!.upload).not.toHaveBeenCalled();
  });
  it("restore-only does not register state for cleanup", async () => {
    await restore(false);
    expect(fixture.state).toEqual({});
  });
  it("reports a required miss as a failure without arming save", async () => {
    fixture.inputs["fail-on-cache-miss"] = "true";
    await restore(true);
    expect(fixture.failure).toHaveBeenCalled();
    expect(fixture.state.snapshot).toBeUndefined();
  });
  it("fails invalid input regardless of fail-on-error", async () => {
    fixture.inputs.bucket = "";
    await restore(true);
    expect(fixture.failure).toHaveBeenCalled();
    expect(fixture.tiers.default!.connect).not.toHaveBeenCalled();
  });
  it("empty save paths cause no S3 upload", async () => {
    await restore(true);
    fixture.inputs["save-if"] = "true";
    fixture.pack.mockResolvedValue(undefined);
    await post();
    expect(fixture.tiers.default!.upload).not.toHaveBeenCalled();
  });
  it("does not expose malformed saved state in failure messages", async () => {
    fixture.inputs["save-if"] = "true";
    fixture.state.snapshot = "secret private config";
    await execute(post);
    expect(fixture.failure).toHaveBeenCalledWith("Bucket cache action failed: SyntaxError");
  });
  it("stores a validated snapshot of configuration without authentication tokens", async () => {
    await restore(true);
    const config = readConfig((name) => fixture.inputs[name] || "", {
      GITHUB_REPOSITORY: "owner/repo",
    });
    const expected: Snapshot = {
      config,
      compression: CompressionMethod.Zstd,
      namespace: namespace(config, CompressionMethod.Zstd),
      matchedKey: "",
      matchedTier: "",
    };
    expect(JSON.parse(fixture.state.snapshot!)).toEqual(expected);
  });
});

describe("tiered cache lifecycle", () => {
  const hot = `- name: hot
  bucket: hot-cache
  region: us-east-1
  endpoint: http://127.0.0.1:9000
  force-path-style: true
  role-to-assume: arn:aws:iam::123456789012:role/hot
`;
  const cold = `- name: cold
  bucket: cold-cache
  region: us-east-1
  role-to-assume: arn:aws:iam::123456789012:role/cold
`;
  let tiers: Record<"hot" | "cold", ReturnType<typeof storage>>;
  beforeEach(() => {
    fixture.inputs = { path: ".cache", key: "original", "save-if": "false", tiers: hot + cold };
    fixture.tiers = {};
    tiers = { hot: tier("hot"), cold: tier("cold") };
  });
  async function restoreThenSave() {
    await restore(true);
    fixture.inputs["save-if"] = "true";
    await post();
  }

  it("restores an exact hit from a colder tier over a restore-key match in a hotter one", async () => {
    fixture.inputs["restore-keys"] = "older";
    tiers.hot.fallback.mockResolvedValue({ key: "older", size: 1 });
    tiers.cold.connect.mockResolvedValue({ key: "original", size: 1 });
    await restore(true);
    expect(tiers.hot.connect).toHaveBeenCalledWith(expect.any(AbortSignal), true);
    expect(tiers.hot.fallback).not.toHaveBeenCalled();
    expect(tiers.cold.download).toHaveBeenCalled();
    expect(tiers.hot.download).not.toHaveBeenCalled();
    expect(fixture.outputs).toMatchObject({
      "cache-hit": "true",
      "cache-matched-key": "original",
      tier: "cold",
    });
    expect(message(fixture.info)).toContain("Bucket cache restored from tier cold (1 MiB)");
  });
  it("tries each restore key in every tier before the next, once every tier missed the exact key", async () => {
    fixture.inputs["restore-keys"] = "lock-a/\nany/";
    const held: Record<string, Record<string, string>> = {
      hot: { "any/": "any/hot" },
      cold: { "lock-a/": "lock-a/cold" },
    };
    for (const [name, created] of Object.entries(tiers))
      created.fallback.mockImplementation(async (prefix: string) => {
        const key = held[name]![prefix];
        return key && { key, size: 1 };
      });
    await restore(true);
    expect(tiers.hot.fallback.mock.calls.map(([prefix]) => prefix)).toEqual(["lock-a/"]);
    expect(tiers.cold.fallback.mock.calls.map(([prefix]) => prefix)).toEqual(["lock-a/"]);
    expect(tiers.cold.connect.mock.invocationCallOrder[0]).toBeLessThan(
      tiers.hot.fallback.mock.invocationCallOrder[0]!,
    );
    expect(tiers.hot.fallback.mock.invocationCallOrder[0]).toBeLessThan(
      tiers.cold.fallback.mock.invocationCallOrder[0]!,
    );
    expect(fixture.outputs).toMatchObject({
      "cache-hit": "false",
      "cache-matched-key": "lock-a/cold",
      tier: "cold",
    });
  });
  it("takes a restore key's match from the hotter tier when both hold one", async () => {
    fixture.inputs["restore-keys"] = "any/";
    tiers.hot.fallback.mockResolvedValue({ key: "any/hot", size: 1 });
    tiers.cold.fallback.mockResolvedValue({ key: "any/cold", size: 1 });
    await restore(true);
    expect(tiers.cold.fallback).not.toHaveBeenCalled();
    expect(fixture.outputs.tier).toBe("hot");
  });
  it("leaves the colder tiers alone once a hotter one holds the exact key", async () => {
    tiers.hot.connect.mockResolvedValue({ key: "original", size: 1 });
    await restore(true);
    expect(tiers.cold.connect).not.toHaveBeenCalled();
    expect(fixture.outputs.tier).toBe("hot");
  });
  it("misses with an empty tier output when no tier holds a match", async () => {
    await restore(true);
    expect(fixture.outputs).toMatchObject({
      "cache-hit": "false",
      "cache-matched-key": "",
      tier: "",
    });
    expect(JSON.parse(fixture.state.snapshot!)).toMatchObject({ matchedKey: "", matchedTier: "" });
  });
  it("passes over a tier it can't reach, saying which and why, and restores from the next", async () => {
    tiers.hot.connect.mockRejectedValue(unreachable());
    tiers.cold.connect.mockResolvedValue({ key: "original", size: 1 });
    await restore(true);
    expect(fixture.warning).toHaveBeenCalledWith("Tier hot skipped: No connection (ECONNREFUSED)");
    expect(fixture.failure).not.toHaveBeenCalled();
    expect(fixture.outputs.tier).toBe("cold");
  });
  it("names the hottest tier that answered, hit or miss, for tools that take one bucket", async () => {
    tiers.cold.connect.mockResolvedValue({ key: "original", size: 1 });
    await restore(true);
    expect(fixture.outputs).toMatchObject({ tier: "cold", "first-tier": "hot" });
    tiers.hot.connect.mockRejectedValue(unreachable());
    await restore(true);
    expect(fixture.outputs).toMatchObject({ tier: "cold", "first-tier": "cold" });
    tiers.hot.connect.mockRejectedValue(denied());
    tiers.cold.connect.mockResolvedValue(undefined);
    await restore(true);
    expect(fixture.outputs).toMatchObject({ tier: "", "first-tier": "cold" });
    tiers.cold.connect.mockRejectedValue(unreachable());
    await restore(true);
    expect(fixture.outputs["first-tier"]).toBe("");
  });
  it("fails a restore no tier could answer as a single bucket's, only with fail-on-error", async () => {
    tiers.hot.connect.mockRejectedValue(unreachable());
    tiers.cold.connect.mockRejectedValue(unreachable());
    await restore(true);
    expect(fixture.warning).toHaveBeenCalledWith(
      "Bucket cache restore failed: No cache tier was available",
    );
    expect(fixture.state.snapshot).toBeUndefined();
    expect(fixture.failure).not.toHaveBeenCalled();
    fixture.inputs["fail-on-error"] = "true";
    await restore(true);
    expect(fixture.failure).toHaveBeenCalledWith(
      "Bucket cache restore failed: No cache tier was available",
    );
  });
  it("warns of another error in a tier and asks the next, or fails with fail-on-error", async () => {
    tiers.hot.connect.mockRejectedValue(denied());
    tiers.cold.connect.mockResolvedValue({ key: "original", size: 1 });
    await restore(true);
    expect(fixture.warning).toHaveBeenCalledWith(
      "Bucket cache restore failed: Error, HTTP 403 (tier hot)",
    );
    expect(fixture.outputs.tier).toBe("cold");
    fixture.inputs["fail-on-error"] = "true";
    fixture.outputs = {};
    await restore(true);
    expect(fixture.failure).toHaveBeenCalledWith(
      "Bucket cache restore failed: Error, HTTP 403 (tier hot)",
    );
    expect(fixture.outputs.tier).toBe("");
  });
  it("names the tier a failed download came from, without asking another", async () => {
    tiers.hot.connect.mockResolvedValue({ key: "original", size: 1 });
    tiers.hot.download.mockRejectedValue(denied());
    await restore(true);
    expect(fixture.warning).toHaveBeenCalledWith(
      "Bucket cache restore failed: Error, HTTP 403 (tier hot)",
    );
    expect(tiers.cold.connect).not.toHaveBeenCalled();
    expect(fixture.state.snapshot).toBeUndefined();
  });
  it("promotes a colder tier's exact hit to the hotter ones, and leaves the source alone", async () => {
    tiers.cold.connect.mockResolvedValue({ key: "original", size: 1 });
    await restoreThenSave();
    expect(fixture.pack).toHaveBeenCalledTimes(1);
    expect(tiers.hot.upload).toHaveBeenCalledWith(
      "original",
      "/test/temporary/archive",
      expect.any(AbortSignal),
    );
    expect(tiers.cold.upload).not.toHaveBeenCalled();
    expect(message(fixture.info)).toContain("Bucket cache saved to tier hot");
  });
  it("writes a hotter tier's exact hit through to colder ones that lack it", async () => {
    tiers.hot.connect.mockResolvedValue({ key: "original", size: 1 });
    await restoreThenSave();
    expect(tiers.cold.connect).toHaveBeenCalledTimes(1);
    expect(tiers.cold.upload).toHaveBeenCalled();
    expect(tiers.hot.upload).not.toHaveBeenCalled();
  });
  it("packs nothing when every other tier already holds an exact hit", async () => {
    tiers.hot.connect.mockResolvedValue({ key: "original", size: 1 });
    await restore(true);
    tiers.cold.connect.mockResolvedValue({ key: "original", size: 1 });
    fixture.inputs["save-if"] = "true";
    await post();
    expect(fixture.pack).not.toHaveBeenCalled();
    expect(message(fixture.info)).toContain(
      "Bucket cache already saved by another job in tier cold",
    );
  });
  it("writes a miss through to every tier at once, and one tier's failure stops no other", async () => {
    let started = 0;
    const order: string[] = [];
    for (const [name, created] of Object.entries(tiers))
      created.upload.mockImplementation(async () => {
        started++;
        await new Promise((resolve) => setTimeout(resolve, 5));
        order.push(`${name} saw ${started}`);
        if (name === "hot") throw denied();
        return true;
      });
    await restoreThenSave();
    expect(order.sort()).toEqual(["cold saw 2", "hot saw 2"]);
    expect(fixture.warning).toHaveBeenCalledWith(
      "Bucket cache save failed: Error, HTTP 403 (tier hot)",
    );
    expect(message(fixture.info)).toContain("Bucket cache saved to tier cold");
    expect(fixture.failure).not.toHaveBeenCalled();
    fixture.inputs = { ...fixture.inputs, "fail-on-error": "true", "save-if": "false" };
    fixture.state = {};
    await restoreThenSave();
    expect(fixture.failure).toHaveBeenCalledWith(
      "Bucket cache save failed: Error, HTTP 403 (tier hot)",
    );
    expect(tiers.cold.upload).toHaveBeenCalledTimes(2);
  });
  it("doesn't upload to a tier that came to hold the key since restoring", async () => {
    await restore(true);
    tiers.cold.connect.mockResolvedValue({ key: "original", size: 1 });
    fixture.inputs["save-if"] = "true";
    await post();
    expect(tiers.cold.upload).not.toHaveBeenCalled();
    expect(tiers.hot.upload).toHaveBeenCalled();
  });
  it("restores from a tier with save: false but never saves to it", async () => {
    fixture.inputs.tiers = hot + cold + "  save: false\n";
    tiers.cold.connect.mockResolvedValue({ key: "original", size: 1 });
    await restoreThenSave();
    expect(fixture.outputs.tier).toBe("cold");
    expect(tiers.hot.upload).toHaveBeenCalled();
    expect(tiers.cold.upload).not.toHaveBeenCalled();
    fixture.inputs.tiers =
      hot.replace("role-to-assume", "save: false\n  role-to-assume") + cold + "  save: false\n";
    fixture.state = {};
    fixture.inputs["save-if"] = "false";
    tiers.cold.connect.mockResolvedValue(undefined);
    await restoreThenSave();
    expect(message(fixture.info)).toContain("Skipping cache save: no present tier saves");
    expect(fixture.pack).toHaveBeenCalledTimes(1);
  });
  it("skips a tier whose bucket the runner's environment doesn't give, saying which variable", async () => {
    vi.stubEnv("RR_S3_BUCKET", "");
    fixture.inputs.tiers = hot.replace("bucket: hot-cache", "bucket-env: RR_S3_BUCKET") + cold;
    tiers.cold.connect.mockResolvedValue({ key: "original", size: 1 });
    await restoreThenSave();
    expect(fixture.opened).not.toContain("hot");
    expect(message(fixture.info)).toContain("Tier hot skipped: RR_S3_BUCKET is not set");
    expect(fixture.outputs.tier).toBe("cold");
    expect(fixture.pack).not.toHaveBeenCalled();
  });
  it("skips a tier whose variable holds a malformed value with a warning, or fails with fail-on-error", async () => {
    vi.stubEnv("RR_S3_BUCKET", "Not_A_Bucket");
    fixture.inputs.tiers = hot.replace("bucket: hot-cache", "bucket-env: RR_S3_BUCKET") + cold;
    tiers.cold.connect.mockResolvedValue({ key: "original", size: 1 });
    await restore(true);
    const reason =
      "RR_S3_BUCKET doesn't hold a valid bucket: Invalid bucket name for the selected provider";
    expect(fixture.warning).toHaveBeenCalledWith(`Tier hot skipped: ${reason}`);
    expect(fixture.opened).not.toContain("hot");
    expect(fixture.failure).not.toHaveBeenCalled();
    expect(fixture.outputs.tier).toBe("cold");
    expect(JSON.stringify(fixture.warning.mock.calls)).not.toContain("Not_A_Bucket");
    fixture.inputs["fail-on-error"] = "true";
    fixture.outputs = {};
    await restore(true);
    expect(fixture.failure).toHaveBeenCalledWith(
      `Bucket cache restore failed: Tier hot: ${reason}`,
    );
    expect(fixture.outputs.tier).toBe("");
  });
  it("takes a tier's bucket from the runner's environment when it's set", async () => {
    vi.stubEnv("RR_S3_BUCKET", "fleet-cache");
    fixture.inputs.tiers = hot.replace("bucket: hot-cache", "bucket-env: RR_S3_BUCKET") + cold;
    await restore(true);
    const snapshot = JSON.parse(fixture.state.snapshot!) as Snapshot;
    expect(snapshot.config.tiers.map(({ name, bucket }) => [name, bucket])).toEqual([
      ["hot", "fleet-cache"],
      ["cold", "cold-cache"],
    ]);
  });
  it("skips a tier it can't reach at save, and fails a miss no tier could save as before", async () => {
    await restore(true);
    tiers.hot.connect.mockRejectedValue(unreachable());
    fixture.inputs["save-if"] = "true";
    await post();
    expect(fixture.warning).toHaveBeenCalledWith("Tier hot skipped: No connection (ECONNREFUSED)");
    expect(tiers.cold.upload).toHaveBeenCalled();
    expect(fixture.warning).toHaveBeenCalledTimes(1);
    tiers.cold.connect.mockRejectedValue(unreachable());
    await post();
    expect(fixture.warning).toHaveBeenLastCalledWith(
      "Bucket cache save failed: No cache tier was available",
    );
  });
  it("saves through every tier from the save entry point", async () => {
    tiers.hot.connect.mockResolvedValue({ key: "original", size: 1 });
    await save();
    expect(tiers.hot.upload).not.toHaveBeenCalled();
    expect(tiers.cold.upload).toHaveBeenCalled();
  });
  it("names the inputs given beside tiers, and the tier and field of a bad one", async () => {
    fixture.inputs.bucket = "test-cache-bucket";
    await restore(true);
    expect(fixture.failure).toHaveBeenCalledWith(
      "Invalid cache configuration: Give tiers or the single-bucket inputs, not both; remove bucket",
    );
    delete fixture.inputs.bucket;
    fixture.inputs.tiers = hot + cold.replace("us-east-1", "");
    await restore(true);
    expect(fixture.failure).toHaveBeenLastCalledWith(
      "Invalid cache configuration: Tier 2 (cold): region: Invalid input: expected string, received null",
    );
    expect(fixture.opened).toEqual([]);
  });
});

describe("one bucket, as before tiers", () => {
  it("reports the bucket's own failure, without a tier", async () => {
    fixture.tiers.default!.connect.mockRejectedValue(
      new Unavailable("Sign-in failed (CacheError)", new Error("RUNNER_S3_SECRET_ACCESS_KEY")),
    );
    await restore(true);
    expect(fixture.warning).toHaveBeenCalledWith("Bucket cache restore failed: Error");
    expect(fixture.warning).toHaveBeenCalledTimes(1);
    expect(fixture.outputs.tier).toBe("");
    expect(fixture.outputs["first-tier"]).toBe("");
  });
  it("names its one tier default, and keeps the default's connections retried", async () => {
    fixture.tiers.default!.connect.mockResolvedValue({ key: "original", size: 1 });
    await restore(true);
    expect(fixture.tiers.default!.connect).toHaveBeenCalledWith(expect.any(AbortSignal), false);
    expect(fixture.outputs.tier).toBe("default");
    expect(fixture.outputs["first-tier"]).toBe("default");
    expect(message(fixture.info)).toContain("Bucket cache restored (1 MiB)");
  });
});
