// The lead of a thread in the inbox's words, for the list (threads.tsx) and the thread (thread.tsx):
// their name, "A lead without a name" when contacts has none, "No longer in your leads" once contacts
// no longer has the lead (the api's `person` null); their title at their company, else either.
import { useTranslations } from "next-intl";
import type { ThreadSummaryResponse } from "../../schemas/threads.ts";

type Person = ThreadSummaryResponse["person"];

export function usePersonWords() {
  const t = useTranslations("inbox.list");
  return {
    name(person: Person): string {
      if (person === null) return t("unknown_person");
      const { firstName, lastName } = person;
      return t("name", { first: firstName ?? "", last: lastName ?? "" }).trim() || t("no_name");
    },
    role(person: Person): string | undefined {
      if (person === null) return undefined;
      const { title, companyName } = person;
      if (title && companyName) return t("role", { title, company: companyName });
      return title || companyName || undefined;
    },
  };
}
