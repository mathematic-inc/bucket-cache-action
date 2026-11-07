import {
  type AuthClient,
  ExternalAccountAuthorizedUserClient,
  ExternalAccountClient,
  type ExternalAccountClientOptions,
  GdchClient,
  type GdchCredentialsInput,
  GoogleAuth,
  JWT,
  type JWTInput,
  UserRefreshClient,
} from "google-auth-library";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { CacheError } from "../errors.js";

const credentialSchema = z.looseObject({
  type: z.enum([
    "service_account",
    "authorized_user",
    "external_account",
    "impersonated_service_account",
    "external_account_authorized_user",
    "gdch_service_account",
  ]),
});

export async function loadGoogleCredentials(file: string, scopes: string[]): Promise<AuthClient> {
  const contents = await readFile(file, "utf8");
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    throw new CacheError("GCS credential file is not valid JSON");
  }
  const json = credentialSchema.parse(value);
  let client: AuthClient;
  switch (json.type) {
    case "service_account": {
      const jwt = new JWT({ scopes });
      jwt.fromJSON(json as JWTInput);
      client = jwt;
      break;
    }
    case "authorized_user": {
      const refresh = new UserRefreshClient();
      refresh.fromJSON(json as JWTInput);
      client = refresh;
      break;
    }
    case "external_account": {
      const external = ExternalAccountClient.fromJSON(
        json as unknown as ExternalAccountClientOptions,
      );
      if (!external) throw new CacheError("Unsupported external GCS credential configuration");
      external.scopes = scopes;
      client = external;
      break;
    }
    case "impersonated_service_account":
      client = new GoogleAuth({ scopes }).fromImpersonatedJSON(
        json as Parameters<GoogleAuth["fromImpersonatedJSON"]>[0],
      );
      break;
    case "external_account_authorized_user":
      client = new ExternalAccountAuthorizedUserClient(
        json as unknown as ConstructorParameters<typeof ExternalAccountAuthorizedUserClient>[0],
      );
      break;
    case "gdch_service_account": {
      const gdch = new GdchClient();
      gdch.fromJSON(json as unknown as GdchCredentialsInput);
      client = gdch;
      break;
    }
  }
  client.quotaProjectId = process.env.GOOGLE_CLOUD_QUOTA_PROJECT || client.quotaProjectId;
  return client;
}
