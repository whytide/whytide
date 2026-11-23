// The e2e module's routes (index.ts), for the web's end-to-end tests only (lead-list.spec.ts,
// lead-page.spec.ts, review-panel.spec.ts, messaging-draft-panel.spec.ts,
// credits-screen.spec.ts, contacts-never-contact.spec.ts, contacts-exclusions.spec.ts,
// contacts-approve.spec.ts, approvals-up-next.spec.ts, campaigns-enrollment-panel.spec.ts,
// linkedin-switches.spec.ts,
// inbox-screen.spec.ts, linkedin-disclosure.spec.ts, campaigns-counts.spec.ts,
// linkedin-health.spec.ts, icp-draft.spec.ts, inbox-reply-draft.spec.ts,
// tenancy-members.spec.ts, playbooks-agents.spec.ts, sources-screen.spec.ts,
// campaigns-sequence-editor.spec.ts, campaigns-agent-panel.spec.ts, campaigns-results.spec.ts,
// campaigns-health.spec.ts, enrichment-company-panel.spec.ts, enrichment-email-panel.spec.ts):
// - POST …/e2e/leads replaces the workspace's leads, and their review decisions and status changes,
//   with the ones the body lists, each person and lead written by contacts' own commands, as an
//   import or a signal (the sources the body gives) and qualification write them, and a lead's
//   snapshot, if any, with its verdicts, as qualification stores and scores one (it has no command
//   that writes one without the model), and its intent row, if any, as qualification's intent write
//   leaves it; it empties the never-contact list first, and the exclusion lists after their
//   entries, with the owner's client, since app may delete neither, then links a person to the
//   company the body names and records the opt-outs it names as a reply's "stop" will, or with the
//   reason code it gives (contacts' upsertCompany, linkPersonToCompany and addOptOut), and the
//   email address it gives as the person's, as enrichment keeps one (contacts' recordPersonEmail,
//   gamma-rf-040); a lead with no slug is a person known by that address alone, with no LinkedIn
//   profile, whom contacts' upsert creates by it (gamma-rf-050);
// - POST …/e2e/spend spends credits as a batch does, through credits' reserve and commit, after the
//   organization's grant for the period, which the worker (absent here) gives a new organization;
//   with a `key`, once for that key;
// - POST …/e2e/price-notice writes the price list as credits' seeder writes it at the e2e api's
//   start, now, with e2e.batch at the body's `credits` and `unit`: a rise is announced for 30 days
//   on and the same list again writes nothing; with neither, the declared list, which withdraws a
//   pending rise, as the next start of the e2e api does (credits' syncPrices,
//   @whytide/credits/testing);
// - POST …/e2e/drafts replaces a person's message drafts with the ones the body lists, oldest first,
//   and POST …/e2e/drafts/{id} writes a `drafting` one as its writer leaves it, in the worker's
//   stead: both through messaging's factory (its @whytide/messaging/testing);
// - POST …/e2e/costs replaces the workspace's cost events with the ones the body lists, as callAgent
//   records them, created now;
// - POST …/e2e/up-next replaces the workspace's approval items and step drafts with the ones the body
//   lists, sent from the signed-in user's account, connected, in the zone the body gives, an email
//   step from their mailbox, connected, in the same zone (gamma-p4-090) or the mailbox's own the body
//   gives (gamma-p6-050): each draft by messaging's factory, each item by approvals'
//   (@whytide/approvals/testing), opened for a person or for the campaign's mode and with the wait
//   the body gives, a drafting one's without its draft;
//   POST …/e2e/up-next/drafts/{id} writes a drafting one as its writer leaves it and attaches it to
//   its item as approvals' subscriber does, in the worker's stead;
// - POST …/e2e/enrollments replaces a person's enrollments and their steps with the ones the body
//   lists, oldest first, in the statuses it names, as campaigns and its sender leave them (the e2e
//   api runs no worker): a started one sent from the workspace's connected account;
// - POST …/e2e/linkedin-controls sets the platform's stop, the workspace's and the signed-in user's
//   account's pause, each held by the tester or the operator or lifted, as the operator's command
//   (beta-p1-060) leaves them: through linkedin's testing helpers (@whytide/linkedin/testing);
// - POST …/e2e/inbox replaces the workspace's threads, their messages and their replies' labels
//   with the ones the body lists, each thread's messages oldest first, as the receiver, the label
//   and the classifier leave them (the e2e api runs no worker): through inbox's testing helpers
//   (@whytide/inbox/testing), each thread on the signed-in user's account, connected, a label
//   theirs, one of the 7 (gamma-p4-055), a reply's classification as the classifier writes it,
//   acting on nothing; its person with a member id, which a reply from the inbox needs, unless
//   unreachable; with `keep`, the workspace's other threads stay, so a teammate's sit beside the
//   user's (gamma-p6-060);
//   POST …/e2e/inbox/replies/{id} settles a sending reply from the inbox as inbox's settle leaves
//   it, sent, or refused or failed with the body's code, in the worker's stead; POST
//   …/e2e/inbox/reply-drafts/{threadId} ends the thread's drafting reply draft as its run leaves it,
//   ready with the body's text or failed with its code, in the worker's stead;
// - POST …/e2e/linkedin-disclosure sets the signed-in user's account back to alpha's disclosure,
//   version 1 without the personal-account confirmation, as an account connected in alpha is;
// - POST …/e2e/counts replaces the workspace's enrollments and their steps with the ones the body
//   lists, each for a person of its own, in the statuses and at the times it gives, as campaigns and
//   its sender leave them (the e2e api runs no worker): through campaigns' createEnrollment
//   (@whytide/campaigns/testing), from the signed-in user's account, connected with the label and
//   the zone the body gives, or from an account id linkedin does not hold;
// - POST …/e2e/linkedin-health sets the signed-in user's account's health (setHealth), an event into
//   a new state, the cool-down's end, a pairing before it and, as the worker would, a status check;
// - POST …/e2e/email-mailbox removes the signed-in user's mailboxes, or marks their connected one's
//   token revoked as the worker would (email's markTokenRevoked; email-connect.spec.ts);
// - POST …/e2e/icp-draft writes the ICP's latest draft as icp's drafter leaves it (the e2e api runs
//   no worker): none, drafted with the body's proposal, or failed with its code, the last two under
//   the latest request's run, or E2E_DRAFT_RUN while the ICP has none;
// - POST …/e2e/members makes each user the body lists, by email, a member of the workspace with
//   the role it gives, an active one again if it was removed, and its name the body's; the
//   workspace's other members stay as they are;
// - POST …/e2e/agents removes the workspace's agents with their sources' links, signals' sources
//   and the audiences but the default, then writes the signed-in user's account and another
//   member's, both connected, and the sources the body lists, each read through one of the two, as
//   signals' factory writes one (signals' source checker reads them);
//   POST …/e2e/agents/{id}/owner-removed pauses the agents of the agent's owner as playbooks'
//   subscriber to tenancy.member_removed does, in the worker's stead (gamma-p6-075);
// - POST …/e2e/campaigns removes the workspace's campaigns with their versions and steps, with the
//   owner's client, since app may delete no version, then makes the signed-in user's account
//   connected, healthy and not paused, as linkedin's factory writes one ready to send, gives the
//   organization its grant for the period, and makes a draft of the body's name with the warm-signal
//   default, the user its owner: campaigns' createDraftCampaign (@whytide/campaigns/testing); with
//   `lockEnded`, its first 7 days over, as the days going by leave it: campaigns' setReviewLock
//   (gamma-p4-070);
// - POST …/e2e/agent-campaign makes the agent's campaign as campaigns' subscriber to
//   playbooks.playbook_created makes it (the e2e api runs no worker), owned by the agent's owner, as
//   the event carries it, and with `active` sets it active as a launch leaves it: campaigns'
//   createAgentCampaign and setCampaignActive (@whytide/campaigns/testing);
// - POST …/e2e/funnel removes the workspace's enrollments, their steps and its campaigns, as POST
//   …/e2e/campaigns does, then makes each campaign the body lists, active as a launch leaves it,
//   owned by the member of the email given or the signed-in user, and its enrollments, each for a
//   person of its own, with its steps and its reply's label at the times given, as campaigns, its
//   sender and the reply labels leave them (the e2e api runs no worker): campaigns'
//   createDraftCampaign, setCampaignActive and createEnrollment (@whytide/campaigns/testing);
// - POST …/e2e/health replaces the workspace's LinkedIn accounts and their health events with the
//   ones the body lists, with the owner's client, since app may delete no event, each owned by the
//   member of the email given, a user who is no member (`former`) or the signed-in user, with its
//   label, status, zone, pause and pending invitations, its events as applyHealth writes them and
//   its health as they leave it (linkedin's createConnectedAccount, setAccountPaused,
//   createHealthEvent and setHealth, @whytide/linkedin/testing);
// - POST …/e2e/enrichment/{personId} ends the person's latest enrichment run as the worker's run on
//   the fake port leaves it (the e2e api runs no worker), or writes one ended when there is none:
//   the company facts the body gives, written through contacts' upsertCompany with the class
//   open_data and a vendor's name, the run done with the fields filled and its source found
//   (gamma-en-055);
// - POST …/e2e/phones/{personId} writes a phone contact point on the person as the people's step keeps
//   one (a number and the page that printed it, no verification), under a vendor-free class
//   (gamma-wr-100);
// - POST …/e2e/work-email/{personId} ends the person's latest email lookup as the worker's lookup on
//   the fake finder and verifier leaves it, or writes one ended when there is none: with an
//   address, its contact point (a finder's class and a vendor's name) with the verdict given, the
//   lookup found on valid, else not_found with its reason; with none, not_found with the reason
//   given (gamma-en-081); at the time given, else now (gamma-en-100's time zone case).
import { randomUUID } from "node:crypto";
import { Body, Controller, HttpCode, Module, Param, Post } from "@nestjs/common";
import {
  addOptOut,
  applyQualification,
  createLeadForPerson,
  linkPersonToCompany,
  recordPersonEmail,
  upsertCompany,
  upsertPersonFromSource,
} from "@whytide/contacts";
import { createDbClient, Prisma, type PrismaClient, tenantClient } from "@whytide/db";
import {
  createLogger,
  credits,
  currentTenant,
  definePermissions,
  definePrices,
  newId,
  platformIds,
  registeredPrices,
} from "@whytide/platform";
import { z } from "zod";
import { ApiRoute } from "../../../openapi/route.ts";
import { Permission } from "../../../src/permission.ts";

