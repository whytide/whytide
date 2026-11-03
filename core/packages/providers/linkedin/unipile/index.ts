// The Unipile adapter of the LinkedIn port (README.md): the user's own account through Unipile's
// hosted authentication, then reads, over Unipile's REST API with Node's fetch from this folder only;
// no SDK (README.md "Covers"). Every answer is mapped to the port's words and parsed with its
// schemas, so that a vendor field that is not a business field stops here. A webhook is accepted
// only with the shared secret header, compared in constant time, whatever its body: a hosted-auth
// notify without it, as Unipile documents the notify, connects nothing (README.md "Webhooks").
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { AppError } from "@whytide/platform";
import { z } from "zod";
import { defineAdapter, type PortImplementation } from "../../_pattern/index.ts";
import {
  type AccountStatus,
  type LinkedinWebhookEvent,
  linkedinPort,
  linkedinProfile,
} from "../port.ts";
import { type Method, notFound, providerError, segment, unipileClient } from "./client.ts";
import { unipileConfig } from "./config.ts";
import { listPostEngagers } from "./engagers.ts";

/** The header the account-status webhook is registered with, holding UNIPILE_WEBHOOK_SECRET. */
export const SECRET_HEADER = "unipile-auth";

export type UnipileOptions = {
  /** The account's API address, `https://apiN.unipile.com:PORT`; a test passes its loopback server. */
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly webhookSecret: string;
  /** The public URL of POST /v1/linkedin/webhooks/unipile; createHostedAuthLink needs it. */
  readonly notifyUrl?: string | undefined;
  /** The clock; a test sets it. */
  readonly now?: () => number;
};

const { errors } = linkedinPort;
const BLOCK = "packages/providers";
const ref = z.string().min(1).max(256);
const hostedLink = z.object({ url: z.url({ protocol: /^https$/ }).max(2048) });
const account = z.object({ type: z.string(), sources: z.array(z.object({ status: z.string() })) });
const user = z.object({
  provider_id: z.string(),
  public_identifier: z.string(),
  first_name: z.string().nullish(),
  last_name: z.string().nullish(),
  headline: z.string().nullish(),
  location: z.string().nullish(),
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
/** The hosted-auth notify: our link's name with the new account. */
const notify = z.object({
  status: z.enum(["CREATION_SUCCESS", "RECONNECTED"]),
  account_id: ref,
  name: ref,
});
/** The account-status webhook, for the events README.md "Webhooks" registers. */
const accountStatus = z.object({
  AccountStatus: z.object({
    account_id: ref,
    account_type: z.literal("LINKEDIN"),
    message: z.enum(["CREATION_SUCCESS", "RECONNECTED", "CREDENTIALS", "DELETED"]),
  }),
});
const KINDS = {
  CREATION_SUCCESS: "account.connected",
  RECONNECTED: "account.connected",
  CREDENTIALS: "account.credentials_required",
  DELETED: "account.disconnected",
} as const satisfies Record<string, LinkedinWebhookEvent["kind"]>;

export function unipileLinkedin({
  baseUrl,
  apiKey,
  webhookSecret,
  notifyUrl,
  now = Date.now,
}: UnipileOptions): PortImplementation<typeof linkedinPort> {
  const call = unipileClient(baseUrl, apiKey, now);
  const secret = digest(webhookSecret);
  return {
    createHostedAuthLink: async ({ successUrl, failureUrl, expiresInMin }) => {
      if (!notifyUrl) {
        const variables = ["UNIPILE_NOTIFY_URL: required to create a hosted link"];
        throw new AppError("config_invalid", { details: { block: BLOCK, variables } });
      }
      const providerRef = `whytide-${randomUUID()}`;
      const expiresAt = new Date(now() + expiresInMin * 60_000);
      const body = {
        type: "create",
        providers: ["LINKEDIN"],
        api_url: new URL(baseUrl).origin,
        expiresOn: expiresAt.toISOString(),
        success_redirect_url: successUrl,
        failure_redirect_url: failureUrl,
        notify_url: notifyUrl,
        name: providerRef,
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
      const found = account.safeParse(await call("getAccountStatus", { path }));
      if (!found.success) throw offShape("getAccountStatus");
      if (found.data.type !== "LINKEDIN") throw notFound("getAccountStatus");
      const status = statusOf(found.data.sources.map((source) => source.status));
      return { status, checkedAt: new Date(now()) };
    },
    listPostEngagers: (input) => listPostEngagers(call, now, input),
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
        fetchedAt: new Date(now()),
      });
      if (!profile.success) throw offShape("getProfile");
      return profile.data;
    },
    parseWebhook: async ({ headers, rawBody }) => {
      const given = Object.entries(headers).find(([name]) => name.toLowerCase() === SECRET_HEADER);
      const value = given?.[1];
      if (typeof value !== "string" || !timingSafeEqual(digest(value), secret)) {
        throw webhookInvalid("secret");
      }
      const event = eventOf(jsonOf(rawBody));
      if (event === undefined) throw webhookInvalid("body");
      return event;
    },
  };
}

export const unipileAdapter = defineAdapter(linkedinPort, {
  name: "unipile",
  requires: ["UNIPILE_BASE_URL", "UNIPILE_API_KEY", "UNIPILE_WEBHOOK_SECRET"],
  create: () => {
    const {
      UNIPILE_BASE_URL: baseUrl,
      UNIPILE_API_KEY: apiKey,
      UNIPILE_WEBHOOK_SECRET: webhookSecret,
      UNIPILE_NOTIFY_URL: notifyUrl,
    } = unipileConfig;
    const required = "required by the unipile adapter";
    const variables = [
      ...(baseUrl ? [] : [`UNIPILE_BASE_URL: ${required}`]),
      ...(apiKey ? [] : [`UNIPILE_API_KEY: ${required}`]),
      ...((webhookSecret?.length ?? 0) >= 32
        ? []
        : [`UNIPILE_WEBHOOK_SECRET: at least 32 characters, ${required}`]),
    ];
    if (!baseUrl || !apiKey || !webhookSecret || variables.length > 0) {
      throw new AppError("config_invalid", { details: { block: BLOCK, variables } });
    }
    return unipileLinkedin({ baseUrl, apiKey, webhookSecret, notifyUrl });
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

const offShape = (method: Method) =>
  providerError(method, { reason: "an answer off the documented shape" });
/** Nothing of the body or the secret in it. */
const webhookInvalid = (reason: string) =>
  new AppError(errors.linkedin_webhook_invalid, { details: { method: "parseWebhook", reason } });
const digest = (value: string) => createHash("sha256").update(value).digest();

function jsonOf(rawBody: string | Uint8Array): unknown {
  try {
    return JSON.parse(typeof rawBody === "string" ? rawBody : Buffer.from(rawBody).toString());
  } catch {
    return undefined;
  }
}

function eventOf(body: unknown): LinkedinWebhookEvent | undefined {
  const link = notify.safeParse(body);
  if (link.success) {
    const { account_id: providerAccountRef, name: providerRef } = link.data;
    return { kind: "account.connected", providerAccountRef, providerRef };
  }
  const status = accountStatus.safeParse(body);
  if (!status.success) return undefined;
  const { account_id: providerAccountRef, message } = status.data.AccountStatus;
  return { kind: KINDS[message], providerAccountRef };
}
