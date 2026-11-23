// The Unipile adapter of the LinkedIn port (README.md): the user's own account through Unipile's
// hosted authentication, then reads and the send side, over Unipile's REST API with Node's fetch
// from this folder only; no SDK (README.md "Covers"): invitations in invites.ts, messages in
// messages.ts, a post's engagers in engagers.ts, the post reads in posts.ts, a company page in
// company.ts, a 1st-degree connection's "Contact info" emails in contact.ts (gamma-en-087), under
// cursors signed
// with UNIPILE_CURSOR_SECRET (cursor.ts). Every answer is mapped to the port's words and parsed with
// its schemas, so that a vendor field that is not a business field stops here. The webhooks are
// webhooks.ts's: the three sources behind the shared secret header, and the hosted-auth notify
// behind the pairing token that createHostedAuthLink puts in the link's name (README.md "Webhooks",
// "Pairing").
import { randomUUID } from "node:crypto";
import { AppError } from "@whytide/platform";
import { z } from "zod";
import { defineAdapter, type PortImplementation } from "../../_pattern/index.ts";
import { type AccountStatus, linkedinPort, linkedinProfile } from "../port.ts";
import { notFound, offShape, segment, unipileClient } from "./client.ts";
import { getCompany } from "./company.ts";
import { unipileConfig } from "./config.ts";
import { PROVIDER_REF_PREFIX, RELATION, SECRET_MIN_CHARS } from "./constants.ts";
import { getContactEmails } from "./contact.ts";
import { signedCursors } from "./cursor.ts";
import { listPostEngagers } from "./engagers.ts";
import { invites } from "./invites.ts";
import { messaging } from "./messages.ts";
import { posts } from "./posts.ts";
import { webhooks } from "./webhooks.ts";

export { SECRET_HEADER } from "./constants.ts";

export type UnipileOptions = {
  /** The account's API address, `https://apiN.unipile.com:PORT`; a test passes its loopback server. */
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly webhookSecret: string;
  /** The key cursors are signed with (cursor.ts). */
  readonly cursorSecret: string;
  /** The public URL of POST /v1/linkedin/webhooks/unipile; createHostedAuthLink needs it. */
  readonly notifyUrl?: string | undefined;
  /** The clock; a test sets it. */
  readonly now?: () => number;
  /** How long a request may take, TIMEOUT_MS unless a test sets it. */
  readonly timeoutMs?: number;
};

const BLOCK = "packages/providers";
const ref = z.string().min(1).max(256);
const hostedLink = z.object({ url: z.url({ protocol: /^https$/ }).max(2048) });
const account = z.object({ type: z.string(), sources: z.array(z.object({ status: z.string() })) });
/** The account's own member id in its details, when Unipile gives one (README.md "Covers"). */
const ownMember = z.object({ connection_params: z.object({ im: z.object({ id: ref }) }) });
const user = z.object({
  provider_id: z.string(),
  public_identifier: z.string(),
  first_name: z.string().nullish(),
  last_name: z.string().nullish(),
  headline: z.string().nullish(),
  location: z.string().nullish(),
  /** The member's distance from the account, as getRelation reads it: FIRST_DEGREE, a relation. */
  network_distance: z.string().nullish(),
  work_experience: z
    .array(
      z.object({
        position: z.string().nullish(),
        company: z.string().nullish(),
        company_url: z.string().nullish(),
        industry: z.string().nullish(),
        current: z.boolean().nullish(),
      }),
    )
    .nullish(),
});

