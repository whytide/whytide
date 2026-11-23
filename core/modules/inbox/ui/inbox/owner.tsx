// Whose words a refused press shows (reply-box.tsx, reply-draft.tsx): inbox's where it has them,
// contacts' person_suppressed among them, else the code's module's (src/api/errors.ts errorOwner).
// A .tsx, which the web compiles, not the module, as it imports the web's client.
import { errorOwner } from "@whytide/web/api/browser";
import type { useMessages } from "next-intl";

type Messages = ReturnType<typeof useMessages>;

export function ownerOf(code: string, messages: Messages) {
  const inbox = messages.inbox;
  const errors = typeof inbox === "object" ? inbox.errors : undefined;
  if (typeof errors === "object" && typeof errors[code] === "string") {
    return { module: "inbox", code };
  }
  return errorOwner({ digest: `api:${code}` }, messages);
}
