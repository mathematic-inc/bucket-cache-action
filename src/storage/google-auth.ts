import { readFile } from "node:fs/promises";

import {
  type AuthClient,
  ExternalAccountAuthorizedUserClient,
  ExternalAccountClient,
  type ExternalAccountClientOptions,
  GdchClient,
  type GdchCredentialsInput,
  GoogleAuth,
  JWT,
  UserRefreshClient,
} from "google-auth-library";
import { z } from "zod";

import { CacheError } from "../errors.js";
import { isObject, nonEmpty } from "../utils.js";

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

// The library checks these options when it builds the client, so the action passes the JSON on.
const externalAccountOptions = z.custom<ExternalAccountClientOptions>(isObject);
const externalAccountAuthorizedUserOptions =
  z.custom<ConstructorParameters<typeof ExternalAccountAuthorizedUserClient>[0]>(isObject);
const gdchOptions = z.custom<GdchCredentialsInput>(isObject);

export async function loadGoogleCredentials(
  file: string,
  scopes: readonly string[],
): Promise<AuthClient> {
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
      const jwt = new JWT({ scopes: [...scopes] });
      jwt.fromJSON(json);
      client = jwt;
      break;
    }
    case "authorized_user": {
      const refresh = new UserRefreshClient();
      refresh.fromJSON(json);
      client = refresh;
      break;
    }
    case "external_account": {
      const external = ExternalAccountClient.fromJSON(externalAccountOptions.parse(json));
      if (!external) {
        throw new CacheError("Unsupported external GCS credential configuration");
      }
      external.scopes = [...scopes];
      client = external;
      break;
    }
    case "impersonated_service_account":
      client = new GoogleAuth({ scopes: [...scopes] }).fromImpersonatedJSON(json);
      break;
    case "external_account_authorized_user":
      client = new ExternalAccountAuthorizedUserClient(
        externalAccountAuthorizedUserOptions.parse(json),
      );
      break;
    case "gdch_service_account": {
      const gdch = new GdchClient();
      gdch.fromJSON(gdchOptions.parse(json));
      client = gdch;
      break;
    }
  }
  client.quotaProjectId = nonEmpty(process.env.GOOGLE_CLOUD_QUOTA_PROJECT) ?? client.quotaProjectId;
  return client;
}
