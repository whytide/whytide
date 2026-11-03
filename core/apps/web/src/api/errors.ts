// The api's error answers on the screens (docs/screens.md "Errors, not found, loading"). data()
// throws an ApiError for an answer that is not 2xx; its digest, `api:<code>` or `api:<module>:<code>`
// when the body names the module, is what Next.js hands a route's error.tsx, from a server component
// in production too. errorOwner() reads it back: the module from the body, else the bundle's
// `<module>.errors.<code>`, else web.
const NAME = /^[a-z][a-z0-9_]*$/;
const DIGEST = /^api:(?:([a-z][a-z0-9_]*):)?([a-z][a-z0-9_]*)$/;

type Messages = { readonly [key: string]: string | Messages };

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly digest: string;

  constructor(status: number, body: unknown) {
    const { code, module } = (body ?? {}) as { code?: unknown; module?: unknown };
    const known = typeof code === "string" && NAME.test(code) ? code : "internal_error";
    const owner = typeof module === "string" && NAME.test(module) ? `${module}:` : "";
    super(`the api answered ${status} ${known}`);
    this.status = status;
    this.code = known;
    this.digest = `api:${owner}${known}`;
  }
}

/** The answer's data; an error answer is thrown as an ApiError, for the route's error.tsx. */
export async function data<T>(
  call: Promise<{ data?: T; error?: unknown; response: Response }>,
): Promise<T> {
  const { data, error, response } = await call;
  if (!response.ok) throw new ApiError(response.status, error);
  return data as T;
}

/** The module and code ErrorState shows: the digest's module, the bundle's owner of the code, or web. */
export function errorOwner(error: { digest?: string }, messages: Messages) {
  const [, module, code = "internal_error"] = DIGEST.exec(error.digest ?? "") ?? [];
  const owns = (name: string) => {
    const errors = (messages[name] as Messages | undefined)?.errors;
    return typeof errors === "object" && typeof errors[code] === "string";
  };
  return { module: module ?? Object.keys(messages).find(owns) ?? "web", code };
}
