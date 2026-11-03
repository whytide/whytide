// Machine-readable errors (docs/rules/coding.md §4, §9): a code in snake_case, never a sentence; the
// UI translates it. A module declares its codes in its errors.ts with defineErrors; the registry
// assembled from them maps a code to the HTTP status the api host answers with, falling back to the
// defaults below when a definition names none.
export type ErrorDefinition = { readonly status?: number };
export type ErrorOptions = { status?: number; details?: Record<string, unknown>; cause?: unknown };
type Codes<T> = { readonly [K in keyof T & string]: K };

const CODE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const registry = new Map<string, ErrorDefinition>();
const EXACT: Readonly<Record<string, number>> = {
  unauthenticated: 401,
  insufficient_credits: 402,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
};
const SUFFIXES: readonly (readonly [RegExp, number])[] = [
  [/^invalid_|_invalid$/, 400],
  [/_required$|_forbidden$/, 403],
  [/_not_found$/, 404],
  [/_conflict$|_exists$/, 409],
];

/** Registers a module's codes; returns them as themselves, so `errors.icp_not_found` is typed. */
export function defineErrors<const T extends Record<string, ErrorDefinition>>(
  definitions: T,
): Codes<T> {
  for (const [code, definition] of Object.entries(definitions)) {
    if (!CODE.test(code)) throw new AppError(errors.invalid_error_code, { details: { code } });
    if (registry.has(code)) throw new AppError(errors.duplicate_error_code, { details: { code } });
    registry.set(code, { status: definition.status });
  }
  return Object.freeze(
    Object.fromEntries(Object.keys(definitions).map((code) => [code, code])),
  ) as Codes<T>;
}

const errors = defineErrors({ invalid_error_code: {}, duplicate_error_code: {} });

export const registeredErrors = (): ReadonlyMap<string, ErrorDefinition> => registry;

/** The HTTP status for a code: its registered one, then the exact and suffix defaults, then 500. */
export function httpStatus(code: string): number {
  const status = registry.get(code)?.status ?? EXACT[code];
  if (status !== undefined) return status;
  return SUFFIXES.find(([pattern]) => pattern.test(code))?.[1] ?? 500;
}

export class AppError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(code: string, { status, details, cause }: ErrorOptions = {}) {
    if (!CODE.test(code)) throw new AppError(errors.invalid_error_code, { details: { code } });
    super(code, cause === undefined ? undefined : { cause });
    this.code = code;
    this.status = status ?? httpStatus(code);
    if (details) this.details = details;
  }
}
// On the prototype, not an own field: pino's error serializer copies own properties into the line.
Object.defineProperty(AppError.prototype, "name", {
  value: "AppError",
  configurable: true,
  writable: true,
});

export function isAppError(value: unknown): value is AppError {
  return (
    value instanceof AppError ||
    (value instanceof Error &&
      value.name === "AppError" &&
      typeof (value as { code?: unknown }).code === "string")
  );
}
