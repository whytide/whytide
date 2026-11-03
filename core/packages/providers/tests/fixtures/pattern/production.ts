// Run by tests/pattern.test.ts as a child process under APP_ENV=production, which the platform's
// config reads once at import; prints what the boundary did, as JSON. The fixture port, by default:
// a vendor's field passes through and no cause is kept; with checkOutputs and keepCause set on the
// binding, both are on. The LinkedIn port, defined with alwaysCheckOutputs: an extra key in any of
// its eleven outputs fails, a binding's checkOutputs: false notwithstanding, and a message's text
// in listRecentMessages too; a vendor's error keeps no cause.
import { isAppError } from "@whytide/platform";
import { bindPort, type PortImplementation } from "../../../_pattern/index.ts";
import { linkedinPort } from "../../../linkedin/port.ts";
import { fixturePort } from "./fixture/port.ts";

type Linkedin = PortImplementation<typeof linkedinPort>;
type Method = keyof Linkedin;

const vendorError = () => Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
/** A call's value, or its code, details and whether a cause was kept. */
const outcome = (call: () => Promise<unknown>) =>
  call().then(
    (value) => ({ value }),
    (error: unknown) =>
      isAppError(error)
        ? { code: error.code, details: error.details, cause: error.cause !== undefined }
        : { thrown: String(error) },
  );

const leaking: PortImplementation<typeof fixturePort> = {
  greet: async ({ name }) => ({ greeting: `hello ${name}`, vendor_id: "grt_1" }) as never,
  count: async () => {
    throw vendorError();
  },
};
const fixtureCalls = (options: { checkOutputs?: boolean; keepCause?: boolean }) => {
  const fixture = bindPort(fixturePort, leaking, { adapter: "leaking", ...options });
  return Promise.all([outcome(() => fixture.greet({ name: "Ada" })), outcome(fixture.count)]);
};

const at = new Date("2026-10-29T08:00:00.000Z");
const account = "account-1";
const member = "member-1";
/** A good input and a good output per method; the adapters below add to the output. */
const CALLS: { readonly [M in Method]: readonly [Parameters<Linkedin[M]>[0], object] } = {
  createHostedAuthLink: [
    {
      successUrl: "https://app.whytide.test/ok",
      failureUrl: "https://app.whytide.test/ko",
      expiresInMin: 30,
    },
    { url: "https://link.example.test/1", expiresAt: at, providerRef: "link-1" },
  ],
  getAccountStatus: [account, { status: "connected", checkedAt: at, memberRef: member }],
  listPostEngagers: [
    {
      providerAccountRef: account,
      postUrl: "https://www.linkedin.com/feed/update/urn:li:activity:7000000000000000001/",
      limit: 10,
    },
    { engagers: [], nextCursor: null },
  ],
  getProfile: [
    { providerAccountRef: account, profileUrl: "https://www.linkedin.com/in/ada-example" },
    {
      providerMemberRef: member,
      profileUrl: "https://www.linkedin.com/in/ada-example",
      firstName: "Ada",
      lastName: "Example",
      headline: "Head of Growth at Example",
      title: "Head of Growth",
      companyName: "Example Ltd",
      locationText: "London, United Kingdom",
      fetchedAt: at,
    },
  ],
  parseWebhook: [
    { headers: {}, rawBody: "{}" },
    { kind: "account.disconnected", providerAccountRef: account },
  ],
  sendInvite: [
    { providerAccountRef: account, memberRef: member, idempotencyKey: "key-1" },
    { invitationRef: "invitation-1", sentAt: at },
  ],
  sendMessage: [
    { providerAccountRef: account, memberRef: member, text: "Hello", idempotencyKey: "key-2" },
    { messageRef: "message-1", chatRef: "chat-1", sentAt: at },
  ],
  withdrawInvite: [
    { providerAccountRef: account, invitationRef: "invitation-1" },
    { withdrawnAt: at },
  ],
  listPendingInvites: [{ providerAccountRef: account }, { invites: [], nextCursor: null }],
  listRecentMessages: [
    { providerAccountRef: account, memberRef: member, since: at },
    { messages: [] },
  ],
  getRelation: [
    { providerAccountRef: account, memberRef: member },
    { connected: true, invitationPending: false },
  ],
};
const methods = Object.keys(CALLS) as Method[];
/** Every method answers its good output with `extra` spread in, or `answer` when it names one. */
const adapter = (extra: object, answer: Partial<Record<Method, object>> = {}) =>
  Object.fromEntries(
    methods.map((method) => [
      method,
      async () => answer[method] ?? { ...CALLS[method][1], ...extra },
    ]),
  ) as unknown as Linkedin;
const call = (linkedin: Linkedin, method: Method) =>
  outcome(() => (linkedin[method] as (input: unknown) => Promise<unknown>)(CALLS[method][0]));

const vendorField = { vendor_id: "vnd_1" };
const checked = bindPort(linkedinPort, adapter(vendorField), { adapter: "extra-key" });
const extraKey = Object.fromEntries(
  await Promise.all(methods.map(async (method) => [method, await call(checked, method)])),
);
const off = bindPort(linkedinPort, adapter(vendorField), {
  adapter: "checks-off",
  checkOutputs: false,
});
const withText = {
  listRecentMessages: {
    messages: [
      { messageRef: "message-1", chatRef: "chat-1", fromAccount: false, sentAt: at, text: "Hi" },
    ],
  },
};
const texting = bindPort(linkedinPort, adapter({}, withText), { adapter: "text" });
const throwing = { ...adapter({}), sendInvite: leaking.count } as unknown as Linkedin;

console.log(
  JSON.stringify({
    fixture: {
      defaults: await fixtureCalls({}),
      turnedOn: await fixtureCalls({ checkOutputs: true, keepCause: true }),
    },
    linkedin: {
      extraKey,
      checkOutputsOff: await call(off, "getProfile"),
      textInMessages: await call(texting, "listRecentMessages"),
      vendorError: await call(
        bindPort(linkedinPort, throwing, { adapter: "vendor" }),
        "sendInvite",
      ),
    },
  }),
);
