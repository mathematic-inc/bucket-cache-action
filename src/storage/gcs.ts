import { GoogleAuth, IdentityPoolClient } from "google-auth-library";
import * as core from "@actions/core";
import { openAsBlob } from "node:fs";
import { Readable } from "node:stream";
import { setTimeout } from "node:timers/promises";
import { z } from "zod";
import { CacheError, status } from "../errors.js";
import type { Config } from "../config.js";
import type { Bucket, Entry, Page, Range } from "../storage.js";

const metadataSchema = z.object({
  name: z.string(),
  size: z.string().regex(/^\d+$/),
  generation: z.string().regex(/^\d+$/),
  updated: z.string(),
  metadata: z.record(z.string(), z.string()).optional(),
});
const listSchema = z.object({
  items: z.array(metadataSchema).optional(),
  nextPageToken: z.string().optional(),
});

class GcsError extends CacheError {
  constructor(readonly code: number) {
    super(`GCS request failed with HTTP ${code}`);
  }
}

export class GcsBucket implements Bucket {
  readonly endpoint: URL;
  readonly auth: GoogleAuth | IdentityPoolClient | undefined;
  constructor(readonly config: Config) {
    this.endpoint = new URL(
      config.endpoint || "https://storage.googleapis.com",
    );
    const scopes = ["https://www.googleapis.com/auth/devstorage.read_write"];
    if (config.anonymous) this.auth = undefined;
    else if (config.workloadIdentityProvider) {
      const audience = `//iam.googleapis.com/${config.workloadIdentityProvider}`;
      this.auth = new IdentityPoolClient({
        type: "external_account",
        audience,
        subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
        token_url: "https://sts.googleapis.com/v1/token",
        service_account_impersonation_url: config.serviceAccount
          ? `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${config.serviceAccount}:generateAccessToken`
          : undefined,
        subject_token_supplier: {
          getSubjectToken: () => core.getIDToken(audience),
        },
        scopes,
      });
    } else
      this.auth = new GoogleAuth({
        keyFilename: config.credentialsFile || undefined,
        scopes,
      });
  }

  private url(key?: string, upload = false): URL {
    const prefix = upload ? "/upload/storage/v1" : "/storage/v1";
    return new URL(
      `${prefix}/b/${encodeURIComponent(this.config.bucket)}/o${key === undefined ? "" : `/${encodeURIComponent(key)}`}`,
      this.endpoint,
    );
  }