// messaging's factory by its build's path, as src/modules.generated.ts loads the module: the api
// lists no module with a screen (core/apps/web/docs/screens.md).
type MessagingTesting = typeof import("../../../../../modules/messaging/dist/testing/index.js");
type SeededDraft = Parameters<MessagingTesting["writeMessageDraft"]>[1];
const { createMessageDraft, createStepDraft, writeMessageDraft }: MessagingTesting = await import(
  new URL("../../../../../../modules/messaging/dist/testing/index.js", import.meta.url).href
);
// approvals' factory, by its build's path too: "Up next" is a screen.
type ApprovalsTesting = typeof import("../../../../../modules/approvals/dist/testing/index.js");
const { attachStepDraft, createApprovalItem }: ApprovalsTesting = await import(
  new URL("../../../../../../modules/approvals/dist/testing/index.js", import.meta.url).href
);
// linkedin's switches the same way: the api's e2e server loads linkedin by its build too.
type LinkedinTesting = typeof import("../../../../../modules/linkedin/dist/testing/index.js");
const {
  createConnectedAccount,
  createHealthEvent,
  setAccountPaused,
  setHealth,
  setPlatformControls,
  setWorkspaceStopped,
}: LinkedinTesting = await import(
  new URL("../../../../../../modules/linkedin/dist/testing/index.js", import.meta.url).href
);
// email's revoked token too: the e2e server loads email by its build.
type EmailModule = typeof import("../../../../../modules/email/dist/index.js");
const { markTokenRevoked }: EmailModule = await import(
  new URL("../../../../../../modules/email/dist/index.js", import.meta.url).href
);
// inbox's helpers too: the e2e server loads inbox by its build.
type InboxTesting = typeof import("../../../../../modules/inbox/dist/testing/index.js");
const { createClassification, createLabel, createMessage, createThread }: InboxTesting =
  await import(
    new URL("../../../../../../modules/inbox/dist/testing/index.js", import.meta.url).href
  );
// campaigns' helpers too: the counts page and the campaign's page are screens.
type CampaignsTesting = typeof import("../../../../../modules/campaigns/dist/testing/index.js");
const {
  createAgentCampaign,
  createDraftCampaign,
  createEnrollment,
  setCampaignActive,
  setReviewLock,
}: CampaignsTesting = await import(
  new URL("../../../../../../modules/campaigns/dist/testing/index.js", import.meta.url).href
);
// playbooks' removal subscriber's body too: the e2e server loads playbooks by its build.
type PlaybooksTesting = typeof import("../../../../../modules/playbooks/dist/testing/index.js");
const { pauseRemovedMember }: PlaybooksTesting = await import(
  new URL("../../../../../../modules/playbooks/dist/testing/index.js", import.meta.url).href
);
// credits' price list writer too: the e2e server loads credits by its build.
type CreditsTesting = typeof import("../../../../../modules/credits/dist/testing/index.js");
const { assemblePrices, syncPrices }: CreditsTesting = await import(
  new URL("../../../../../../modules/credits/dist/testing/index.js", import.meta.url).href
);

export const permissions = definePermissions(
  [{ action: "e2e.write", roles: ["Owner", "Admin", "Member"] }],
  import.meta.url,
);
const prices = definePrices([{ action: "e2e.batch", credits: 5, unit: "lead" }], import.meta.url);

const lead = z.strictObject({
  /**
   * The person's profile, `https://linkedin.com/in/<slug>`; none for a person known by `email` alone,
   * with no LinkedIn profile (gamma-rf-050): contacts refuses a lead with neither.
   */
  slug: z
    .string()
    .regex(/^[a-z0-9-]{1,60}$/)
    .optional(),
  firstName: z.string().max(80).optional(),
  lastName: z.string().max(80).optional(),
  headline: z.string().max(200).optional(),
  title: z.string().max(120).optional(),
  companyName: z.string().max(120).optional(),
  locationText: z.string().max(120).optional(),
  source: z.enum(["imported", "signal"]),
  /**
   * createLeadForPerson's sources, in this order, which contacts checks, `at` an ISO time; none
   * gives the lead one of `source`'s kind, ref `e2e`.
   */
  sources: z
    .array(z.looseObject({ at: z.iso.datetime().optional() }))
    .max(5)
    .optional(),
  /** applyQualification's input without the person, which contacts checks; none leaves it pending. */
  decision: z.record(z.string(), z.unknown()).optional(),
  /** The person's company, upsertCompany's profile, which contacts checks, linked to the person. */
  company: z.looseObject({ name: z.string().max(120) }).optional(),
  /**
   * The person opted out: addOptOut by the system, `reply_opt_out` for true, else the reason code
   * given, which contacts checks (`complaint`, `email_unsubscribe`, `notice_opt_out` or another).
   */
  optedOut: z.union([z.boolean(), z.string().max(40)]).optional(),
  /** An email address the person holds, recorded as enrichment keeps one (gamma-rf-040). */
  email: z.email().max(254).optional(),
  /** The score_snapshots row and its criterion_verdicts, which the lead's decision points at. */
  snapshot: z
    .strictObject({
      status: z.enum(["qualified", "not_qualified", "needs_review"]),
      fitScore: z.int().min(0).max(100),
      confidence: z.enum(["high", "medium", "low"]),
      tier: z.enum(["hot", "warm", "cool"]),
      icpVersion: z.int().min(1),
      /** The audience it was judged against, by name: an audience made for it; else the default. */
      audience: z.string().min(1).max(120).optional(),
      summary: z.string().max(300),
      disqualifiers: z.array(z.string()).max(11),
      verdicts: z
        .array(
          z.strictObject({
            criterion: z.string(),
            verdict: z.string(),
            evidence: z.string().max(300),
            weight: z.int().min(0).max(100),
            points: z.number().min(0).max(1),
          }),
        )
        .max(6),
    })
    .optional(),
  /**
   * The intent_scores row as qualification's intent write leaves it (gamma-p5-065): the scores, the
   * lead's tier and each signal's part, strongest first, the first the why-now; computed now.
   */
  intent: z
    .strictObject({
      intentScore: z.int().min(0).max(100),
      priority: z.int().min(0).max(100),
      tier: z.enum(["hot", "warm", "cool"]).nullable(),
      boostUntil: z.iso.datetime().nullable(),
      breakdown: z
        .array(
          z.strictObject({
            eventId: z.string().max(64),
            kind: z.string(),
            role: z.string(),
            contribution: z.number().min(0),
            at: z.iso.datetime(),
          }),
        )
        .max(10),
    })
    .optional(),
});
const leadsBody = z.strictObject({ leads: z.array(lead).max(100) });
type LeadsBody = z.infer<typeof leadsBody>;
type Decision = Parameters<typeof applyQualification>[0];
type Company = Parameters<typeof upsertCompany>[0]["company"];
type LeadSource = Parameters<typeof createLeadForPerson>[0]["source"];
type Entry = Record<string, unknown> & { at?: string };
type Snapshot = NonNullable<LeadsBody["leads"][number]["snapshot"]>;
type Intent = NonNullable<LeadsBody["leads"][number]["intent"]>;
/** A prefixed id, `per_…`: a cost event's subject. */
const prefixedId = z.string().regex(/^[a-z][a-z0-9]*_[0-9A-Za-z]+$/);
const spendBody = z.strictObject({
  quantity: z.int().min(1).max(100),
  key: z
    .string()
    .regex(/^[a-z0-9:-]{1,60}$/)
    .optional(),
});
const priceNoticeBody = z.strictObject({
  /** e2e.batch's credits per unit, a decimal; absent, its declared price. */
  credits: z
    .string()
    .regex(/^\d{1,3}(?:\.\d{1,4})?$/)
    .optional(),
  /** e2e.batch's unit; absent, its declared one. */
  unit: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,39}$/)
    .optional(),
});
const costsBody = z.strictObject({
  costs: z
    .array(
      z.strictObject({
        feature: z.string().regex(/^[a-z][a-z0-9_]*$/),
        vendor: z.string().regex(/^[a-z][a-z0-9-]*$/),
        unitCost: z.string().regex(/^\d+(?:\.\d+)?$/),
        subjectRef: prefixedId.optional(),
      }),
    )
    .max(20),
});
/** A draft's channel and columns as messaging's factory reads them; the table checks their values. */
const draft = z.record(z.string(), z.unknown());
const draftsBody = z.strictObject({
  personId: z.string().min(1).max(64),
  drafts: z.array(draft).max(10),
});
const upNextBody = z.strictObject({
  /** The sender account's zone, an IANA name, which the table takes as given. */
  timeZone: z.string().min(1).max(64),
  /** The mailbox's, an email step's; the account's unless given. */
  mailboxTimeZone: z.string().min(1).max(64).optional(),
  items: z
    .array(
      z.strictObject({
        personId: z.string().min(1).max(64),
        stepKey: z.enum(["connect", "message_1", "follow_up_1", "follow_up_2", "email_1"]),
        scheduledFor: z.iso.datetime(),
        createdAt: z.iso.datetime().optional(),
        /** Who approves it: a person unless given, or the campaign's mode, which may decline it. */
        approvalBy: z.enum(["person", "mode"]).optional(),
        waitCode: z.literal("mode_declined").optional(),
        /** The step draft's columns; a `drafting` one is not attached to the item yet. */
        draft,
      }),
    )
    .max(20),
});
const UP_NEXT_ACCOUNT = {
  label: "Up next e2e",
  status: "connected" as const,
  provider: "fake",
  workingHours: { start: "09:00", end: "18:00", days: [1, 2, 3, 4, 5] },
};
/**
 * An email step's mailbox, at an address of its own: a byte for its token, which the table wants of
 * a connected one, since nothing sends from it and the e2e api runs no worker.
 */
