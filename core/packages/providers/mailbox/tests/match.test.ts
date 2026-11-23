// The one rule (../match.ts) on synthetic messages: each kind from a message's thread and head, in
// its order, a report before the mailbox's own message before an unsubscribe mail before a reply;
// a subject's leading space or fold, and every Message-ID of In-Reply-To; a report naming a matched
// Message-ID only; the plain text, its encodings, its charsets and its cut; the subject's encoded
// words; a platform thread, with readThread's selection; the head from its six fields alone, as a
// provider gives them, read in linear time; a message that does not read, which gives no error; and
// the fake, which reads the raw messages it keeps through the same code.
import assert from "node:assert/strict";
import { test } from "node:test";
import { bindPort } from "../../_pattern/index.ts";
import { HEAD_FIELDS, MAILBOX_TEXT_MAX_CHARS, SUBJECT_MAX_CHARS } from "../constants.ts";
import { connectByConsent, rawMessage } from "../contract.ts";
import { mailboxFake } from "../fake/index.ts";
import { headOf, isPlatformThread, mailboxMatcher, platformThread } from "../match.ts";
import { messageIdFor } from "../message-id.ts";
import { plainTextOf, readText } from "../mime.ts";
import { mailboxPort } from "../port.ts";
import { readReport } from "../reports.ts";

const ME = "member@example.test";
const LEAD = "lead@example.test";
const SENT = messageIdFor({ idempotencyKey: "match-sent", domain: "example.test" });
const OTHER = messageIdFor({ idempotencyKey: "match-other", domain: "example.test" });
const REPORT = 'multipart/report; report-type=delivery-status; boundary="b"';
let clock = Date.UTC(2026, 10, 1);

/** A synthetic message in the thread, and its head as an adapter reads it; a minute after the last. */
function message(threadRef: string, fields: Record<string, string>, body = "Hello.") {
  clock += 60_000;
  const all = { "Message-ID": `<${clock}@mail.example>`, ...fields };
  const raw = [...Object.entries(all).map(([name, value]) => `${name}: ${value}`), "", body];
  const text = raw.join("\r\n");
  const at = new Date(clock);
  const head = headOf({
    messageRef: `m-${clock}`,
    threadRef,
    at,
    fields: readText(text).fields ?? [],
  });
  return { head, raw: text };
}
/** The same message, its head from the fields as a provider may give them: values untrimmed, a fold kept. */
function provided(threadRef: string, fields: Record<string, string>) {
  const { head, raw } = message(threadRef, fields);
  const given = Object.entries(fields).map(([name, value]) => ({ name, value }));
  return {
    head: headOf({ messageRef: head.messageRef, threadRef, at: head.at, fields: given }),
    raw,
  };
}
/** A multipart/report in the platform thread, its parts given as [type, content]. */
const reportOf = (...parts: [string, string][]) =>
  message(
    "t-platform",
    { From: `Mailer <mailer-daemon@example.test>`, "Content-Type": REPORT },
    [
      ...parts.map(([type, content]) => `--b\r\nContent-Type: ${type}\r\n\r\n${content}`),
      "--b--",
    ].join("\r\n"),
  );
const dsn = (action: string, status: string, original = SENT) =>
  reportOf(
    [
      "message/delivery-status",
      `Reporting-MTA: dns; mx.example.test\r\n\r\nAction: ${action}\r\nStatus: ${status}`,
    ],
    ["text/rfc822-headers", `Message-ID: <${original}>`],
  );
const arf = (type: string, original = SENT) =>
  reportOf(
    ["message/feedback-report", `Feedback-Type: ${type}\r\nVersion: 1`],
    ["message/rfc822", `Message-ID: <${original}>\r\n\r\nHello.`],
  );
const match = {
  threadRefs: ["t-platform"],
  messageIds: [SENT],
  unsubscribeSubjectPrefix: "unsub-",
};
const matcher = mailboxMatcher({ address: ME, match });
const eventOf = ({ head, raw }: ReturnType<typeof message>) =>
  matcher.mayMatch(head) ? matcher.eventOf(head, raw) : undefined;

