import { afterEach, describe, expect, it, vi } from "vitest";
import * as core from "@actions/core";
import { IdentityPoolClient } from "google-auth-library";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { GcsBucket } from "../src/storage/gcs.js";
import { readConfig } from "../src/config.js";
vi.mock("@actions/core", () => ({
  setSecret: vi.fn(),
  getIDToken: vi.fn(async () => "test-oidc-token"),
}));
const endpoint = "http://127.0.0.1:9001";
function config(overrides: Record<string, string> = {}) {
  const values: Record<string, string> = {
    provider: "gcs",
    bucket: "gcs-cache",
    endpoint,
    anonymous: "true",
    path: "cache",
    key: "key",
    ...overrides,
  };
  return readConfig((key) => values[key] || "", {
    GITHUB_REPOSITORY: "owner/repo",
  });
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
async function archive(run: (file: string) => Promise<void>) {
  const dir = await mkdtemp(path.join(process.cwd(), "archive-test-"));
  try {
    const file = path.join(dir, "source");
    await writeFile(file, "contents");
    await run(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("GCS contract", () => {
  it("uses a creation precondition and handles a lost concurrent write without overwriting", async () => {
    const request = vi.fn(async (input: URL | string, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.searchParams.get("ifGenerationMatch")).toBe("0");
      expect(init?.method).toBe("POST");
      return new Response("", { status: 412 });
    });
    vi.stubGlobal("fetch", request);
    await archive(async (file) => {
      expect(
        await new GcsBucket(config()).upload(
          "key",
          file,
          8,
          "a".repeat(64),
          AbortSignal.timeout(1000),
        ),
      ).toBe(false);
    });
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("cancels the resumable session when a completion loses the generation race", async () => {
    const requests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL | string, init?: RequestInit) => {
        requests.push(init?.method || "GET");
        if (init?.method === "POST") {
          expect(new URL(String(input)).searchParams.get("ifGenerationMatch")).toBe("0");
          return new Response("", {
            status: 200,
            headers: { Location: endpoint + "/session" },
          });
        }
        if (init?.method === "DELETE") return new Response("", { status: 499 });
        return new Response("", { status: 412 });
      }),
    );
    await archive(async (file) =>
      expect(
        await new GcsBucket(config()).upload(
          "key",
          file,
          8,
          "a".repeat(64),
          AbortSignal.timeout(1000),
        ),
      ).toBe(false),
    );
    expect(requests).toEqual(["POST", "PUT", "DELETE"]);
  });
  it("queries the committed offset after lost responses and resumes the remaining bytes", async () => {
    let attempts = 0;
    const ranges: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: URL | string, init?: RequestInit) => {
        if (init?.method === "POST")
          return new Response("", {
            headers: { Location: endpoint + "/session" },
          });
        const range = new Headers(init?.headers).get("Content-Range") || "";
        ranges.push(range);
        if (range === "bytes */8")
          return new Response("", {
            status: 308,
            headers: { Range: "bytes=0-1" },
          });
        if (attempts++ < 1) throw new TypeError("test connection loss");
        expect(range).toBe("bytes 2-7/8");
        const body = init?.body;
        if (!(body instanceof Blob)) throw new Error("Expected Blob upload body");
        expect(await body.text()).toBe("ntents");
        return new Response("{}", { status: 200 });
      }),
    );
    await archive(async (file) =>
      expect(
        await new GcsBucket(config()).upload(
          "key",
          file,
          8,
          "a".repeat(64),
          AbortSignal.timeout(5000),
        ),
      ).toBe(true),
    );
    expect(ranges).toContain("bytes */8");
  });
  it("pins downloads to the observed object generation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL | string, init?: RequestInit) => {
        const url = new URL(String(input));
        expect(url.searchParams.get("generation")).toBe("123");
        expect(url.searchParams.get("alt")).toBe("media");
        expect(new Headers(init?.headers).get("range")).toBe("bytes=0-7");
        return new Response("contents", {
          status: 206,
          headers: { "Content-Range": "bytes 0-7/8", "Content-Length": "8" },
        });
      }),
    );
    const result = await new GcsBucket(config()).read(
      { key: "cache/key", version: "123", size: 8, sha256: "a".repeat(64) },
      0,
      7,
      AbortSignal.timeout(1000),
    );
    let content = "";
    for await (const chunk of result.body) content += Buffer.from(chunk).toString();
    expect(content).toBe("contents");
  });
  it("passes pagination tokens without changing the requested prefix", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL | string) => {
        const url = new URL(String(input));
        expect(url.searchParams.get("pageToken")).toBe("next");
        expect(url.searchParams.get("prefix")).toBe("cache/tools/");
        return Response.json({
          items: [
            {
              name: "cache/tools/key",
              size: "8",
              generation: "1",
              updated: "2026-09-12T00:00:00Z",
            },
          ],
          nextPageToken: "last",
        });
      }),
    );
    expect(
      await new GcsBucket(config()).list("cache/tools/", "next", AbortSignal.timeout(1000)),
    ).toEqual({
      items: [
        {
          key: "cache/tools/key",
          modified: Date.parse("2026-09-12T00:00:00Z"),
        },
      ],
      token: "last",
    });
  });
  it("obtains a fresh GitHub token for the configured workload identity audience", async () => {
    const provider = "projects/123/locations/global/workloadIdentityPools/github/providers/github";
    const bucket = new GcsBucket(
      config({
        anonymous: "false",
        "workload-identity-provider": provider,
        "service-account": "cache@project.iam.gserviceaccount.com",
      }),
    );
    expect(bucket.auth).toBeInstanceOf(IdentityPoolClient);
    if (!(bucket.auth instanceof IdentityPoolClient)) throw new Error("Wrong auth client");
    expect(await bucket.auth.retrieveSubjectToken()).toBe("test-oidc-token");
    expect(core.getIDToken).toHaveBeenCalledWith(`//iam.googleapis.com/${provider}`);
  });
  it("refuses anonymous access to a non-loopback host or mixed provider authentication", () => {
    expect(() => config({ endpoint: "https://storage.googleapis.com" })).toThrow();
    expect(() => config({ "role-to-assume": "arn:aws:iam::123456789012:role/cache" })).toThrow();
    expect(() => config({ anonymous: "false", bucket: "valid_gcs_bucket" })).not.toThrow();
  });
});