const UP_NEXT_MAILBOX = {
  emailAddress: "up-next-e2e@example.com",
  displayName: "Up next e2e",
  provider: "google" as const,
  scopes: [],
  isFreeConsumer: false,
  status: "connected" as const,
  oauthTokenRef: new Uint8Array([0]),
};
/** campaigns' template (its domain/template/constants.ts): its id and version, and by step key… */
const TEMPLATE = { templateId: "linkedin_default", templateVersion: 1 } as const;
/** …each step's position and action. */
const TEMPLATE_STEPS = {
  connect: { position: 1, actionType: "invite" },
  message_1: { position: 2, actionType: "message" },
  follow_up_1: { position: 3, actionType: "message" },
  follow_up_2: { position: 4, actionType: "message" },
} as const;
/** A step's statuses (campaigns' StepExecutionStatus). */
const STEP_STATUSES = [
  "planned",
  "awaiting_approval",
  "scheduled",
  "executing",
  "succeeded",
  "failed",
  "skipped",
  "held",
  "cancelled",
] as const;
/** A reason code; the panel words the ones campaigns writes and says so for any other. */
const code = z.string().regex(/^[a-z][a-z_]{0,39}$/);
const enrollmentsBody = z.strictObject({
  personId: z.string().min(1).max(64),
  enrollments: z
    .array(
      z.strictObject({
        status: z.enum(["active", "replied", "completed", "exited"]),
        /** Set exactly when the status is exited: the table's CHECK refuses anything else. */
        exitReason: z
          .enum(["suppressed", "removed", "no_sender", "not_accepted", "send_refused"])
          .optional(),
        exitDetail: code.optional(),
        /** Whether its sequence started, from the workspace's connected account: unless exited. */
        started: z.boolean().optional(),
        steps: z
          .array(
            z.strictObject({
              stepKey: z.enum(["connect", "message_1", "follow_up_1", "follow_up_2"]),
              status: z.enum(STEP_STATUSES),
              dueAt: z.iso.datetime().optional(),
              scheduledFor: z.iso.datetime().optional(),
              executedAt: z.iso.datetime().optional(),
              skipReason: code.optional(),
              errorCode: code.optional(),
            }),
          )
          .max(4)
          .optional(),
      }),
    )
    .max(5),
});
/** Who holds a stop, or null: lifted. */
const holder = z.enum(["tester", "operator"]).nullable();
const linkedinControlsBody = z.strictObject({
  /** The platform's stop of every LinkedIn action, the operator's. */
  platformStopped: z.boolean(),
  /** The workspace's stop. */
  workspace: holder,
  /**
   * The signed-in user's account's pause, when the user has an account in the workspace: a removed
   * member's too, as their account keeps it after a new invite (gamma-p6-070).
   */
  account: z.enum(["tester", "operator", "member_removed"]).nullable(),
});
/**
 * A reply's labels (campaigns' REPLY_ACTION_LABELS), which the enrollments' CHECK holds too, as
 * reply_labels' class_label and reply_classifications' label do.
 */
const FUNNEL_REPLY_LABELS = [
  "interested",
  "not_now",
  "not_interested",
  "out_of_office",
  "opt_out",
  "bounce",
  "other",
] as const;
const inboxBody = z.strictObject({
  threads: z
    .array(
      z.strictObject({
        personId: z.string().min(1).max(64),
        /** Oldest first: the thread's last message time is the last one's. */
        messages: z
          .array(
            z.strictObject({
              direction: z.enum(["in", "out"]),
              /** An outbound message's sender: the campaign, approved at `approvedAt`, or the user. */
              sentBy: z.enum(["campaign", "user"]).optional(),
              body: z.string().min(1).max(500),
              sentAt: z.iso.datetime(),
              approvedAt: z.iso.datetime().optional(),
              /** A reply's label, one of the 7, chosen by the signed-in user (gamma-p4-055). */
              label: z.enum(FUNNEL_REPLY_LABELS).optional(),
              /** A reply's classification: suggested under 0.7 (inbox's README "The classifier"). */
              classification: z
                .strictObject({
                  label: z.enum(FUNNEL_REPLY_LABELS),
                  confidence: z.number().min(0).max(1),
                  isSuggested: z.boolean(),
                })
                .optional(),
            }),
          )
          .max(10),
        /** The person without a member id: no reply from the inbox reaches them. */
        unreachable: z.boolean().optional(),
      }),
    )
    .max(30),
  /** The workspace's threads stay, the teammates' among them: these are added. */
  keep: z.boolean().optional(),
});
/** A reply from the inbox settled: a code only on one not sent (the table's messages_send_status). */
const inboxReplyBody = z.strictObject({
  status: z.enum(["sent", "refused", "failed"]),
  errorCode: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,63}$/)
    .optional(),
});
/** A reply draft ended: ready with its text, or failed with a code (the table's reply_drafts_status). */
const replyDraftBody = z.strictObject({
  status: z.enum(["ready", "failed"]),
  text: z.string().min(1).max(1_900).optional(),
  errorCode: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,63}$/)
    .optional(),
});
const countsBody = z.strictObject({
  /** The signed-in user's account: its label, and its zone, an IANA name the table takes as given. */
  account: z.strictObject({
    label: z.string().min(1).max(100),
    timeZone: z.string().min(1).max(64),
  }),
  enrollments: z
    .array(
      z.strictObject({
        /** From an account id linkedin does not hold, rather than the signed-in user's account. */
        removedAccount: z.boolean().optional(),
        /** From this account, a teammate's (gamma-p6-070), rather than the signed-in user's. */
        senderAccountId: z.string().min(1).max(64).optional(),
        /** An exited one's reason is `removed`. */
        status: z.enum(["active", "replied", "completed", "exited"]),
        endedAt: z.iso.datetime().optional(),
        steps: z
          .array(
            z.strictObject({
              /** A key of the template, or another with its action: a withdrawal's. */
              stepKey: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
              actionType: z.enum(["invite", "message", "withdraw"]).optional(),
              status: z.enum(STEP_STATUSES),
              executedAt: z.iso.datetime().optional(),
              acceptedAt: z.iso.datetime().optional(),
            }),
          )
          .max(5),
      }),
    )
    .max(40),
});
/** The signed-in user's account on the counts page, connected, and an account linkedin does not hold. */
const COUNTS_ACCOUNT = {
  status: "connected" as const,
  provider: "fake",
  workingHours: { start: "09:00", end: "18:00", days: [1, 2, 3, 4, 5] },
};
/** The signed-in user's account the inbox's threads are on, connected. */
const INBOX_ACCOUNT = { ...COUNTS_ACCOUNT, label: "Inbox e2e", timeZone: "UTC" };
const REMOVED_ACCOUNT = "sac_e2e_counts_removed";
/** A warning's cool-down: paused_until 72 hours after the change. */
const COOLDOWN_MS = 72 * 3_600_000;
/** The trigger of the seeded event into each state. */
const HEALTH_TRIGGERS = {
  healthy: "manual",
  at_risk: "acceptance_rate",
  restricted: "limit_reached",
  checkpoint: "checkpoint",
  disconnected: "session_invalid",
} as const;
const emailMailboxBody = z.strictObject({ state: z.enum(["none", "token_revoked"]) });
/** A drafted or failed draft's run while no request gave the ICP one: the card's Use sends it back. */
const E2E_DRAFT_RUN = "idrun_e2e";
const icpDraftBody = z.strictObject({
  status: z.enum(["none", "drafted", "failed"]),
  /** A failed draft's code: ai_failed by default. */
  error: z.string().max(60).optional(),
  /** The drafted proposal, which icp's read checks against the drafter's schema (draft-profile.ts). */
  fields: z.record(z.string(), z.unknown()).optional(),
});

/** The members tenancy-members.spec.ts stands on, each by email, with a name or none. */
const membersBody = z.strictObject({
  members: z
    .array(
      z.strictObject({
        email: z.email().max(254),
        displayName: z.string().min(1).max(100).nullable(),
        role: z.enum(["Owner", "Member"]),
      }),
    )
    .max(10),
});

/** The agents' screens' sources, each read through the user's own account or another member's. */
const agentsBody = z.strictObject({
  sources: z.array(z.strictObject({ label: z.string().min(1).max(120), own: z.boolean() })).max(20),
});
/** The agents' screens' accounts, the signed-in user's and another member's. */
const AGENTS_ACCOUNT = {
  status: "connected" as const,
  provider: "fake",
  timeZone: "Europe/Paris",
  workingHours: { start: "09:00", end: "18:00", days: [1, 2, 3, 4, 5] },
};
/** The other member's user id: a source read through their account is no agent's of the user. */
const AGENTS_OTHER_OWNER = "usr_e2e_agents_other";
/** Each source's post, as signals' factory gives one. */
const AGENTS_POST_URL = "https://www.linkedin.com/feed/update/urn:li:activity:7250000000000000009";

const linkedinHealthBody = z.strictObject({
  /** The signed-in user's account's health; an event into it when it changes. */
  state: z.enum(["healthy", "at_risk", "restricted", "checkpoint", "disconnected"]),
  /** Restricted or checkpoint: minutes from now to the cool-down's end, negative once it is over. */
  cooldownEndsIn: z.int().min(-6_000).max(6_000).optional(),
  /** Minutes since the worker last read the status, as "Check status" leaves it; one by default. */
  statusCheckedAgo: z.int().min(0).max(6_000).optional(),
});