test("each kind from the thread and the head, in order: report, the mailbox's own, unsubscribe, reply; nothing else", () => {
  const cases: [string, ReturnType<typeof message>, string][] = [
    ["a reply in the platform thread", message("t-platform", { From: `Lead <${LEAD}>` }), "reply"],
    [
      "a reply elsewhere naming the send in References",
      message("t-x", { From: LEAD, References: `<a@b> <${SENT}>` }),
      "reply",
    ],
    [
      "a reply elsewhere naming the send in In-Reply-To",
      message("t-x", { From: LEAD, "In-Reply-To": `<${SENT}>` }),
      "reply",
    ],
    [
      "a reply elsewhere, without References, naming the send second in In-Reply-To",
      message("t-x", { From: LEAD, "In-Reply-To": `<a@b> <${SENT}>` }),
      "reply",
    ],
    [
      "the mailbox's own message in the platform thread",
      message("t-platform", { From: ME }),
      "sent",
    ],
    [
      "the platform's send, its thread not known yet",
      message("t-new", { From: `Me <${ME}>`, "Message-ID": `<${SENT}>` }),
      "sent",
    ],
    [
      "the mailbox's own message elsewhere, naming the send",
      message("t-x", { From: ME, "In-Reply-To": `<${SENT}>` }),
      "none",
    ],
    [
      "an unsubscribe mail, in the platform thread too",
      message("t-platform", { From: LEAD, Subject: "unsub-0001" }),
      "unsubscribe_request",
    ],
    [
      "an unsubscribe mail whose subject a provider gives with a leading space",
      provided("t-platform", { From: LEAD, Subject: " unsub-0001" }),
      "unsubscribe_request",
    ],
    [
      "an unsubscribe mail whose subject a provider gives with a leading fold",
      provided("t-platform", { From: LEAD, Subject: "\r\n unsub-0001" }),
      "unsubscribe_request",
    ],
    [
      "an unsubscribe mail whose raw subject has a leading fold",
      message("t-platform", { From: LEAD, Subject: "\r\n unsub-0001" }),
      "unsubscribe_request",
    ],
    [
      "an unsubscribe mail whose subject's encoded word starts with a space",
      message("t-platform", { From: LEAD, Subject: "=?utf-8?Q?_unsub-0001?=" }),
      "unsubscribe_request",
    ],
    [
      "a report in the platform thread, naming another Message-ID",
      dsn("failed", "5.1.1", OTHER),
      "none",
    ],
    [
      "a personal message",
      message("t-personal", { From: "friend@personal.example", Subject: "Dinner?" }),
      "none",
    ],
    [
      "a newsletter naming a Message-ID outside the match",
      message("t-news", { From: "news@shop.example", References: `<${OTHER}>` }),
      "none",
    ],
    ["a message without a From in the platform thread", message("t-platform", {}), "reply"],
  ];
  for (const [name, given, kind] of cases) assert.equal(eventOf(given)?.kind ?? "none", kind, name);
  const reply = eventOf(cases[0]?.[1] as ReturnType<typeof message>);
  assert.ok(reply?.kind === "reply");
  assert.deepEqual([reply.fromAddress, reply.inReplyTo, reply.text], [LEAD, null, "Hello."]);
  // A reply's inReplyTo is the platform Message-ID it answers, the one the caller finds its send by:
  // In-Reply-To's matched one, else References' matched one, else In-Reply-To's first.
  const answered = (threadRef: string, fields: Record<string, string>) => {
    const event = eventOf(message(threadRef, { From: LEAD, ...fields }));
    return event?.kind === "reply" ? event.inReplyTo : event?.kind;
  };
  assert.equal(answered("t-x", { "In-Reply-To": `<a@b> <${SENT}>` }), SENT);
  assert.equal(
    answered("t-x", { "In-Reply-To": "<a@b>", References: `<c@d> <${SENT}> <a@b>` }),
    SENT,
    "a reply elsewhere naming another id in In-Reply-To and the send in References",
  );
  assert.equal(answered("t-x", { References: `<a@b> <${SENT}>` }), SENT);
  assert.equal(
    answered("t-platform", { "In-Reply-To": "<a@b> <c@d>", References: "<a@b>" }),
    "a@b",
  );
});

