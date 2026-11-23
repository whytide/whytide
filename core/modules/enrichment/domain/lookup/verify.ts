// The lookup's verify step (docs/flows.md "The lookup", step 3), one verifier's turn on one
// candidate: the first verifier of PROVIDER_EMAIL_VERIFIER with room in its allowance (its counter,
// `email-verifier/<adapter>`) gives the verdict, with the address and nothing else. Its
// verifier_allowance_spent marks it spent until its period ends; any other error is recorded with
// its code; either way the workflow passes the same candidate to the next verifier. One verdict per
// candidate: a candidate with one already answers it. The verdict goes to the candidate's file and
// to providers_tried; the step answers it, and whether the address is a personal one.
import { tenantClient } from "@whytide/db";
import { SOURCE_UNKNOWN } from "../constants.ts";
import { log } from "../log.ts";
import { codeOf } from "../step.ts";
import { hasRoom, markSpent, reserveCall } from "../usage.ts";
import { EMAIL_KINDS, type Verdict } from "./constants.ts";
import { readCandidate, writeCandidate } from "./files.ts";
import type { Runs } from "./find.ts";
import { lockedRequest, recordSteps } from "./request.ts";
import { loadEmail, type Verifier } from "./sources.ts";

/**
 * A verdict, `allowance_spent` or `failed` with its code (the next verifier's turn), and the
 * address's kind.
 */
export type VerifyResult = {
  readonly outcome: string;
  readonly personal: boolean;
  readonly code?: string;
};
type Target = { address: string; personal: boolean; verdict?: Verdict };

/**
 * Whether any verifier has a call left in its period, read before the lookup reserves credits or asks
 * a finder: none, and it waits for the allowance. Outside any run (source_usage is global).
 */
export async function verifierOpen(verifiers: readonly Verifier[]): Promise<boolean> {
  for (const { name, adapter } of verifiers) {
    if (await hasRoom(name, adapter.allowance)) return true;
  }
  return false;
}

/** n is the candidate's number; 0, a re-verification's contact point. */
export async function verifyCandidate(
  runs: Runs,
  input: { requestId: string; n: number; verifier: string },
): Promise<VerifyResult> {
  const { requestId, n, verifier: name } = input;
  const started = performance.now();
  const record = async (outcome: string, code: string | null, personal: boolean) => {
    const entry = { source: name, step: "verify" as const, outcome, code };
    await runs.tenant(() =>
      recordSteps(requestId, [{ ...entry, ms: Math.round(performance.now() - started) }]),
    );
    return { outcome, personal, ...(outcome === "failed" && code !== null && { code }) };
  };
  const target = await targetOf(runs, requestId, n);
  if (target === null) return { outcome: "failed", personal: false };
  const { address, personal } = target;
  if (target.verdict !== undefined) return { outcome: target.verdict, personal };
  const fail = (code: string) => {
    log().warn({ provider: name, code }, "enrichment: a verifier failed; the next one is asked");
    return record("failed", code, personal);
  };
  const verifier = (await loadEmail()).verifiers.find((loaded) => loaded.name === name);
  if (verifier === undefined) return fail(SOURCE_UNKNOWN);
  const { allowance } = verifier.adapter;
  if (!(await reserveCall(name, allowance))) return record("allowance_spent", null, personal);
  let verdict: Verdict;
  try {
    // The port refuses capitals: an address is kept lower case, and checked so.
    ({ verdict } = await verifier.adapter.verifyEmail({ address: address.toLowerCase() }));
  } catch (error) {
    const code = codeOf(error);
    if (!code.endsWith("_allowance_spent")) return fail(code);
    await markSpent(name, allowance);
    return record("allowance_spent", code, personal);
  }
  if (n > 0) {
    const candidate = await readCandidate(runs.workspaceId, requestId, n);
    await writeCandidate(runs.workspaceId, requestId, n, { ...candidate, verdict, verifier: name });
  }
  return record(verdict, null, personal);
}

/** The address to check: the candidate's file, or the re-verification's contact point. */
async function targetOf(runs: Runs, requestId: string, n: number): Promise<Target | null> {
  const request = await runs.tenant(async () => {
    const row = await lockedRequest(requestId);
    if (row === null || row.status !== "running") return null;
    if (n > 0) return { row, point: null };
    // An address only: a request that names a phone's contact point checks nothing (gamma-wr-100).
    const where = {
      ...{ id: row.contactPointId ?? "", status: "active" as const },
      kind: { in: [...EMAIL_KINDS] },
    };
    return { row, point: await tenantClient.contactPoint.findFirst({ where }) };
  });
  if (request === null) return null;
  if (n === 0) {
    const { point } = request;
    return point === null
      ? null
      : { address: point.value, personal: point.kind === "personal_email" };
  }
  const candidate = await readCandidate(runs.workspaceId, requestId, n);
  const personal = candidate.kind === "personal_email";
  return {
    address: candidate.address,
    personal,
    ...(candidate.verdict && { verdict: candidate.verdict }),
  };
}