/** The campaign's page's draft: its name, which createCampaign checks; its lock over if asked. */
const campaignsBody = z.strictObject({
  name: z.string().max(120),
  lockEnded: z.boolean().optional(),
});
/** How long ago a draft's review_everything lock ended, with `lockEnded` (gamma-p4-070). */
const LOCK_ENDED_AGO_MS = 60_000;
const agentCampaignBody = z.strictObject({ playbookId: z.string().max(64), active: z.boolean() });
/** The sender account the Results page's enrollments name: the funnel reads none of its columns. */
const FUNNEL_SENDER = "sac_e2e_funnel";
/** The Results page's campaigns, each with its enrollments, their steps and their replies' labels. */
const funnelBody = z.strictObject({
  campaigns: z
    .array(
      z.strictObject({
        name: z.string().min(1).max(120),
        /** Its owner, the member with this email (POST …/e2e/members); the signed-in user if none. */
        ownerEmail: z.email().max(254).optional(),
        enrollments: z
          .array(
            z.strictObject({
              /** The reply's label and instant, as the labels leave them; the enrollment replied. */
              reply: z
                .strictObject({
                  label: z.enum(FUNNEL_REPLY_LABELS),
                  at: z.iso.datetime(),
                })
                .optional(),
              steps: z
                .array(
                  z.strictObject({
                    /** A key of the template, or another with its action: an email's, a withdrawal's. */
                    stepKey: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
                    actionType: z.enum(["invite", "message", "email", "withdraw"]).optional(),
                    status: z.enum(STEP_STATUSES),
                    executedAt: z.iso.datetime().optional(),
                    acceptedAt: z.iso.datetime().optional(),
                  }),
                )
                .max(6),
            }),
          )
          .max(20),
      }),
    )
    .max(5),
});

/** The Health page's accounts' owner when no member is named, a user who is no member. */
const FORMER_MEMBER = "usr_e2e_health_former";
const healthState = z.enum(["healthy", "at_risk", "restricted", "checkpoint", "disconnected"]);
/** A health event's triggers (linkedin's SenderHealthTrigger). */
const HEALTH_EVENT_TRIGGERS = [
  "acceptance_rate",
  "rate_limit_errors",
  "checkpoint",
  "limit_reached",
  "session_invalid",
  "manual",
] as const;
/** The Health page's accounts, each with its owner, status, pause, health and health events. */
const healthBody = z.strictObject({
  accounts: z
    .array(
      z.strictObject({
        /** The member with this email (POST …/e2e/members); a former member's with `former`. */
        ownerEmail: z.email().max(254).optional(),
        former: z.boolean().optional(),
        label: z.string().min(1).max(80),
        timeZone: z.string().min(1).max(64),
        status: z.enum(["pending", "connected", "credentials_required", "error", "disconnected"]),
        pausedBy: z.enum(["tester", "operator", "member_removed"]).optional(),
        state: healthState,
        /** Restricted or checkpoint: the cool-down's end. */
        pausedUntil: z.iso.datetime().optional(),
        pendingInvites: z.int().min(0).max(1_000).nullable(),
        /** Its health events, each written as applyHealth writes one; the last its state's. */
        events: z
          .array(
            z.strictObject({
              from: healthState,
              to: healthState,
              trigger: z.enum(HEALTH_EVENT_TRIGGERS),
              at: z.iso.datetime(),
            }),
          )
          .max(12),
      }),
    )
    .max(5),
});

/** The facts an enrichment run brings of the person's company, by contacts' field names. */
const enrichmentBody = z.strictObject({
  company: z.strictObject({
    domain: z.string().max(120).optional(),
    industry: z.string().max(120).optional(),
    sizeRange: z.string().max(40).optional(),
    employeeCount: z.int().min(1).optional(),
    country: z.string().max(2).optional(),
    description: z.string().max(500).optional(),
  }),
});
/** The stamp of the facts: open data's class and a vendor's name, which no answer may show. */
const ENRICHMENT_STAMP = { source: "open_data", provider: "wikidata" } as const;

/** How a lookup ends (enrichment's settle): the address kept with its verdict, or why there is none. */
const workEmailBody = z.strictObject({
  address: z.email().max(200).optional(),
  kind: z.enum(["work_email", "personal_email"]).default("work_email"),
  verdict: z.enum(["valid", "catch_all", "risky", "invalid", "unknown"]).default("valid"),
  reason: z
    .string()
    .regex(/^[a-z_]{1,40}$/)
    .optional(),
  /** When it ended and the address was checked; now unless given. */
  at: z.iso.datetime().optional(),
});
/** The stamp of an address: a finder's class and a vendor's name, which no answer may show. */
const phoneBody = z.strictObject({
  number: z.string().min(1).max(40),
  page: z.string().max(2048).optional(),
});
const WORK_EMAIL_STAMP = { sourceClass: "email_finder", provider: "hunter" } as const;

/** The owner's client, made once: the e2e resets' deletes that app may not make. */
let owner: PrismaClient | undefined;
function ownerClient(): PrismaClient {
  owner ??= createDbClient("owner");
  return owner;
}
/** The seeder's client, made once: billing_writer alone writes the price list. */
let billing: PrismaClient | undefined;
function billingClient(): PrismaClient {
  billing ??= createDbClient("billing_writer");
  return billing;
}
const log = createLogger();

@Controller()
export class E2eController {
  @Post("leads")
  @HttpCode(200)
  @Permission(permissions["e2e.write"])
  @ApiRoute({
    summary: "Replaces the workspace's leads with these, in this order; the persons stay",
    body: leadsBody,
    response: z.strictObject({ personIds: z.array(z.string()) }),
  })
  async leads(@Body() body: LeadsBody): Promise<{ personIds: string[] }> {
    await tenantClient.reviewDecision.deleteMany({});
    await tenantClient.leadStatusChange.deleteMany({});
    await tenantClient.lead.deleteMany({});
    await tenantClient.scoreSnapshot.deleteMany({});
    await tenantClient.intentScore.deleteMany({});
    // Opt-outs included, which no route removes: each spec's run starts from an empty list. app may
    // delete no entry (gamma-p2-040): the owner's client deletes the workspace's, on its own.
    const { workspaceId } = currentTenant();
    await ownerClient().suppressionEntry.deleteMany({ where: { workspaceId } });
    await ownerClient().exclusionListDomain.deleteMany({ where: { workspaceId } });
    await ownerClient().exclusionList.deleteMany({ where: { workspaceId } });
    const personIds: string[] = [];
    for (const { email, ...lead } of body.leads) {
      const { slug, source, sources, decision, snapshot, intent, company, optedOut, ...fields } =
        lead;
      // No slug: the person by the address alone, its hash recorded by the upsert (gamma-rf-050).
      const keys =
        slug === undefined
          ? { email: email ?? "" }
          : { linkedinUrl: `https://linkedin.com/in/${slug}` };
      const profile = { ...keys, ...fields };
      const from = source === "imported" ? "import" : "linkedin";
      const provider = source === "imported" ? "csv" : "unipile";
      const { person } = await upsertPersonFromSource({ source: from, provider, profile });
      const personId = person.id;
      if (company) {
        const written = await upsertCompany({
          source: from,
          provider,
          company: company as Company,
        });
        await linkPersonToCompany({ personId, companyId: written.company.id });
      }
      if (optedOut) {
        const reason = optedOut === true ? "reply_opt_out" : optedOut;
        await addOptOut(personId, { source: "system", reason });
      }
      if (email && slug !== undefined) await recordPersonEmail({ personId, address: email });
      const entries: Entry[] = sources ?? [{ kind: source, ref: "e2e" }];
      for (const { at, ...entry } of entries) {
        const given = { ...entry, at: at === undefined ? undefined : new Date(at) };
        await createLeadForPerson({ personId, source: given as LeadSource });
      }
      const snapshotId = snapshot && (await writeSnapshot(personId, snapshot));
      if (decision) await applyQualification({ ...decision, personId, snapshotId } as Decision);
      if (intent) await writeIntentRow(personId, intent);
      personIds.push(personId);
    }
    return { personIds };
  }

  @Post("spend")
  @HttpCode(200)
  @Permission(permissions["e2e.write"])
  @ApiRoute({
    summary: "Spends `quantity` units of e2e.batch: a reserve and its commit",
    body: spendBody,
    response: z.strictObject({ usageId: z.string(), credits: z.string() }),
  })
  async spend(@Body() { quantity, key }: z.infer<typeof spendBody>) {
    const { workspaceId } = currentTenant();
    await grantPeriod(workspaceId);
    const { usageId } = await credits.reserve({
      workspaceId,
      action: prices["e2e.batch"],
      quantity,
      idempotencyKey: `e2e:${key ?? randomUUID()}`,
      subjectRef: "e2e_batch",
      lease: "sync",
    });
    return credits.commit(usageId);
  }

  @Post("price-notice")
  @HttpCode(200)
  @Permission(permissions["e2e.write"])
  @ApiRoute({
    summary:
      "Writes the declared price list now, e2e.batch at `credits` and `unit`: a rise is announced, its declared price withdraws it",
    body: priceNoticeBody,
    response: z.strictObject({ version: z.int().nullable() }),
  })
  async priceNotice(@Body() body: z.infer<typeof priceNoticeBody>) {
    const declared = assemblePrices(registeredPrices().values(), process.env);
    const batch = (entry: (typeof declared)[number]) =>
      entry.action === prices["e2e.batch"] ? { ...entry, ...body } : entry;
    return { version: await syncPrices(billingClient(), declared.map(batch), log, new Date()) };
  }

