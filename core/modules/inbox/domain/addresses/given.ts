// The addresses a person gave in their own messages (README.md "Addresses a person gave",
// gamma-en-085), enrichment's `reply` source's reader, in the caller's tenant run: the person's
// inbound messages of their LinkedIn threads only (GIVEN_CHANNELS), never one the workspace's
// accounts sent them, newest first, the first
// GIVEN_MESSAGES that hold an address, each one's addresses lower case. Never a text: the body is read
// here and dropped. The scan is linear: each `@` is read outwards within an address's bounds.
import { tenantClient } from "@whytide/db";
import {
  ADDRESS,
  DOMAIN_CHAR,
  DOMAIN_MAX,
  GIVEN_CHANNELS,
  GIVEN_MESSAGES,
  GIVEN_SCAN,
  LOCAL_CHAR,
  LOCAL_MAX,
  PER_MESSAGE,
} from "./constants.ts";

/** The addresses of each of the person's newest inbound messages that hold one, newest first. */
export async function addressesGivenBy(personId: string): Promise<string[][]> {
  // Prisma drops an undefined value from a where: unchecked, that would be every person's.
  if (typeof personId !== "string" || personId.trim() === "") return [];
  // The tenant client takes no relation in a where: the person's threads of GIVEN_CHANNELS first.
  const threads = await tenantClient.thread.findMany({
    where: { personId, channel: { in: [...GIVEN_CHANNELS] } },
    select: { id: true },
  });
  if (threads.length === 0) return [];
  const threadId = { in: threads.map(({ id }) => id) };
  const messages = await tenantClient.message.findMany({
    where: { personId, threadId, direction: "in", body: { contains: "@" } },
    select: { body: true },
    orderBy: [{ sentAt: "desc" }, { id: "desc" }],
    take: GIVEN_SCAN,
  });
  const given: string[][] = [];
  for (const { body } of messages) {
    const found = addressesIn(body);
    if (found.length > 0) given.push(found);
    if (given.length >= GIVEN_MESSAGES) break;
  }
  return given;
}

/** The addresses in a text, each once, lower case, in their order; at most PER_MESSAGE. */
export function addressesIn(text: string): string[] {
  const found = new Set<string>();
  for (let at = text.indexOf("@"); at >= 0; at = text.indexOf("@", at + 1)) {
    let start = at;
    while (start > 0 && at - start < LOCAL_MAX && LOCAL_CHAR.test(text[start - 1] ?? "")) start--;
    let end = at + 1;
    while (end < text.length && end - at <= DOMAIN_MAX && DOMAIN_CHAR.test(text[end] ?? "")) end++;
    // A part longer than an address's is no address, never a piece of one.
    const longer = LOCAL_CHAR.test(text[start - 1] ?? "") || DOMAIN_CHAR.test(text[end] ?? "");
    if (longer) continue;
    // A sentence's full stop or a stray dot ends neither part.
    const address = text
      .slice(start, end)
      .replace(/^[._%+-]+/, "")
      .replace(/[.-]+$/, "")
      .toLowerCase();
    if (ADDRESS.test(address)) found.add(address);
    if (found.size >= PER_MESSAGE) break;
  }
  return [...found];
}