export function unipileLinkedin({
  baseUrl,
  apiKey,
  webhookSecret,
  cursorSecret,
  notifyUrl,
  now = Date.now,
  timeoutMs,
}: UnipileOptions): PortImplementation<typeof linkedinPort> {
  const call = unipileClient(baseUrl, apiKey, now, timeoutMs);
  const { pairingName, parseWebhook } = webhooks(webhookSecret);
  const cursors = signedCursors(cursorSecret);
  return {
    createHostedAuthLink: async ({ successUrl, failureUrl, expiresInMin }) => {
      if (!notifyUrl) {
        const variables = ["UNIPILE_NOTIFY_URL: required to create a hosted link"];
        throw new AppError("config_invalid", { details: { block: BLOCK, variables } });
      }
      const providerRef = `${PROVIDER_REF_PREFIX}${randomUUID()}`;
      const expiresAt = new Date(now() + expiresInMin * 60_000);
      const body = {
        type: "create",
        providers: ["LINKEDIN"],
        api_url: new URL(baseUrl).origin,
        expiresOn: expiresAt.toISOString(),
        success_redirect_url: successUrl,
        failure_redirect_url: failureUrl,
        notify_url: notifyUrl,
        // Echoed in the notify, whose only proof is the token (README.md "Pairing").
        name: pairingName(providerRef),
        single_use: true,
        disabled_options: ["cookie_auth"],
      };
      const link = hostedLink.safeParse(
        await call("createHostedAuthLink", { path: "/hosted/accounts/link", body }),
      );
      if (!link.success) throw offShape("createHostedAuthLink");
      return { url: link.data.url, expiresAt, providerRef };
    },
    getAccountStatus: async (providerAccountRef) => {
      const path = `/accounts/${segment(providerAccountRef, "getAccountStatus")}`;
      const answer = await call("getAccountStatus", { path });
      const found = account.safeParse(answer);
      if (!found.success) throw offShape("getAccountStatus");
      if (found.data.type !== "LINKEDIN") throw notFound("getAccountStatus");
      const status = statusOf(found.data.sources.map((source) => source.status));
      const memberRef = ownMember.safeParse(answer).data?.connection_params.im.id ?? null;
      return { status, checkedAt: new Date(now()), memberRef };
    },
    listPostEngagers: (input) => listPostEngagers(call, now, cursors, input),
    getProfile: async ({ providerAccountRef, profileUrl }) => {
      const handle = handleOf(profileUrl);
      if (handle === undefined) throw notFound("getProfile");
      // One section, the experience, for the title and the company; notify=false: no profile view.
      const query = {
        account_id: providerAccountRef,
        linkedin_sections: "experience",
        notify: "false",
      };
      const path = `/users/${segment(handle, "getProfile")}`;
      const found = user.safeParse(await call("getProfile", { path, query }));
      if (!found.success) throw offShape("getProfile");
      const { data } = found;
      const job = data.work_experience?.find((item) => item.current) ?? data.work_experience?.[0];
      const companyUrl = linkedinProfile.shape.companyUrl.safeParse(job?.company_url ?? undefined);
      const profile = linkedinProfile.safeParse({
        providerMemberRef: data.provider_id,
        profileUrl: `https://www.linkedin.com/in/${encodeURIComponent(data.public_identifier)}`,
        firstName: data.first_name ?? "",
        lastName: data.last_name ?? "",
        headline: data.headline ?? "",
        title: job?.position ?? "",
        companyName: job?.company ?? "",
        ...(companyUrl.data ? { companyUrl: companyUrl.data } : {}),
        locationText: data.location ?? "",
        ...(job?.industry ? { industry: job.industry } : {}),
        ...(data.network_distance ? { connected: data.network_distance === RELATION } : {}),
        fetchedAt: new Date(now()),
      });
      if (!profile.success) throw offShape("getProfile");
      return profile.data;
    },
    parseWebhook,
    ...invites(call, now, cursors),
    ...messaging(call, now),
    ...posts(call, cursors),
    getCompany: getCompany(call, now),
    getContactEmails: getContactEmails(call),
  };
}

export const unipileAdapter = defineAdapter(linkedinPort, {
  name: "unipile",
  requires: [
    "UNIPILE_BASE_URL",
    "UNIPILE_API_KEY",
    "UNIPILE_WEBHOOK_SECRET",
    "UNIPILE_CURSOR_SECRET",
  ],
  create: () => {
    const {
      UNIPILE_BASE_URL: baseUrl,
      UNIPILE_API_KEY: apiKey,
      UNIPILE_WEBHOOK_SECRET: webhookSecret,
      UNIPILE_CURSOR_SECRET: cursorSecret,
      UNIPILE_NOTIFY_URL: notifyUrl,
    } = unipileConfig;
    const required = "required by the unipile adapter";
    const long = `at least ${SECRET_MIN_CHARS} characters, ${required}`;
    const isLong = (value?: string) => (value?.length ?? 0) >= SECRET_MIN_CHARS;
    const variables = [
      ...(baseUrl ? [] : [`UNIPILE_BASE_URL: ${required}`]),
      ...(apiKey ? [] : [`UNIPILE_API_KEY: ${required}`]),
      ...(isLong(webhookSecret) ? [] : [`UNIPILE_WEBHOOK_SECRET: ${long}`]),
      ...(isLong(cursorSecret) ? [] : [`UNIPILE_CURSOR_SECRET: ${long}`]),
    ];
    if (!baseUrl || !apiKey || !webhookSecret || !cursorSecret || variables.length > 0) {
      throw new AppError("config_invalid", { details: { block: BLOCK, variables } });
    }
    return unipileLinkedin({ baseUrl, apiKey, webhookSecret, cursorSecret, notifyUrl });
  },
});

/** The member's public handle in a profile URL, `/in/<handle>/`, decoded; undefined for any other. */
function handleOf(profileUrl: string): string | undefined {
  const handle = /^\/in\/([\w%-]{1,200})\/?$/.exec(new URL(profileUrl).pathname)?.[1];
  try {
    return handle === undefined ? undefined : decodeURIComponent(handle);
  } catch {
    return undefined;
  }
}

/** A source's status: CREDENTIALS first, then connected while every source runs, else error. */
function statusOf(statuses: readonly string[]): AccountStatus["status"] {
  if (statuses.includes("CREDENTIALS")) return "credentials_required";
  const running = statuses.every((status) => status === "OK" || status === "CONNECTING");
  return statuses.length > 0 && running ? "connected" : "error";
}