test("a report is never a reply: a bounce or a complaint naming a matched Message-ID only; a delay none; a failure without a readable status 5.0.0", () => {
  const summary = (given: ReturnType<typeof message>) => {
    const event = eventOf(given);
    if (event?.kind === "bounce")
      return [event.kind, event.originalMessageId, event.permanent, event.status];
    if (event?.kind === "complaint")
      return [event.kind, event.originalMessageId, event.feedbackType];
    return [event?.kind ?? "none"];
  };
  assert.deepEqual(
    [
      dsn("failed", "5.1.1"),
      dsn("failed", "4.4.7 (expired)"),
      dsn("delayed", "4.4.1"),
      dsn("failed", "x"),
    ].map(summary),
    [
      ["bounce", SENT, true, "5.1.1"],
      ["bounce", SENT, false, "4.4.7"],
      ["none"],
      ["bounce", SENT, true, "5.0.0"],
    ],
  );
  assert.deepEqual([arf("abuse"), arf("(none)"), arf("abuse", OTHER)].map(summary), [
    ["complaint", SENT, "abuse"],
    ["complaint", SENT, "other"],
    ["none"],
  ]);
});

test("the text: the first text/plain part that is no attachment, quoted-printable or base64 in its charset, LF line ends; HTML only or an attachment none; cut at MAILBOX_TEXT_MAX_CHARS whole characters; the subject's encoded words", () => {
  const textOf = (fields: Record<string, string>, body: string) => {
    const event = eventOf(message("t-platform", { From: LEAD, ...fields }, body));
    return event?.kind === "reply" ? [event.subject, event.text] : [];
  };
  const multipart = (type: string, boundary: string, ...parts: string[]) =>
    [
      { "Content-Type": `${type}; boundary="${boundary}"` },
      [...parts.map((part) => `--${boundary}\r\n${part}`), `--${boundary}--`].join("\r\n"),
    ] as const;
  const qp =
    "Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nCaf=C3=A9 =\r\nau lait";
  const html = "Content-Type: text/html\r\n\r\n<p>Hello</p>";
  const latin1 = Buffer.from("Café\r\nau lait", "latin1").toString("base64");
  const based = `Content-Type: text/plain; charset=iso-8859-1\r\nContent-Transfer-Encoding: base64\r\n\r\n${latin1}`;
  const attached =
    "Content-Type: text/plain\r\nContent-Disposition: attachment; filename=a.txt\r\n\r\nNot read.";
  const second = "Content-Type: text/plain\r\n\r\nThe second text.";
  assert.deepEqual(textOf(...multipart("multipart/alternative", "p", qp, html)), [
    "",
    "Café au lait",
  ]);
  assert.deepEqual(textOf(...multipart("multipart/mixed", "p", based)), ["", "Café\nau lait"]);
  assert.deepEqual(textOf(...multipart("multipart/mixed", "p", html, attached)), ["", ""]);
  assert.deepEqual(textOf(...multipart("multipart/mixed", "p", attached, second, qp)), [
    "",
    "The second text.",
  ]);
  // The usual shape: an attachment after the alternatives, which a mixed multipart holds.
  const [alternative, inner] = multipart("multipart/alternative", "q", html, qp);
  const nested = `Content-Type: ${alternative["Content-Type"]}\r\n\r\n${inner}`;
  assert.deepEqual(textOf(...multipart("multipart/mixed", "p", nested, attached)), [
    "",
    "Café au lait",
  ]);
  const unknown =
    "Content-Type: text/plain; charset=x-unknown\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nCaf=C3=A9, read as UTF-8.";
  assert.deepEqual(textOf(...multipart("multipart/mixed", "p", unknown)), [
    "",
    "Café, read as UTF-8.",
  ]);
  const subjects = [
    ["=?UTF-8?B?w4dhIHZh?= =?utf-8?Q?_bien?=", "Ça va bien"],
    ["Re: =?iso-8859-1?Q?Caf=E9?= today", "Re: Café today"],
    ["=?x-unknown?Q?Caf=C3=A9?=", "Café"],
  ];
  for (const [subject, decoded] of subjects)
    assert.deepEqual(textOf({ Subject: subject as string }, "Hello."), [decoded, "Hello."]);
  const [, long = ""] = textOf({}, "😀".repeat(MAILBOX_TEXT_MAX_CHARS + 5));
  assert.equal(long, "😀".repeat(MAILBOX_TEXT_MAX_CHARS));
});