  @Post("drafts")
  @HttpCode(200)
  @Permission(permissions["e2e.write"])
  @ApiRoute({
    summary: "Replaces the person's message drafts with these, oldest first",
    body: draftsBody,
    response: z.strictObject({ draftIds: z.array(z.string()) }),
  })
  async drafts(@Body() { personId, drafts }: z.infer<typeof draftsBody>) {
    const { workspaceId } = currentTenant();
    await tenantClient.messageDraft.deleteMany({ where: { personId } });
    const draftIds: string[] = [];
    for (const [index, columns] of drafts.entries()) {
      // A second apart, so that the list's newest first is the body's order reversed.
      const createdAt = new Date(Date.now() - (drafts.length - index) * 1_000);
      const input = { ...(columns as SeededDraft), workspaceId, personId, createdAt };
      draftIds.push(await createMessageDraft(input, tenantClient));
    }
    return { draftIds };
  }

  @Post("drafts/:id")
  @HttpCode(200)
  @Permission(permissions["e2e.write"])
  @ApiRoute({
    summary: "Writes a drafting draft as its writer leaves it, in the worker's stead",
    params: z.strictObject({ id: z.string().min(1).max(64) }),
    body: draft,
    response: z.strictObject({ written: z.int() }),
  })
  async written(@Param("id") id: string, @Body() columns: Record<string, unknown>) {
    return { written: await writeMessageDraft(id, columns as SeededDraft, tenantClient) };
  }

  @Post("up-next")
  @HttpCode(200)
  @Permission(permissions["e2e.write"])
  @ApiRoute({
    summary: "Replaces the workspace's approval items and step drafts with these",
    body: upNextBody,
    response: z.strictObject({
      items: z.array(z.strictObject({ id: z.string(), draftId: z.string() })),
    }),
  })
  async upNext(@Body() { timeZone, mailboxTimeZone, items }: z.infer<typeof upNextBody>) {
    const { workspaceId, principal } = currentTenant();
    await tenantClient.approvalItem.deleteMany({});
    await tenantClient.messageDraft.deleteMany({ where: { kind: "outbound_step" } });
    const owner = { workspaceId, ownerUserId: principal.userId };
    const account = { ...UP_NEXT_ACCOUNT, timeZone };
    const { id: senderAccountId } = await tenantClient.senderAccount.upsert({
      where: { workspaceId_ownerUserId: owner },
      create: { id: newId("sac"), ...owner, ...account, disclosureAcknowledgedAt: new Date() },
      update: account,
      select: { id: true },
    });
    const emails = items.some(({ stepKey }) => stepKey === "email_1");
    const mailboxZone = mailboxTimeZone ?? timeZone;
    const mailboxId = emails ? await upNextMailbox(principal.userId, mailboxZone) : undefined;
    const seeded: { id: string; draftId: string }[] = [];
    for (const { personId, stepKey, scheduledFor, createdAt, draft: columns, ...by } of items) {
      // campaigns' step id, which the e2e api, without campaigns, cannot draw from its prefix.
      const stepExecutionId = `sx_e2e${randomUUID().replaceAll("-", "")}`;
      const email = stepKey === "email_1" && mailboxId !== undefined ? { mailboxId } : undefined;
      const sender = email ?? { senderAccountId };
      const step = { workspaceId, personId, stepExecutionId, stepKey };
      const drafted = { ...(columns as SeededDraft), ...step, ...email };
      const draftId = await createStepDraft(drafted, tenantClient);
      const item = {
        ...step,
        ...sender,
        ...by,
        scheduledFor: new Date(scheduledFor),
        draftId: columns.status === "drafting" ? null : draftId,
        ...(createdAt === undefined ? {} : { createdAt: new Date(createdAt) }),
      };
      seeded.push({ id: await createApprovalItem(item, tenantClient), draftId });
    }
    return { items: seeded };
  }

  @Post("up-next/drafts/:id")
  @HttpCode(200)
  @Permission(permissions["e2e.write"])
  @ApiRoute({
    summary: "Writes a drafting step draft as its writer leaves it, then attaches it to its item",
    params: z.strictObject({ id: z.string().min(1).max(64) }),
    body: draft,
    response: z.strictObject({ written: z.int(), attached: z.int() }),
  })
  async upNextDraft(@Param("id") id: string, @Body() columns: Record<string, unknown>) {
    const written = await writeMessageDraft(id, columns as SeededDraft, tenantClient);
    const where = { id, kind: "outbound_step" as const };
    const select = { stepExecutionId: true };
    const ended = await tenantClient.messageDraft.findFirst({ where, select });
    const stepExecutionId = ended?.stepExecutionId;
    if (!stepExecutionId) return { written, attached: 0 };
    const attached = await attachStepDraft({ draftId: id, stepExecutionId }, tenantClient);
    return { written, attached };
  }

  @Post("linkedin-controls")
  @HttpCode(200)
  @Permission(permissions["e2e.write"])
  @ApiRoute({
    summary:
      "Sets the platform's stop, the workspace's and the signed-in user's account's pause, held by the tester or the operator or lifted",
    body: linkedinControlsBody,
    response: z.strictObject({ accountId: z.string().nullable() }),
  })
  async linkedinControls(@Body() body: z.infer<typeof linkedinControlsBody>) {
    const { workspaceId, principal } = currentTenant();
    await setPlatformControls({ stopped: body.platformStopped });
    await setWorkspaceStopped(workspaceId, body.workspace);
    const account = await tenantClient.senderAccount.findFirst({
      where: { ownerUserId: principal.userId },
      select: { id: true },
    });
    if (account !== null) await setAccountPaused(account.id, body.account);
    return { accountId: account?.id ?? null };
  }

  @Post("linkedin-disclosure")
  @HttpCode(200)
  @Permission(permissions["e2e.write"])
  @ApiRoute({
    summary:
      "Sets the signed-in user's account back to alpha's disclosure: version 1, no personal-account confirmation",
    response: z.strictObject({ accountId: z.string().nullable() }),
  })
  async linkedinDisclosure() {
    const where = { ownerUserId: currentTenant().principal.userId };
    const account = await tenantClient.senderAccount.findFirst({ where, select: { id: true } });
    const data = { disclosureVersion: 1, personalAccountConfirmedAt: null };
    if (account !== null) await tenantClient.senderAccount.update({ where: account, data });
    return { accountId: account?.id ?? null };
  }

  @Post("costs")
  @HttpCode(200)
  @Permission(permissions["e2e.write"])
  @ApiRoute({
    summary: "Replaces the workspace's cost events with these, created now",
    body: costsBody,
    response: z.strictObject({ count: z.int() }),
  })
  async costs(@Body() body: z.infer<typeof costsBody>): Promise<{ count: number }> {
    const { workspaceId } = currentTenant();
    await tenantClient.costEvent.deleteMany({});
    const data = body.costs.map(({ subjectRef, ...cost }) => ({
      ...cost,
      id: newId(platformIds.cost_event),
      workspaceId,
      units: { calls: 1 },
      priceListVersion: "e2e",
      subjectRef: subjectRef ?? null,
    }));
    return tenantClient.costEvent.createMany({ data });
  }

  @Post("enrollments")
  @HttpCode(200)
  @Permission(permissions["e2e.write"])
  @ApiRoute({
    summary: "Replaces the person's enrollments and their steps with these, oldest first",
    body: enrollmentsBody,
    response: z.strictObject({ enrollmentIds: z.array(z.string()) }),
  })
  async enrollments(@Body() { personId, enrollments }: z.infer<typeof enrollmentsBody>) {
    const { workspaceId } = currentTenant();
    // Steps first: a step's key to its enrollment refuses the enrollment's deletion.
    await tenantClient.stepExecution.deleteMany({ where: { personId } });
    await tenantClient.enrollment.deleteMany({ where: { personId } });
    const account = await tenantClient.senderAccount.findFirst({
      where: { status: "connected" },
      orderBy: { id: "asc" },
      select: { id: true },
    });
    const date = (at: string | undefined) => (at === undefined ? null : new Date(at));
    const enrollmentIds: string[] = [];
    for (const [index, seeded] of enrollments.entries()) {
      const { steps = [], started = seeded.status !== "exited", ...columns } = seeded;
      const senderAccountId = started ? account?.id : null;
      if (senderAccountId === undefined) throw new Error("e2e: no connected sender account");
      // A second apart, so that the panel's newest first is the body's order reversed.
      const createdAt = new Date(Date.now() - (enrollments.length - index) * 1_000);
      const id = newId("enl");
      await tenantClient.enrollment.create({
        data: {
          ...{ ...columns, ...TEMPLATE, id, workspaceId, personId, senderAccountId, createdAt },
          sourceEventId: newId(platformIds.outbox_entry),
          startedAt: started ? createdAt : null,
          endedAt: seeded.status === "active" ? null : createdAt,
        },
      });
      for (const { stepKey, dueAt, scheduledFor, executedAt, ...step } of steps) {
        if (senderAccountId === null) throw new Error("e2e: a step needs a started enrollment");
        const stepId = newId("sx");
        // The hash and the key stand in for campaigns' SHA-256s: no check reads them here.
        const keys = { stepTemplateHash: stepKey, idempotencyKey: stepId };
        await tenantClient.stepExecution.create({
          data: {
            ...{ ...step, ...TEMPLATE_STEPS[stepKey], ...TEMPLATE, ...keys, stepKey },
            ...{ id: stepId, workspaceId, enrollmentId: id, personId, senderAccountId },
            ...{ dueAt: date(dueAt), scheduledFor: date(scheduledFor) },
            executedAt: date(executedAt),
          },
        });
      }
      enrollmentIds.push(id);
    }
    return { enrollmentIds };
  }

