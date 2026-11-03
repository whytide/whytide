// The sender's values (README.md "Worker", "Settings"; docs/flows.md "The sender"), beside the code
// that reads them: the price of a send, the person's member id in contacts, the request file under
// raw/, and the refusal that ends a run though it names a time.

/** The priced action of a send, a connection request or a message, per send; a withdrawal is free. */
export const LINKEDIN_SEND_ACTION = "campaigns.linkedin_send";
export const LINKEDIN_SEND_UNIT = "send";
/** One step's send, the quantity its credits are reserved for. */
export const SEND_QUANTITY = 1;
/** CAMPAIGNS_CREDITS_PER_LINKEDIN_SEND's default and bounds (settings.ts). */
export const CREDITS_PER_LINKEDIN_SEND = { default: 1, min: 0, max: 100 } as const;
/** The actions that are sends, charged; a withdrawal and a check cost nothing. */
export const CHARGED_ACTIONS = ["invite", "message"] as const;

/** The person's member id in contacts' providerRefs: the key the LinkedIn adapter writes it under. */
export const MEMBER_REF_KEY = "unipile";

/** The step's request file, `raw/campaigns/<stepExecutionId>/send.json`, deleted after the settle. */
export const REQUEST_FOLDER = "raw/campaigns";
export const REQUEST_FILE = "send.json";
export const REQUEST_CONTENT_TYPE = "application/json";

/** A refusal that ends the sender's run though it says when to come back: the account's limit. */
export const RUN_ENDING_REFUSALS = ["rate_limited"] as const;

/**
 * The profile read before a connection request whose person has no member id (beta-p4-030): the
 * least time between the read and the invite, in minutes (RB-11.2.4 keeps a message 3 minutes from a
 * profile view; here the connection request, the same person's next action), the read's kind in
 * linkedin's quota and log, and its two files beside the request file, deleted after its settle.
 */
export const MIN_MINUTES_AFTER_PROFILE_READ = 3;
export const PROFILE_READ_KIND = "read_profile";
export const PROFILE_REQUEST_FILE = "profile.request.json";
export const PROFILE_FILE = "profile.json";
/** Where the member id read comes from, for contacts' provenance. */
export const PROFILE_SOURCE = "linkedin";
/** The claim's modes around a profile read: the credits alone before it, the slot alone after it. */
export const CLAIM_MODES = ["credits", "slot"] as const;
export type ClaimMode = (typeof CLAIM_MODES)[number];

// beta-p4-040, the recovery (README.md "Worker"; docs/flows.md "The check first").

/** The LinkedIn port's codes' prefix: a check refused with one failed at the provider. */
export const PORT_CODE_PREFIX = "linkedin_";
/**
 * A refusal with no time that is one action's, not the account's: the run goes on, since the
 * account's other actions may still go (not in the sources; beta-p4-020's review).
 */
export const ACTION_REFUSALS = ["invites_paused"] as const;
/**
 * How long the gate's pass right before the call holds, in workflow time: a pass older than this
 * when the call is scheduled, after a stop between the two, is asked again (not in the sources:
 * about a minute, beta-p4-020's review).
 */
export const GATE_FRESH_MS = 60_000;
/** A rate limit's wait, `retryAfterSec`, is given in seconds. */
export const MS_PER_SECOND = 1000;
/** A request off the port's schema: a defect, the step failed and its enrollment ended. */
export const INPUT_INVALID = "linkedin_input_invalid";