test("a platform thread: its earliest message the mailbox's own under the platform's form; readThread's newest limit in date order, and more", () => {
  const sent = message("t-1", { From: ME, "Message-ID": `<${SENT}>` });
  const reply = message("t-1", { From: LEAD, "In-Reply-To": `<${SENT}>` });
  const typed = message("t-1", { From: ME });
  const heads = [typed.head, reply.head, sent.head]; // in no order: the earliest by date counts
  assert.equal(isPlatformThread(heads, ME), true);
  assert.equal(isPlatformThread(heads, LEAD), false, "another mailbox's address");
  assert.equal(isPlatformThread([reply.head, typed.head], ME), false, "started by the lead");
  const byHand = message("t-2", { From: ME });
  assert.equal(isPlatformThread([byHand.head], ME), false, "the mail program's Message-ID");
  const read = platformThread(heads, { address: ME, threadRef: "t-1", limit: 2 });
  assert.deepEqual(
    read?.newest.map((head) => head.messageRef),
    [reply.head.messageRef, typed.head.messageRef],
  );
  assert.equal(read?.more, true);
  const events = [sent, reply, typed].map(
    ({ head, raw }) => read?.matcher.eventOf(head, raw)?.kind,
  );
  assert.deepEqual(events, ["sent", "reply", "sent"]);
  assert.equal(
    platformThread([byHand.head], { address: ME, threadRef: "t-2", limit: 2 }),
    undefined,
  );
});

test("the head from its six HEAD_FIELDS alone is the head from every field, whatever case the provider gives the names in and whatever white space around the values", () => {
  const { raw } = message("t-platform", {
    From: `Lead <${LEAD}>`,
    To: ME,
    Subject: "=?utf-8?Q?Re:_Caf=C3=A9?=",
    "In-Reply-To": `<${SENT}>`,
    References: `<a@b> <${SENT}>`,
    "Content-Type": REPORT,
    "X-Mailer": "Synthetic",
  });
  const fields = readText(raw).fields ?? [];
  const refs = { messageRef: "m-head", threadRef: "t-platform", at: new Date(clock) };
  const six = fields.filter(({ name }) => HEAD_FIELDS.includes(name));
  const shouted = six.map(({ name, value }) => ({ name: name.toUpperCase(), value }));
  const padded = six.map(({ name, value }) => ({ name, value: `\r\n\t${value} ` }));
  assert.equal(six.length, HEAD_FIELDS.length);
  assert.deepEqual(headOf({ ...refs, fields: six }), headOf({ ...refs, fields }));
  assert.deepEqual(headOf({ ...refs, fields: shouted }), headOf({ ...refs, fields }));
  assert.deepEqual(headOf({ ...refs, fields: padded }), headOf({ ...refs, fields }));
});

