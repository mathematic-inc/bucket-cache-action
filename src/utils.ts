// A workflow gives an empty string for a value it leaves out, so an empty string counts as unset.
export function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value;
}

export function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}