  @Post("inbox")
  @HttpCode(200)
  @Permission(permissions["e2e.write"])
  @ApiRoute({
    summary: "Replaces the workspace's threads, messages and labels with these",
    body: inboxBody,
    response: z.strictObject({
      threads: z.array(z.strictObject({ id: z.string(), messageIds: z.array(z.string()) })),
    }),
  })
  async inbox(@Body() { threads, keep }: z.infer<typeof inboxBody>) {
    const { workspaceId, principal } = currentTenant();
    const labeledBy = principal.userId;
    if (!keep) {
      // Labels, then messages: a message's key to its thread refuses the thread's deletion.
      await tenantClient.replyLabel.deleteMany({});
      await tenantClient.message.deleteMany({});
      await tenantClient.thread.deleteMany({});
    }
    const owner = { workspaceId, ownerUserId: labeledBy };
    const { id: senderAccountId } = await tenantClient.senderAccount.upsert({
      where: { workspaceId_ownerUserId: owner },
      create: {
        id: newId("sac"),
        ...owner,
        ...INBOX_ACCOUNT,
        disclosureAcknowledgedAt: new Date(),
      },
      update: INBOX_ACCOUNT,
      select: { id: true },
    });
    const seeded: { id: string; messageIds: string[] }[] = [];
    for (const { personId, messages, unreachable } of threads) {
      // contacts' member id, as inbox's reply state reads it (inbox's domain/reply/channel.ts).
      const providerRefs = unreachable ? {} : { unipile: `e2e-member-${personId}` };
      await tenantClient.person.update({ where: { id: personId }, data: { providerRefs } });
      const last = messages.at(-1)?.sentAt;
      const lastMessageAt = last === undefined ? new Date() : new Date(last);
      const thread = { ...owner, personId, senderAccountId, lastMessageAt };
      const threadId = await createThread(thread, tenantClient);
      const messageIds: string[] = [];
      for (const { sentAt, approvedAt, label, classification, ...columns } of messages) {
        const approved = approvedAt === undefined ? undefined : new Date(approvedAt);
        const times = { sentAt: new Date(sentAt), approvedAt: approved };
        const message = { ...columns, ...times, workspaceId, threadId, personId };
        const messageId = await createMessage(message, tenantClient);
        const ids = { workspaceId, messageId };
        if (label) await createLabel({ ...ids, classLabel: label, labeledBy }, tenantClient);
        if (classification)
          await createClassification(
            { ...ids, threadId, personId, ...classification },
            tenantClient,
          );
        messageIds.push(messageId);
      }
      seeded.push({ id: threadId, messageIds });
    }
    return { threads: seeded };
  }

  @Post("inbox/replies/:id")
  @HttpCode(200)
  @Permission(permissions["e2e.write"])
  @ApiRoute({
    summary: "Settles a sending reply from the inbox as its send would, in the worker's stead",
    params: z.strictObject({ id: z.string().min(1).max(64) }),
    body: inboxReplyBody,
    response: z.strictObject({ settled: z.int() }),
  })
  async settleReply(
    @Param("id") id: string,
    @Body() { status, errorCode }: z.infer<typeof inboxReplyBody>,
  ) {
    // As domain/reply/settle.ts: sent with the provider's ref, else the code; a settled one stays.
    const data =
      status === "sent"
        ? { sendStatus: status, providerMessageRef: `e2e-reply-${id}` }
        : { sendStatus: status, errorCode: errorCode ?? null };
    const { count } = await tenantClient.message.updateMany({
      where: { id, sendStatus: "sending" },
      data,
    });
    return { settled: count };
  }

  @Post("inbox/reply-drafts/:threadId")
  @HttpCode(200)
  @Permission(permissions["e2e.write"])
  @ApiRoute({
    summary: "Ends the thread's drafting reply draft as its run would, in the worker's stead",
    params: z.strictObject({ threadId: z.string().min(1).max(64) }),
    body: replyDraftBody,
    response: z.strictObject({ settled: z.int() }),
  })
  async endReplyDraft(
    @Param("threadId") threadId: string,
    @Body() { status, text, errorCode }: z.infer<typeof replyDraftBody>,
  ) {
    // As inbox's domain/reply-draft/write.ts: the text and the model on a ready one, else the code.
    const data =
      status === "ready"
        ? { status, text: text ?? "Thanks, Tuesday works.", modelId: "e2e-model", promptVersion: 1 }
        : { status, errorCode: errorCode ?? "gates_failed" };
    const { count } = await tenantClient.replyDraft.updateMany({
      where: { threadId, status: "drafting" },
      data,
    });
    return { settled: count };
  }

  @Post("counts")
  @HttpCode(200)
  @Permission(permissions["e2e.write"])
  @ApiRoute({
    summary:
      "Replaces the workspace's enrollments and steps with these, from the signed-in user's account",
    body: countsBody,
    response: z.strictObject({ accountId: z.string() }),
  })
  async counts(@Body() { account, enrollments }: z.infer<typeof countsBody>) {
    const { workspaceId, principal } = currentTenant();
    // Steps first: a step's key to its enrollment refuses the enrollment's deletion.
    await tenantClient.stepExecution.deleteMany({});
    await tenantClient.enrollment.deleteMany({});
    const owner = { workspaceId, ownerUserId: principal.userId };
    const columns = { ...COUNTS_ACCOUNT, ...account };
    const { id: accountId } = await tenantClient.senderAccount.upsert({
      where: { workspaceId_ownerUserId: owner },
      create: { id: newId("sac"), ...owner, ...columns, disclosureAcknowledgedAt: new Date() },
      update: columns,
      select: { id: true },
    });
    const date = (at: string | undefined) => (at === undefined ? undefined : new Date(at));
    for (const { removedAccount, senderAccountId, endedAt, steps, ...enrollment } of enrollments) {
      const seeded = {
        ...{ ...enrollment, workspaceId, personId: newId("per"), endedAt: date(endedAt) },
        senderAccountId: removedAccount ? REMOVED_ACCOUNT : (senderAccountId ?? accountId),
        steps: steps.map(({ executedAt, acceptedAt, ...step }) => ({
          ...{ ...step, executedAt: date(executedAt), acceptedAt: date(acceptedAt) },
        })),
      };
      await createEnrollment(seeded, tenantClient);
    }
    return { accountId };
  }

  @Post("linkedin-health")
  @HttpCode(200)
  @Permission(permissions["e2e.write"])
  @ApiRoute({
    summary:
      "Sets the signed-in user's account's health, its cool-down's end and its status's last check, with an event into a new state",
    body: linkedinHealthBody,
    response: z.strictObject({ accountId: z.string().nullable() }),
  })
  async linkedinHealth(@Body() body: z.infer<typeof linkedinHealthBody>) {
    const where = { ownerUserId: currentTenant().principal.userId };
    const select = { id: true, healthState: true };
    const account = await tenantClient.senderAccount.findFirst({ where, select });
    if (account === null) return { accountId: null };
    const now = Date.now();
    const { state, cooldownEndsIn = -60, statusCheckedAgo = 1 } = body;
    const cooling = state === "restricted" || state === "checkpoint";
    const pausedUntil = cooling ? new Date(now + cooldownEndsIn * 60_000) : null;
    const at = new Date(pausedUntil === null ? now : pausedUntil.getTime() - COOLDOWN_MS);
    if (account.healthState !== state) {
      const event = { from: account.healthState, to: state, trigger: HEALTH_TRIGGERS[state] };
      await createHealthEvent(account.id, { ...event, at, pausedUntil });
    }
    await setHealth(account.id, state, { pausedUntil, at });
    // Paired before the change, so that a checkpoint's resume waits for a pairing.
    const connectedAt = new Date(at.getTime() - 3_600_000);
    const data = { connectedAt, statusCheckedAt: new Date(now - statusCheckedAgo * 60_000) };
    await tenantClient.senderAccount.update({ where: { id: account.id }, data });
    return { accountId: account.id };
  }

  @Post("email-mailbox")
  @HttpCode(200)
  @Permission(permissions["e2e.write"])
  @ApiRoute({
    summary:
      "Removes the signed-in user's mailboxes, or marks their connected one's token revoked as the worker would",
    body: emailMailboxBody,
    response: z.strictObject({ mailboxId: z.string().nullable() }),
  })
  async emailMailbox(@Body() body: z.infer<typeof emailMailboxBody>) {
    const where = { ownerUserId: currentTenant().principal.userId };
    if (body.state === "none") {
      await tenantClient.mailbox.deleteMany({ where });
      return { mailboxId: null };
    }
    const connected = { ...where, status: "connected" as const };
    const mailbox = await tenantClient.mailbox.findFirst({
      where: connected,
      select: { id: true },
    });
    if (mailbox !== null) await markTokenRevoked(mailbox.id, new Date());
    return { mailboxId: mailbox?.id ?? null };
  }

  @Post("icp-draft")
  @HttpCode(200)
  @Permission(permissions["e2e.write"])
  @ApiRoute({
    summary:
      "Writes the ICP's latest draft as the drafter leaves it: none, drafted with the body's proposal, or failed with its code",
    body: icpDraftBody,
    response: z.strictObject({ updated: z.number().int() }),
  })
  async icpDraft(@Body() body: z.infer<typeof icpDraftBody>) {
    const { status, error = "ai_failed", fields = {} } = body;
    const proposal = { model: "fake-model", promptVersion: 1, decisionRecordId: "dec_e2e_icp" };
    const pendingDraft =
      status === "drafted" ? ({ ...proposal, fields } as Prisma.InputJsonObject) : Prisma.DbNull;
    // A drafted or a failed draft has its run, and none has none, as after a Use or a Discard (icp's
    // domain/draft.ts).
    const latest = await tenantClient.icp.findFirst({ select: { draftRunId: true } });
    const data = {
      draftStatus: status,
      draftError: status === "failed" ? error : null,
      draftRunId: status === "none" ? null : (latest?.draftRunId ?? E2E_DRAFT_RUN),
      pendingDraft,
    };
    const { count } = await tenantClient.icp.updateMany({ data });
    return { updated: count };
  }

