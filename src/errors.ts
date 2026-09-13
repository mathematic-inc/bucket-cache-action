export class CacheError extends Error {
  override name = "CacheError";
}

// SDK errors can contain URLs and credential-provider diagnostics. Report only
// their stable code/status, while our own errors contain no secret input values.
export function describe(error: unknown): string {
  if (error instanceof CacheError) return error.message;
  if (!error || typeof error !== "object") return "unknown error";
  const code =
    "name" in error && typeof error.name === "string" && /^[A-Za-z0-9_]+$/.test(error.name)
      ? error.name
      : "Error";
  const metadata = "$metadata" in error ? error.$metadata : undefined;
  const status =
    metadata && typeof metadata === "object" && "httpStatusCode" in metadata
      ? metadata.httpStatusCode
      : undefined;
  return typeof status === "number" ? `${code}, HTTP ${status}` : code;
}
export function status(error: unknown): number | undefined {
  if (error && typeof error === "object" && "$metadata" in error) {
    const metadata = error.$metadata;
    if (
      metadata &&
      typeof metadata === "object" &&
      "httpStatusCode" in metadata &&
      typeof metadata.httpStatusCode === "number"
    )
      return metadata.httpStatusCode;
  }
  if (error && typeof error === "object" && "code" in error && typeof error.code === "number")
    return error.code;
  return undefined;
}
