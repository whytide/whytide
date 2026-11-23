// A step's hash and its idempotency key (README.md "Campaigns and versions"; RB-9.3.3, RB-1.2.4),
// pure: the same parts always give the same hex, and a change to any part gives another.
import { createHash } from "node:crypto";
import { KEY_SEPARATOR, type StepDelay } from "./constants.ts";

/** The parts of the key: the template's id stands where a campaign's will (RB-9.3.3). */
export type KeyParts = {
  readonly workspaceId: string;
  readonly personId: string;
  readonly templateId: string;
  readonly stepTemplateHash: string;
};

/**
 * The SHA-256, in hex, of the step's canonical definition: `step_key`, `action`, `delay` and
 * `channel` as JSON with sorted keys; a campaign version's steps on either channel too. A step's
 * `condition` enters it only when set (gamma-p3-060), so every hash of beta's template stays.
 */
export function stepTemplateHash(step: {
  readonly stepKey: string;
  readonly action: string;
  readonly delay: StepDelay;
  readonly channel: string;
  readonly condition?: string | null;
}): string {
  const { stepKey, action, delay, channel } = step;
  const condition = step.condition ?? undefined;
  return sha256(canonicalJson({ step_key: stepKey, action, delay, channel, condition }));
}

/** The SHA-256, in hex, of the workspace, the person, the template and the step's hash, joined. */
export function idempotencyKey(parts: KeyParts): string {
  const { workspaceId, personId, templateId, stepTemplateHash: hash } = parts;
  return sha256([workspaceId, personId, templateId, hash].join(KEY_SEPARATOR));
}

/** JSON without whitespace, every object's keys sorted by code unit at every depth. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