  @Post("members")
  @HttpCode(200)
  @Permission(permissions["e2e.write"])
  @ApiRoute({
    summary:
      "Makes each user the body lists a member of the workspace with its role, an active one again if it was removed",
    body: membersBody,
    response: z.strictObject({ membershipIds: z.array(z.string()) }),
  })
  async members(@Body() body: z.infer<typeof membersBody>) {
    const { workspaceId } = currentTenant();
    const membershipIds: string[] = [];
    for (const { email, displayName, role } of body.members) {
      // users is a global table, written as tenancy's upsertUser writes it; the membership in the run.
      const user = await tenantClient.user.upsert({
        where: { email },
        create: { id: newId("usr"), email, displayName },
        update: { displayName },
      });
      const active = { role, removedAt: null, removedBy: null };
      const membership = await tenantClient.membership.upsert({
        where: { workspaceId_userId: { workspaceId, userId: user.id } },
        create: { id: newId("mem"), workspaceId, userId: user.id, role },
        update: active,
      });
      membershipIds.push(membership.id);
    }
    return { membershipIds };
  }

  @Post("agents")
  @HttpCode(200)
  @Permission(permissions["e2e.write"])
  @ApiRoute({
    summary:
      "Removes the workspace's agents, sources and audiences but the default, then writes these sources, each read through the signed-in user's account or another member's",
    body: agentsBody,
    response: z.strictObject({ sourceIds: z.array(z.string()) }),
  })
  async agents(@Body() body: z.infer<typeof agentsBody>) {
    const { workspaceId, principal } = currentTenant();
    // The links first: a link's key to its agent refuses the agent's deletion.
    await tenantClient.playbookSource.deleteMany({});
    await tenantClient.playbook.deleteMany({});
    await tenantClient.signalSource.deleteMany({});
    await tenantClient.icp.deleteMany({ where: { isDefault: false } });
    const accountOf = async (ownerUserId: string, label: string) => {
      const owner = { workspaceId, ownerUserId };
      const columns = { ...AGENTS_ACCOUNT, label };
      const { id } = await tenantClient.senderAccount.upsert({
        where: { workspaceId_ownerUserId: owner },
        create: { id: newId("sac"), ...owner, ...columns, disclosureAcknowledgedAt: new Date() },
        update: columns,
        select: { id: true },
      });
      return id;
    };
    const own = await accountOf(principal.userId, "Agents e2e, own");
    const other = await accountOf(AGENTS_OTHER_OWNER, "Agents e2e, another member's");
    const sourceIds: string[] = [];
    for (const source of body.sources) {
      const row = {
        id: newId("src"),
        workspaceId,
        kind: "post_engagers",
        config: { postUrl: AGENTS_POST_URL },
        label: source.label,
        senderAccountId: source.own ? own : other,
        createdBy: principal.userId,
      };
      await tenantClient.signalSource.create({ data: row });
      sourceIds.push(row.id);
    }
    return { sourceIds };
  }

  @Post("agents/:id/owner-removed")
  @HttpCode(200)
  @Permission(permissions["e2e.write"])
  @ApiRoute({
    summary:
      "Pauses the agents of this agent's owner as playbooks' subscriber to tenancy.member_removed does, in the worker's stead",
    params: z.strictObject({ id: z.string().min(1).max(64) }),
    response: z.strictObject({ paused: z.int() }),
  })
  async agentOwnerRemoved(@Param("id") id: string) {
    const select = { ownerUserId: true };
    const agent = await tenantClient.playbook.findFirst({ where: { id }, select });
    return { paused: agent === null ? 0 : await pauseRemovedMember(agent.ownerUserId) };
  }

  @Post("campaigns")
  @HttpCode(200)
  @Permission(permissions["e2e.write"])
  @ApiRoute({
    summary:
      "Removes the workspace's campaigns, readies the signed-in user's account and the credits, then makes a draft of this name with the warm-signal default, its first 7 days over if asked",
    body: campaignsBody,
    response: z.strictObject({ campaignId: z.string() }),
  })
  async campaigns(@Body() { name, lockEnded }: z.infer<typeof campaignsBody>) {
    const { workspaceId, principal } = currentTenant();
    const ownerUserId = principal.userId;
    await removeCampaigns(workspaceId);
    const account = await tenantClient.senderAccount.findFirst({
      where: { ownerUserId },
      select: { id: true },
    });
    if (account === null) {
      await createConnectedAccount(workspaceId, { ownerUserId });
    } else {
      await setHealth(account.id, "healthy");
      await setAccountPaused(account.id, null);
    }
    await grantPeriod(workspaceId);
    const { id } = await createDraftCampaign({ workspaceId, ownerUserId, name });
    if (lockEnded === true) {
      const lockedUntil = new Date(Date.now() - LOCK_ENDED_AGO_MS);
      await setReviewLock({ workspaceId, campaignId: id, lockedUntil }, tenantClient);
    }
    return { campaignId: id };
  }

  @Post("agent-campaign")
  @HttpCode(200)
  @Permission(permissions["e2e.write"])
  @ApiRoute({
    summary:
      "Makes the agent's campaign as campaigns' subscriber to playbooks.playbook_created does, active if asked",
    body: agentCampaignBody,
    response: z.strictObject({ campaignId: z.string() }),
  })
  async agentCampaign(@Body() { playbookId, active }: z.infer<typeof agentCampaignBody>) {
    const { workspaceId } = currentTenant();
    const { ownerUserId } = await tenantClient.playbook.findFirstOrThrow({
      where: { id: playbookId },
      select: { ownerUserId: true },
    });
    const { id } = await createAgentCampaign({ workspaceId, playbookId, ownerUserId });
    if (active) await setCampaignActive({ workspaceId, campaignId: id }, tenantClient);
    return { campaignId: id };
  }

  @Post("funnel")
  @HttpCode(200)
  @Permission(permissions["e2e.write"])
  @ApiRoute({
    summary:
      "Replaces the workspace's campaigns, enrollments and steps with these, each campaign active and owned by the member named or the signed-in user",
    body: funnelBody,
    response: z.strictObject({ campaignIds: z.array(z.string()) }),
  })
  async funnel(@Body() body: z.infer<typeof funnelBody>) {
    const { workspaceId, principal } = currentTenant();
    // Steps first: a step's key to its enrollment refuses the enrollment's deletion.
    await tenantClient.stepExecution.deleteMany({});
    await tenantClient.enrollment.deleteMany({});
    await removeCampaigns(workspaceId);
    const date = (at: string | undefined) => (at === undefined ? undefined : new Date(at));
    const campaignIds: string[] = [];
    for (const { name, ownerEmail, enrollments } of body.campaigns) {
      // users is a global table: the member's user by its email, which the spec made a member.
      const ownerUserId =
        ownerEmail === undefined
          ? principal.userId
          : (await tenantClient.user.findUniqueOrThrow({ where: { email: ownerEmail } })).id;
      const { id } = await createDraftCampaign({ workspaceId, ownerUserId, name });
      await setCampaignActive({ workspaceId, campaignId: id }, tenantClient);
      for (const { reply, steps } of enrollments) {
        const person = { workspaceId, personId: newId("per"), senderAccountId: FUNNEL_SENDER };
        // A reply ends the enrollment on it, its label and instant set together.
        const replied =
          reply === undefined
            ? ({ status: "active" } as const)
            : ({ status: "replied", endedAt: new Date(reply.at) } as const);
        const seeded = {
          ...person,
          ...replied,
          templateId: id,
          reply: reply === undefined ? undefined : { label: reply.label, at: new Date(reply.at) },
          steps: steps.map(({ executedAt, acceptedAt, ...step }) => ({
            ...{ ...step, executedAt: date(executedAt), acceptedAt: date(acceptedAt) },
          })),
        };
        await createEnrollment(seeded, tenantClient);
      }
      campaignIds.push(id);
    }
    return { campaignIds };
  }
  @Post("health")
  @HttpCode(200)
  @Permission(permissions["e2e.write"])
  @ApiRoute({
    summary:
      "Replaces the workspace's LinkedIn accounts and their health events with these, each owned by the member named, a former member or the signed-in user",
    body: healthBody,
    response: z.strictObject({ accountIds: z.array(z.string()) }),
  })
  async health(@Body() body: z.infer<typeof healthBody>) {
    const { workspaceId, principal } = currentTenant();
    // app may delete no health event: the owner's client, the events before their accounts.
    await ownerClient().senderHealthEvent.deleteMany({ where: { workspaceId } });
    await ownerClient().senderAccount.deleteMany({ where: { workspaceId } });
    const accountIds: string[] = [];
    for (const {
      ownerEmail,
      former,
      label,
      status,
      pausedBy,
      state,
      events,
      ...account
    } of body.accounts) {
      // users is a global table: the member's user by its email, which the spec made a member.
      const ownerUserId = former
        ? FORMER_MEMBER
        : ownerEmail === undefined
          ? principal.userId
          : (await tenantClient.user.findUniqueOrThrow({ where: { email: ownerEmail } })).id;
      const { timeZone, pendingInvites } = account;
      const { id } = await createConnectedAccount(workspaceId, {
        ownerUserId,
        timeZone,
        pendingInvites,
      });
      await setAccountPaused(id, pausedBy ?? null);
      for (const { at, ...event } of events)
        await createHealthEvent(id, { ...event, at: new Date(at) });
      const pausedUntil = account.pausedUntil === undefined ? null : new Date(account.pausedUntil);
      const last = events.at(-1);
      await setHealth(id, state, { pausedUntil, at: last ? new Date(last.at) : undefined });
      // Last: linkedin's helpers write on its own client, which would wait on this run's row lock.
      await tenantClient.senderAccount.update({ where: { id }, data: { label, status } });
      accountIds.push(id);
    }
    return { accountIds };
  }

