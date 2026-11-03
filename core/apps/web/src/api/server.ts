// The api from a server component (docs/screens.md "The API"): the generated client on the api's
// URL, passing on the visitor's session cookie and, for a change the browser asked for, its Origin,
// which the api's origin check compares with APP_PUBLIC_ORIGIN.
import { headers } from "next/headers";
import { createApiClient } from "./client.generated.ts";

export { ApiError, data } from "./errors.ts";

export async function serverApi() {
  const incoming = await headers();
  const forwarded: Record<string, string> = {};
  for (const name of ["cookie", "origin"]) {
    const value = incoming.get(name);
    if (value) forwarded[name] = value;
  }
  return createApiClient({ baseUrl: process.env.NEXT_PUBLIC_API_URL, headers: forwarded });
}
