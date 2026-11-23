// The member reference's fixture (tests/campaigns-member-reference.test.ts,
// tests/safety/profile-read-before-invite.test.ts), on the sender's (campaigns-sender.ts): a
// connection request ready whose person has no member ref, as signals leaves one (no provider), and
// the profile the LinkedIn fake reads at the person's stored URL; linkedin's read_profile rows, the
// day's read counts and the 200, the step's two profile files; the settle's wait skipped on the
// clocks, as the sender's waits are, and a read that never answers.
import { app, fake, type Sender, skip, type Wrap } from "./campaigns-sender.ts";

const { Prisma } = await import("@whytide/db");
const { AppError } = await import("@whytide/platform");
const { filesPort, getAdapter } = await import("@whytide/providers");
const { workerErrors } = await import("../../src/errors.ts");
const built = (path: string) =>
  import(new URL(`../../../../modules/${path}`, import.meta.url).href);
const { actionsUsed } = await built("linkedin/dist/domain/quota/limits.js");
export const { MIN_MINUTES_AFTER_PROFILE_READ } = await built(
  "campaigns/dist/domain/send/constants.js",
);
export const { useProfileReadWait } = await built("campaigns/dist/testing/index.js");
/** campaigns' test hooks' build, for a process of a test's own. */
export const campaignsTesting = new URL(
  "../../../../modules/campaigns/dist/testing/index.js",
  import.meta.url,
).href;
const files = await getAdapter(filesPort, "fake");

/** What the workflow's own timer runs of the wait after a read; the clocks skip the rest. */
const WAIT_RUN_MS = 250;
export const MINUTE_MS = 60_000;

/**
 * A new lead's connection request approved with `note` and placed at `at`, its person with no
 * member ref; `memberRef`, the one LinkedIn knows the person by, and the person's stored URL.
 */
export async function unknownLead(s: Sender, slug: string, note = "", at?: Date) {
  const step = await s.ready(slug, "connect", note, at);
  const data = { providerRefs: Prisma.DbNull };
  const { linkedinUrl } = await app.person.update({ where: { id: step.personId }, data });
  // The sender's leads have a profile; the column is nullable since gamma-rf-050.
  if (linkedinUrl === null) throw new Error("unknownLead: the lead has no LinkedIn profile");
  return { ...step, linkedinUrl };
}

/** The profile the fake reads at the person's stored URL, with the member ref. */
export function seedProfile(lead: { linkedinUrl: string; memberRef: string }): void {
  fake.seedProfile({
    ...{ providerMemberRef: lead.memberRef, profileUrl: lead.linkedinUrl },
    ...{ firstName: "Noor", lastName: "Haddad", headline: "Head of Sales at Acme" },
    ...{ title: "Head of Sales", companyName: "Acme", locationText: "Berlin, Germany" },
  });
}

/** The fake's calls of `method`. */
export const callsOf = (method: string) =>
  fake.recordedCalls.filter((call) => call.method === method);

/** The person's member ref under unipile, as contacts stores it; null for none. */
export async function storedRef(personId: string): Promise<string | null> {
  const { providerRefs } = await app.person.findUniqueOrThrow({ where: { id: personId } });
  return (providerRefs as Record<string, string> | null)?.unipile ?? null;
}

/** linkedin's read_profile rows of the account, oldest first: outcome, object and time. */
export async function readRows(accountId: string) {
  return app.senderActionLog.findMany({
    where: { senderAccountId: accountId, kind: "read_profile" },
    select: { outcome: true, objectRef: true, at: true },
    orderBy: [{ at: "asc" }, { outcome: "desc" }],
  });
}

/** The account's reads reserved and made, and its actions toward the 200, over its quota days. */
export async function readCounts(accountId: string) {
  const days = await app.senderQuotaUsage.findMany({ where: { senderAccountId: accountId } });
  const sum = (count: (day: (typeof days)[number]) => number) =>
    days.reduce((total, day) => total + count(day), 0);
  return {
    reserved: sum((day) => day.readsReserved),
    committed: sum((day) => day.readsCommitted),
    actions: sum((day) => actionsUsed(day)),
  };
}

/** The step's profile files still under raw/. */
export async function profileFiles(workspaceId: string, stepId: string): Promise<string[]> {
  const keys = ["profile.request.json", "profile.json"].map(
    (name) => `raw/campaigns/${stepId}/${name}`,
  );
  const kept = await Promise.all(
    keys.map((key) =>
      files.get({ workspaceId, key }).then(
        () => key,
        () => null,
      ),
    ),
  );
  return kept.filter((key): key is string => key !== null);
}

/**
 * campaigns_profile_settle's wait as the module computes it, recorded in `waits`, then skipped on the
 * clocks to WAIT_RUN_MS before its end, which the workflow's timer runs; `between` runs first.
 */
export function skipWait(waits: number[] = [], between?: (input: never) => Promise<unknown>): Wrap {
  return (run) => async (input, context) => {
    const answer = (await run(input, context)) as { waitMs?: number };
    await between?.(input);
    if (answer.waitMs === undefined) return answer;
    waits.push(answer.waitMs);
    skip(Math.max(0, answer.waitMs - WAIT_RUN_MS));
    return { ...answer, waitMs: Math.min(answer.waitMs, WAIT_RUN_MS) };
  };
}

/** linkedin's read failing past its attempts, never called: no answer reaches the workflow. */
export const noAnswer: Wrap = () => async () => {
  throw new AppError(workerErrors.activity_attempts_exhausted);
};
