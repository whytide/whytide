// The source country-ai (README "Sources", gamma-en-075): a person's country, named by the AI from
// the location text alone (RB-7.3.1), for a person whose country is empty and whose location the
// place list could not read. A text that names no place ("Remote", "EMEA") asks nothing. The model
// gets the cleaned text, at most LOCATION_MAX characters, under the subject `location:<sha256 of
// it>`, so callAgent's cache answers a location seen before in the workspace with no model call.
// Only a sure answer whose code contacts knows is a fact; the rest is an outcome of its own. The
// step writes it through contacts' recordPersonCountry, class ai_inferred.
import { createHash } from "node:crypto";
import { callAgent, registeredAgentTasks } from "@whytide/ai";
import { cleanLocation, countryCode, namesNoPlace } from "@whytide/contacts";
import { AppError } from "@whytide/platform";
import type { nameCountryTask } from "../../agents/name-country/task.ts";
import { errors } from "../../errors.ts";
import { NAME_COUNTRY } from "../../schemas/name-country.ts";
import {
  AI_TIMEOUT_SECONDS,
  COUNTRY_AI,
  COUNTRY_AI_OUTCOMES,
  LOCATION_MAX,
  LOCATION_SUBJECT,
} from "../constants.ts";
import { agentCallOptions } from "./agent-call.ts";
import { defineSource, type SourceAnswer, type SourceInput } from "./define.ts";

export const countryAi = defineSource({
  name: COUNTRY_AI,
  kind: "person",
  fills: ["person.country"],
  needs: ["locationText"],
  activityKind: "ai",
  provenance: { source: "ai_inferred", provider: COUNTRY_AI },
  timeoutSeconds: AI_TIMEOUT_SECONDS,
  run: nameCountry,
});

async function nameCountry(input: SourceInput): Promise<SourceAnswer> {
  const text = input.person?.locationText ?? "";
  if (namesNoPlace(text)) return { found: false, outcome: COUNTRY_AI_OUTCOMES.noPlace };
  const location = cleanLocation(text).slice(0, LOCATION_MAX);
  const subjectRef = `${LOCATION_SUBJECT}${createHash("sha256").update(location).digest("hex")}`;
  const call = { workspaceId: input.workspaceId, subjectRef, input: { location } };
  const result = await callAgent(registeredTask(), call, agentCallOptions());
  if (result.status !== "ok") return { found: false, outcome: COUNTRY_AI_OUTCOMES.aiFailed };
  const { country, sure } = result.output;
  if (country === null) return { found: false };
  if (!sure) return { found: false, outcome: COUNTRY_AI_OUTCOMES.notSure };
  const known = countryCode(country);
  if (known !== country) return { found: false, outcome: COUNTRY_AI_OUTCOMES.unknownCountry };
  return { found: true, facts: { "person.country": known } };
}

/** The task the host registered at start (loadAgentTasks); never imported here (agents/). */
function registeredTask(): typeof nameCountryTask {
  const task = registeredAgentTasks().get(NAME_COUNTRY);
  if (task === undefined) throw new AppError(errors.enrichment_agent_not_loaded);
  return task as unknown as typeof nameCountryTask;
}
