export class CacheError extends Error {
  override name = "CacheError";
}

// An input the action can't run with. The message names the input, never its value.
export class ConfigurationError extends CacheError {
  override name = "ConfigurationError";
}

// A tier that couldn't be signed in to or reached, so another tier may answer in
// its place. The error it wraps is the one a single bucket always reported.
export class Unavailable extends CacheError {
  override name = "Unavailable";
  constructor(
    message: string,
    override readonly cause: unknown,
  ) {
    super(message, { cause });
  }
}

// A request that got no answer, so the tier was never reached, as opposed to one
// it refused. Node's codes (ECONNREFUSED, ENOTFOUND) say why without a URL.
export function unanswered(error: unknown, prefix: string): Unavailable | undefined {
  if (status(error) !== undefined) return undefined;
  const codes = [error, error && typeof error === "object" && "cause" in error && error.cause];
  const code = codes
    .map((value) => value && typeof value === "object" && "code" in value && value.code)
    .find((value) => typeof value === "string" && /^[A-Z][A-Z0-9_]+$/.test(value));
  return new Unavailable(`${prefix} (${typeof code === "string" ? code : describe(error)})`, error);
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