  @Post("enrichment/:personId")
  @HttpCode(200)
  @Permission(permissions["e2e.write"])
  @ApiRoute({
    summary:
      "Ends the person's latest enrichment run with these company facts, as the run on the fake port would, in the worker's stead",
    params: z.strictObject({ personId: z.string().min(1).max(64) }),
    body: enrichmentBody,
    response: z.strictObject({ runId: z.string() }),
  })
  async endEnrichment(
    @Param("personId") personId: string,
    @Body() { company: facts }: z.infer<typeof enrichmentBody>,
  ) {
    const person = await tenantClient.person.findFirstOrThrow({ where: { id: personId } });
    const company = await tenantClient.workspaceCompany.findFirstOrThrow({
      where: { id: person.companyId ?? "" },
    });
    // As enrichment's step: the company's own name and keys, then the facts, with the source's stamp.
    const keys = { name: company.name, linkedinUrl: company.linkedinUrl ?? undefined };
    const profile = { ...keys, domain: company.domain ?? undefined, ...facts } as Company;
    await upsertCompany({ ...ENRICHMENT_STAMP, company: profile });
    const filled = Object.keys(facts);
    // What the source answered, as the run records it: its name, which no answer may show.
    const tried = [
      { source: "company-data/wikidata", outcome: "found", code: null, filled, ms: 1 },
    ];
    const finished = {
      ...{ status: "done" as const, filled, wanted: filled, sourcesTried: tried },
      finishedAt: new Date(),
    };
    const latest = await tenantClient.enrichmentRun.findFirst({
      where: { personId },
      orderBy: { createdAt: "desc" },
    });
    if (latest) {
      await tenantClient.enrichmentRun.update({ where: { id: latest.id }, data: finished });
      return { runId: latest.id };
    }
    const { workspaceId } = currentTenant();
    const id = newId("erun");
    const requestKey = `request:${randomUUID()}`;
    const run = { id, workspaceId, personId, trigger: "request" as const, requestKey };
    await tenantClient.enrichmentRun.create({ data: { ...run, ...finished } });
    return { runId: id };
  }

  @Post("phones/:personId")
  @HttpCode(200)
  @Permission(permissions["e2e.write"])
  @ApiRoute({
    summary:
      "Writes a phone contact point on the person, as the people's step of web research keeps one: the number and the page that printed it",
    params: z.strictObject({ personId: z.string().min(1).max(64) }),
    body: phoneBody,
    response: z.strictObject({ contactPointId: z.string() }),
  })
  async keepPhone(@Param("personId") personId: string, @Body() body: z.infer<typeof phoneBody>) {
    const { workspaceId } = currentTenant();
    const id = newId("cp");
    const at = new Date();
    await tenantClient.contactPoint.create({
      data: {
        ...{ id, workspaceId, personId, kind: "phone", value: body.number },
        ...{ sourceClass: "web_page", provider: "research", pageUrl: body.page ?? null },
        ...{ acquiredAt: at, legalBasis: "legitimate_interest" },
      },
    });
    return { contactPointId: id };
  }

  @Post("work-email/:personId")
  @HttpCode(200)
  @Permission(permissions["e2e.write"])
  @ApiRoute({
    summary:
      "Ends the person's latest email lookup with this address and verdict, or this reason, as the lookup on the fakes would, in the worker's stead",
    params: z.strictObject({ personId: z.string().min(1).max(64) }),
    body: workEmailBody,
    response: z.strictObject({ requestId: z.string() }),
  })
  async endWorkEmail(
    @Param("personId") personId: string,
    @Body() body: z.infer<typeof workEmailBody>,
  ) {
    const { workspaceId } = currentTenant();
    const at = body.at === undefined ? new Date() : new Date(body.at);
    let contactPointId: string | null = null;
    if (body.address !== undefined) {
      // As the settle keeps one: the address on the person, its verdict and time renewed.
      const value = body.address.toLowerCase();
      const kept = await tenantClient.contactPoint.findFirst({ where: { value } });
      contactPointId = kept?.id ?? newId("cp");
      const checked = { verification: body.verdict, verifiedAt: at, updatedAt: at };
      if (kept) {
        await tenantClient.contactPoint.update({ where: { id: kept.id }, data: checked });
      } else {
        await tenantClient.contactPoint.create({
          data: {
            ...{ id: contactPointId, workspaceId, personId, value, kind: body.kind, ...checked },
            ...{ ...WORK_EMAIL_STAMP, acquiredAt: at, legalBasis: "legitimate_interest" },
          },
        });
      }
    }
    const found = body.address !== undefined && body.verdict === "valid";
    const reason = found ? null : (body.reason ?? "not_verified");
    // What the steps answered, as the lookup records them: names, which no answer may show.
    const tried = [
      { source: "email-finder/hunter", step: "find", outcome: "found", code: null, ms: 1 },
      {
        source: "email-verifier/zerobounce",
        step: "verify",
        outcome: body.verdict,
        code: null,
        ms: 1,
      },
    ];
    const ended = {
      ...{ status: found ? ("found" as const) : ("not_found" as const), reason },
      ...{ providersTried: tried, contactPointId: found ? contactPointId : null },
      ...{ finishedAt: at, updatedAt: at },
    };
    const latest = await tenantClient.enrichmentRequest.findFirst({
      where: { personId },
      orderBy: { createdAt: "desc" },
    });
    if (latest) {
      await tenantClient.enrichmentRequest.update({ where: { id: latest.id }, data: ended });
      return { requestId: latest.id };
    }
    const id = newId("enr");
    const requestKey = `request:${randomUUID()}`;
    const request = { id, workspaceId, personId, trigger: "request" as const, requestKey };
    await tenantClient.enrichmentRequest.create({ data: { ...request, ...ended } });
    return { requestId: id };
  }
}

/**
 * The workspace's campaigns removed, with their versions and steps: app may update and delete no
 * version or step (campaigns' README "Campaigns and versions"), so the owner's client, the current
 * versions first let go, then the keys' order, steps to campaigns.
 */
async function removeCampaigns(workspaceId: string) {
  const owner = ownerClient();
  const where = { workspaceId };
  await owner.campaign.updateMany({ where, data: { currentVersionId: null } });
  await owner.step.deleteMany({ where });
  await owner.campaignVersion.deleteMany({ where });
  await owner.campaign.deleteMany({ where });
}

/** The organization's grant for the period, which the worker (absent here) gives a new one. */
/** The user's mailbox, connected, in the zone, at UP_NEXT_MAILBOX's address: an email step's. Its id. */
async function upNextMailbox(ownerUserId: string, timeZone: string): Promise<string> {
  const { workspaceId } = currentTenant();
  const domain = "example.com";
  const { id: sendingDomainId } = await tenantClient.sendingDomain.upsert({
    where: { workspaceId_domain: { workspaceId, domain } },
    create: { id: newId("dom"), workspaceId, domain },
    update: {},
    select: { id: true },
  });
  const { emailAddress } = UP_NEXT_MAILBOX;
  const columns = { ...UP_NEXT_MAILBOX, ownerUserId, sendingDomainId, timeZone };
  const { id } = await tenantClient.mailbox.upsert({
    where: { workspaceId_emailAddress: { workspaceId, emailAddress } },
    create: { id: newId("mbx"), workspaceId, ...columns, connectedAt: new Date() },
    update: columns,
    select: { id: true },
  });
  return id;
}

async function grantPeriod(workspaceId: string) {
  const workspace = await tenantClient.workspace.findUnique({
    where: { id: workspaceId },
    select: { organizationId: true },
  });
  if (workspace) {
    await tenantClient.$queryRaw`SELECT credits_seed_self_hosted(${workspace.organizationId})`;
  }
}

/**
 * The person's snapshot, scored, and its verdicts: the rows qualification writes (its
 * docs/data.md); with `audience`, against a new audience of that name, not the default
 * (gamma-p5-050).
 */
async function writeSnapshot(personId: string, { verdicts, audience, ...snapshot }: Snapshot) {
  const { workspaceId } = currentTenant();
  const id = newId("ssn");
  const model = { modelId: "fake-model", promptVersion: 1, scorerVersion: "fit-v1" };
  let judged = {};
  if (audience !== undefined) {
    const icpId = newId("icp");
    await tenantClient.icp.create({
      data: { id: icpId, workspaceId, name: audience, isDefault: false },
    });
    judged = { icpId };
  }
  const decisionRecordId = `dr_${id}`;
  const row = { ...snapshot, ...model, ...judged, id, workspaceId, personId, decisionRecordId };
  await tenantClient.scoreSnapshot.create({ data: row as Prisma.ScoreSnapshotCreateInput });
  const rows = verdicts.map((verdict) => ({ ...verdict, id: newId("cvd"), workspaceId }));
  const data = rows.map((verdict) => ({ ...verdict, snapshotId: id }));
  await tenantClient.criterionVerdict.createMany({
    data: data as Prisma.CriterionVerdictCreateManyInput[],
  });
  return id;
}

/** The lead's intent row, its parts with no source's creator, as a deleted source's are. */
async function writeIntentRow(personId: string, { breakdown, boostUntil, ...scores }: Intent) {
  const { workspaceId } = currentTenant();
  const row = {
    ...scores,
    workspaceId,
    personId,
    intentBreakdown: breakdown.map((part) => ({ ...part, ownerUserId: null })),
    whyNowEventId: breakdown[0]?.eventId ?? null,
    boostUntil: boostUntil === null ? null : new Date(boostUntil),
    scorerVersion: "intent-v1",
    computedAt: new Date(),
  };
  await tenantClient.intentScore.create({ data: row as Prisma.IntentScoreCreateInput });
}

@Module({ controllers: [E2eController] })
export class E2eApi {}