  private async request(
    url: URL,
    init: RequestInit,
    signal: AbortSignal,
    accepted: number[] = [],
    retry = true,
  ): Promise<Response> {
    if (url.origin !== this.endpoint.origin)
      throw new CacheError(
        "GCS response tried to change the configured endpoint",
      );
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted();
      const headers = new Headers(init.headers);
      const authHeaders = await this.auth?.getRequestHeaders(url);
      authHeaders?.forEach((value, name) => headers.set(name, value));
      let response: Response;
      try {
        response = await fetch(url, {
          ...init,
          headers,
          signal,
          redirect: "manual",
        });
      } catch (error) {
        if (!retry || signal.aborted || attempt === 2) throw error;
        await setTimeout(250 * (attempt + 1), undefined, { signal });
        continue;
      }
      if (response.ok || accepted.includes(response.status)) return response;
      await response.body?.cancel();
      if (
        !retry ||
        attempt === 2 ||
        ![408, 429, 500, 502, 503, 504].includes(response.status)
      )
        throw new GcsError(response.status);
      await setTimeout(250 * (attempt + 1), undefined, { signal });
    }
  }

  async head(key: string, signal: AbortSignal): Promise<Entry | undefined> {
    const result = await this.request(this.url(key), {}, signal, [404]);
    if (result.status === 404) {
      await result.body?.cancel();
      return undefined;
    }
    const metadata = metadataSchema.parse(await result.json());
    return {
      key,
      size: Number(metadata.size),
      version: metadata.generation,
      sha256: metadata.metadata?.sha256 || "",
    };
  }

  async list(
    prefix: string,
    token: string | undefined,
    signal: AbortSignal,
  ): Promise<Page> {
    const url = this.url();
    url.searchParams.set("prefix", prefix);
    url.searchParams.set("maxResults", "1000");
    if (token) url.searchParams.set("pageToken", token);
    const result = listSchema.parse(
      await (await this.request(url, {}, signal)).json(),
    );
    return {
      items: (result.items || [])
        .filter((item) => Number(item.size) > 0)
        .map((item) => ({
          key: item.name,
          modified: new Date(item.updated).getTime(),
        })),
      token: result.nextPageToken,
    };
  }

  async read(
    entry: Entry,
    start: number,
    end: number,
    signal: AbortSignal,
  ): Promise<Range> {
    const url = this.url(entry.key);
    url.searchParams.set("alt", "media");
    url.searchParams.set("generation", entry.version);
    const response = await this.request(
      url,
      { headers: { Range: `bytes=${start}-${end}` } },
      signal,
    );
    if (!response.body)
      throw new CacheError("GCS did not return a response body");
    return {
      body: Readable.from(response.body),
      contentRange: response.headers.get("content-range") || "",
      length: Number(response.headers.get("content-length")),
    };
  }

  async upload(
    key: string,
    source: string,
    bytes: number,
    sha256: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    let session: URL | undefined;
    let completed = false;
    try {
      const url = this.url(undefined, true);
      url.searchParams.set("uploadType", "resumable");
      url.searchParams.set("name", key);
      url.searchParams.set("ifGenerationMatch", "0");
      const created = await this.request(
        url,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Upload-Content-Length": String(bytes),
          },
          body: JSON.stringify({
            name: key,
            contentType: "application/octet-stream",
            metadata: { sha256 },
          }),
        },
        signal,
      );
      const location = created.headers.get("location");
      await created.body?.cancel();
      if (!location)
        throw new CacheError("GCS did not return a resumable upload session");
      session = new URL(location, this.endpoint);
      core.setSecret(session.href);
      if (session.origin !== this.endpoint.origin)
        throw new CacheError(
          "GCS upload session changed the configured endpoint",
        );
      const file = await openAsBlob(source);
      let offset = 0;
      let stalled = 0;
      while (offset < bytes) {
        const end = Math.min(offset + this.config.partSize, bytes);
        let response: Response;
        try {
          response = await this.request(
            session,
            {
              method: "PUT",
              headers: {
                "Content-Range": `bytes ${offset}-${end - 1}/${bytes}`,
              },
              body: file.slice(offset, end),
            },
            signal,
            [308],
            false,
          );
        } catch (error) {
          if (
            signal.aborted ||
            status(error) === 412 ||
            status(error) === 401 ||
            status(error) === 403
          )
            throw error;
          // A lost response is ambiguous. Ask how much the server committed
          // before resuming, instead of assuming the entire chunk was lost.
          response = await this.request(
            session,
            {
              method: "PUT",
              headers: {
                "Content-Range": `bytes */${bytes}`,
                "Content-Length": "0",
              },
            },
            signal,
            [308],
          );
        }
        if (response.ok) {
          if (end !== bytes)
            throw new CacheError(
              "GCS confirmed completion before the entire archive was uploaded",
            );
          completed = true;
          await response.body?.cancel();
          return true;
        }
        const range = response.headers.get("range");
        await response.body?.cancel();
        const match = range && /^bytes=0-(\d+)$/.exec(range);
        const next = match ? Number(match[1]) + 1 : 0;
        if (next < offset || next > end || next > bytes)
          throw new CacheError(
            "GCS returned an invalid resumable upload offset",
          );
        stalled = next === offset ? stalled + 1 : 0;
        if (stalled >= 3)
          throw new CacheError("GCS resumable upload made no progress");
        offset = next;
      }
      throw new CacheError("GCS did not confirm upload completion");
    } catch (error) {
      if (status(error) === 412) return false;
      throw error;
    } finally {
      if (session && !completed && session.origin === this.endpoint.origin) {
        const response = await this.request(
          session,
          { method: "DELETE" },
          AbortSignal.timeout(30000),
          [404, 410, 499],
        );
        await response.body?.cancel();
      }
    }
  }
}
