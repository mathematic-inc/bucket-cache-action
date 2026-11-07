import { IdentityPoolClient, JWT, UserRefreshClient } from "google-auth-library";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadGoogleCredentials } from "../src/storage/google-auth.js";

async function credentialFile(contents: string, run: (file: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(process.cwd(), ".test-cache-credentials-"));
  try {
    const file = path.join(directory, "credentials.json");
    await writeFile(file, contents);
    await run(file);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("explicit Google credential clients", () => {
  it("loads service account credentials with the requested scopes", async () => {
    await credentialFile(
      JSON.stringify({
        type: "service_account",
        client_email: "test@example.test",
        private_key: "test-key",
      }),
      async (file) => {
        const client = await loadGoogleCredentials(file, ["storage-scope"]);
        expect(client).toBeInstanceOf(JWT);
        expect(client).toMatchObject({ email: "test@example.test", scopes: ["storage-scope"] });
      },
    );
  });

  it("preserves authorized user refresh credentials", async () => {
    await credentialFile(
      JSON.stringify({
        type: "authorized_user",
        client_id: "client",
        client_secret: "secret",
        refresh_token: "refresh",
      }),
      async (file) => {
        const client = await loadGoogleCredentials(file, []);
        expect(client).toBeInstanceOf(UserRefreshClient);
        expect(client.credentials.refresh_token).toBe("refresh");
      },
    );
  });

  it("loads workload identity credential files without reading a subject token early", async () => {
    await credentialFile(
      JSON.stringify({
        type: "external_account",
        audience:
          "//iam.googleapis.com/projects/123/locations/global/workloadIdentityPools/test/providers/test",
        subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
        token_url: "https://sts.googleapis.com/v1/token",
        credential_source: { file: "/missing-subject-token" },
      }),
      async (file) => {
        const client = await loadGoogleCredentials(file, ["storage-scope"]);
        expect(client).toBeInstanceOf(IdentityPoolClient);
        expect(client).toMatchObject({ scopes: ["storage-scope"] });
      },
    );
  });

  it("rejects unknown credential types", async () => {
    await credentialFile('{"type":"unknown"}', async (file) => {
      await expect(loadGoogleCredentials(file, [])).rejects.toThrow();
    });
  });

  it("does not expose credential contents in JSON errors", async () => {
    await credentialFile("private-credential-contents", async (file) => {
      await expect(loadGoogleCredentials(file, [])).rejects.toThrow(
        "GCS credential file is not valid JSON",
      );
    });
  });
});