test("the head reads in linear time: each of its six fields 500,000 characters long, and the message they head, read in under 500 ms; an address over the bound is not read", () => {
  const long = 500_000;
  const fields = [
    { name: "message-id", value: `<${"a".repeat(long)}` },
    { name: "in-reply-to", value: "<".repeat(long) },
    { name: "references", value: "<a".repeat(long / 2) },
    // A display name, so that trimming leaves it over the bound.
    { name: "from", value: `${"x ".repeat(long / 2)}<${LEAD}>` },
    { name: "subject", value: "=?utf-8?B?".repeat(long / 10) },
    { name: "content-type", value: '"'.repeat(long) },
  ];
  const raw = [...fields.map(({ name, value }) => `${name}: ${value}`), "", "Hello."].join("\r\n");
  const refs = { messageRef: "m-long", threadRef: "t-platform", at: new Date(clock) };
  const started = performance.now();
  const head = headOf({ ...refs, fields });
  const event = matcher.eventOf(head, raw);
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 500, `${elapsed.toFixed(1)} ms`);
  const { messageId, inReplyTo, references, from, report } = head;
  assert.deepEqual(
    { messageId, inReplyTo, references, from, report },
    {
      messageId: null,
      inReplyTo: [],
      references: [],
      from: null,
      report: false,
    },
  );
  assert.equal(head.subject.length, SUBJECT_MAX_CHARS);
  // In the platform thread, from no address: a reply; its text part lies past READ_MAX_CHARS.
  assert.deepEqual(event?.kind === "reply" && event.text, "");
});

test("a message that does not read gives no error: a report gives no event, a reply a reply without its text", () => {
  const deep = Array.from(
    { length: 100 },
    (_, level) => `Content-Type: multipart/mixed; boundary="d${level}"\r\n\r\n--d${level}`,
  ).join("\r\n");
  const unreadable = [
    "",
    "Not a header line\r\n\r\nNot read.",
    "\u0000\uD800 �",
    `${deep}\r\nContent-Type: text/plain\r\n\r\nToo deep.`,
    'Content-Type: multipart/mixed; boundary=""\r\n\r\n--\r\nNot read.',
    'Content-Type: multipart/mixed; boundary="b"\r\n\r\n--b\r\nContent-Type: text/html\r\n\r\n<p>Not read.</p>',
    'Content-Type: multipart/report; boundary="b"\r\n\r\n--b\r\nContent-Type: message/delivery-status\r\nContent-Transfer-Encoding: base64\r\n\r\n%%%=\r\n',
  ];
  const reply = message("t-platform", { From: LEAD }).head;
  const report = { ...reply, report: true };
  for (const raw of unreadable) {
    assert.doesNotThrow(() => readReport(raw));
    assert.doesNotThrow(() => plainTextOf(raw));
    assert.equal(matcher.eventOf(report, raw), undefined);
    const event = matcher.eventOf(reply, raw);
    assert.ok(event?.kind === "reply" && event.text === "", JSON.stringify(event));
  }
  const broken = "Content-Transfer-Encoding: quoted-printable\r\n\r\n=\r\n=ZZ=0 =";
  assert.equal(plainTextOf(broken), "=ZZ=0 =");
});

test("the fake reads the raw messages it keeps through the reading: a sent message's encoded subject and quoted-printable text come back decoded", async () => {
  const mailbox = bindPort(mailboxPort, mailboxFake, { adapter: "fake" });
  mailboxFake.reset();
  const { address, accessToken } = await connectByConsent(mailbox);
  const messageId = messageIdFor({ idempotencyKey: "match-decoded", domain: "example.test" });
  const raw = rawMessage({
    from: address,
    to: LEAD,
    messageId,
    subject: "=?UTF-8?Q?Caf=C3=A9_au_lait?=",
    text: "Caf=C3=A9 =\r\nau lait",
  }).replace("Content-Transfer-Encoding: 8bit", "Content-Transfer-Encoding: quoted-printable");
  const idempotencyKey = "match-decoded";
  const { threadRef } = await mailbox.sendMessage({ accessToken, raw, messageId, idempotencyKey });
  const thread = await mailbox.readThread({
    accessToken,
    address,
    threadRef: threadRef ?? "",
    limit: 5,
  });
  assert.deepEqual(
    thread.events.map((event) => event.kind === "sent" && [event.subject, event.text]),
    [["Café au lait", "Café au lait"]],
  );
});
