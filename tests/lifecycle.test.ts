import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompressionMethod } from "@actions/cache/lib/internal/constants.js";
import { namespace, readConfig, type Snapshot } from "../src/config.js";

const fixture = vi.hoisted(() => ({
  inputs: {} as Record<string, string>,
  state: {} as Record<string, string>,
  outputs: {} as Record<string, string>,
  failure: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
  lookup: vi.fn(),
  download: vi.fn(),
  upload: vi.fn(),
  pack: vi.fn(),
  unpack: vi.fn(),
  cleanup: vi.fn(),
  destroy: vi.fn(),
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
  createStorage: () => ({
    close: fixture.destroy,
    lookup: fixture.lookup,
    download: fixture.download,
    upload: fixture.upload,
  }),
}));
vi.mock("../src/archive.js", () => ({
  temporaryDirectory: async () => "/test/temporary",
  pack: fixture.pack,
  unpack: fixture.unpack,
  cleanup: fixture.cleanup,
}));
vi.mock("@actions/cache/lib/internal/cacheUtils.js", () => ({
  getCompressionMethod: async () => "gzip",
}));
import { post, restore, execute } from "../src/lifecycle.js";

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
  fixture.lookup.mockResolvedValue(undefined);
  fixture.upload.mockResolvedValue(true);
  fixture.pack.mockResolvedValue("/test/temporary/archive");
  fixture.download.mockResolvedValue(undefined);
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
    expect(fixture.pack).toHaveBeenCalledWith(
      "/test/temporary",
      [".cache"],
      "gzip",
    );
    expect(fixture.upload).toHaveBeenCalledWith(
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
    expect(fixture.upload).not.toHaveBeenCalled();
  });
  it("does not save on exact hits", async () => {
    fixture.lookup.mockResolvedValue({ key: "original", size: 1 });
    await restore(true);
    fixture.inputs["save-if"] = "true";
    await post();
    expect(fixture.outputs["cache-hit"]).toBe("true");
    expect(fixture.pack).not.toHaveBeenCalled();
  });
  it("saves the primary key after a fallback restore", async () => {
    fixture.lookup.mockResolvedValue({ key: "older", size: 1 });
    await restore(true);
    fixture.inputs["save-if"] = "true";
    await post();
    expect(fixture.outputs["cache-hit"]).toBe("false");
    expect(fixture.outputs["cache-matched-key"]).toBe("older");
    expect(fixture.upload).toHaveBeenCalledWith(
      "original",
      expect.any(String),
      expect.any(AbortSignal),
    );
  });
  it("never arms an automatic save after a failed or partial restore", async () => {
    fixture.lookup.mockResolvedValue({ key: "older", size: 1 });
    fixture.unpack.mockRejectedValue(new Error("archive failed"));
    await restore(true);
    fixture.inputs["save-if"] = "true";
    await post();
    expect(fixture.state.snapshot).toBeUndefined();
    expect(fixture.upload).not.toHaveBeenCalled();
    expect(fixture.warning).toHaveBeenCalled();
  });
  it("lookup-only neither extracts nor saves", async () => {
    fixture.inputs["lookup-only"] = "true";
    fixture.lookup.mockResolvedValue({ key: "original", size: 1 });
    await restore(true);
    fixture.inputs["save-if"] = "true";
    await post();
    expect(fixture.download).not.toHaveBeenCalled();
    expect(fixture.upload).not.toHaveBeenCalled();
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
    expect(fixture.lookup).not.toHaveBeenCalled();
  });
  it("empty save paths cause no S3 upload", async () => {
    await restore(true);
    fixture.inputs["save-if"] = "true";
    fixture.pack.mockResolvedValue(undefined);
    await post();
    expect(fixture.upload).not.toHaveBeenCalled();
  });
  it("does not expose malformed saved state in failure messages", async () => {
    fixture.inputs["save-if"] = "true";
    fixture.state.snapshot = "secret private config";
    await execute(post);
    expect(fixture.failure).toHaveBeenCalledWith(
      "Bucket cache action failed: SyntaxError",
    );
  });
  it("stores a validated snapshot of configuration without authentication tokens", async () => {
    await restore(true);
    const config = readConfig((name) => fixture.inputs[name] || "", {
      GITHUB_REPOSITORY: "owner/repo",
    });
    const expected: Snapshot = {
      config,
      compression: CompressionMethod.Gzip,
      namespace: namespace(config, CompressionMethod.Gzip),
      matchedKey: "",
    };
    expect(JSON.parse(fixture.state.snapshot!)).toEqual(expected);
  });
});
