export type DeepReadonly<T> = T extends (...parameters: readonly never[]) => unknown
  ? T
  : T extends object
    ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
    : T;
