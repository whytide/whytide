// reports.ts on SYNTHETIC reports, written for this test after the providers' published shapes: no
// real message, address or server. Gmail's failure and delay notices, Exchange Online's
// non-delivery report, a feedback report in Microsoft's JMRP shape (Google sends a sender none),
// RFC 6533's global delivery status, the fallbacks for the original's Message-ID, the defaults of a
// report that does not read; no recipient address and no text in what it gives; its fields read in
// linear time; anything else is no report.
import assert from "node:assert/strict";
import { test } from "node:test";
import { messageIdFor } from "../message-id.ts";
import { readReport } from "../reports.ts";

const SENT = messageIdFor({ idempotencyKey: "reports-sent", domain: "example.test" });
const lines = (...given: string[]) => given.join("\r\n");
const ORIGINAL = lines(
  `Message-ID: <${SENT}>`,
  "From: Member <member@example.test>",
  "To: nobody@example.test",
  "Subject: A synthetic message",
  "",
  "Hello.",
);

/** Gmail's notice, synthetic: an HTML part for the reader, the status, the original's headers. */
const gmail = (action: string, status: string) =>
  lines(
    "From: Mail Delivery Subsystem <mailer-daemon@googlemail.com>",
    "To: member@example.test",
    `Subject: Delivery Status Notification (${action === "failed" ? "Failure" : "Delay"})`,
    'Content-Type: multipart/report; boundary="000000000000aaaa"; report-type=delivery-status',
    "",
    "--000000000000aaaa",
    'Content-Type: multipart/related; boundary="000000000000bbbb"',
    "",
    "--000000000000bbbb",
    'Content-Type: text/html; charset="UTF-8"',
    "",
    "<html><p>Address not found</p></html>",
    "--000000000000bbbb--",
    "--000000000000aaaa",
    "Content-Type: message/delivery-status",
    "",
    "Reporting-MTA: dns; googlemail.com",
    "Arrival-Date: Sun, 01 Nov 2026 03:00:00 -0800 (PST)",
    `X-Original-Message-ID: <${SENT}>`,
    "",
    "Final-Recipient: rfc822; nobody@example.test",
    `Action: ${action}`,
    `Status: ${status}`,
    "Diagnostic-Code: smtp; 550-5.1.1 The email account that you tried to reach does not exist.",
    "",
    "--000000000000aaaa",
    "Content-Type: text/rfc822-headers",
    "",
    ORIGINAL.split("\r\n\r\n")[0] ?? "",
    "--000000000000aaaa--",
  );
/** Exchange Online's report, synthetic: the reader's parts, the status, the whole original. */
const exchange = lines(
  "From: Microsoft Outlook <postmaster@example.onmicrosoft.com>",
  "To: <member@example.test>",
  "Subject: Undeliverable: A synthetic message",
  'Content-Type: multipart/report; report-type=delivery-status; boundary="_000_NDR_"',
  "",
  "--_000_NDR_",
  'Content-Type: multipart/alternative; differences=Content-Type; boundary="_002_"',
  "",
  "--_002_",
  "Content-Type: text/plain; charset=us-ascii",
  "",
  "Your message to nobody@example.test couldn't be delivered.",
  "--_002_--",
  "--_000_NDR_",
  "Content-Type: message/delivery-status",
  "",
  "Reporting-MTA: dns;AM0PR00MB0000.eurprd00.prod.outlook.com",
  "",
  "Final-Recipient: rfc822;nobody@example.test",
  "Action: failed",
  "Status: 5.1.10",
  "Diagnostic-Code: smtp;550 5.1.10 RESOLVER.ADR.RecipientNotFound; Recipient not found",
  "",
  "--_000_NDR_",
  "Content-Type: message/rfc822",
  "",
  ORIGINAL,
  "--_000_NDR_--",
);
/** A feedback report in Microsoft's JMRP shape, synthetic, the original's headers in base64. */
const jmrp = lines(
  "From: staff@hotmail.example",
  "Subject: complaint about message from 192.0.2.1",
  'Content-Type: multipart/report; report-type=feedback-report; boundary="--boundary_0"',
  "",
  "----boundary_0",
  "Content-Type: text/plain; charset=us-ascii",
  "",
  "This is an email abuse report for a message received from IP 192.0.2.1.",
  "----boundary_0",
  "Content-Type: message/feedback-report",
  "",
  "Feedback-Type: Abuse",
  "User-Agent: Synthetic-JMRP/1.0",
  "Version: 1",
  "",
  "----boundary_0",
  "Content-Type: text/rfc822-headers",
  "Content-Transfer-Encoding: base64",
  "",
  Buffer.from(`Message-ID: <${SENT}>\r\nFrom: member@example.test\r\n`).toString("base64"),
  "----boundary_0--",
);
/** A synthetic report with one part of the type given, its content the lines given, and no original. */
const bare = (type: string, content: string[], ...fields: string[]) =>
  lines(
    ...fields,
    'Content-Type: multipart/report; boundary="b"',
    "",
    "--b",
    `Content-Type: ${type}`,
    "",
    ...content,
    "--b--",
  );
const FAILED = ["Reporting-MTA: dns; mx.example.test", "", "Action: failed", "Status: 5.2.2"];

test("Gmail's failure and delay notices, Exchange Online's report and a feedback report give the original's Message-ID, the action, the status and permanent, the type", () => {
  assert.deepEqual(readReport(gmail("failed", "5.1.1")), {
    kind: "delivery",
    originalMessageId: SENT,
    action: "failed",
    status: "5.1.1",
    permanent: true,
  });
  assert.deepEqual(readReport(gmail("failed", "4.4.7 (delivery expired)")), {
    kind: "delivery",
    originalMessageId: SENT,
    action: "failed",
    status: "4.4.7",
    permanent: false,
  });
  assert.deepEqual(readReport(gmail("delayed", "4.4.7")), {
    kind: "delivery",
    originalMessageId: SENT,
    action: "delayed",
    status: "4.4.7",
    permanent: false,
  });
  assert.deepEqual(readReport(exchange), {
    kind: "delivery",
    originalMessageId: SENT,
    action: "failed",
    status: "5.1.10",
    permanent: true,
  });
  assert.deepEqual(readReport(jmrp), {
    kind: "feedback",
    originalMessageId: SENT,
    feedbackType: "abuse",
  });
});

test("RFC 6533's global delivery status, and the original's Message-ID from X-Original-Message-ID or the report's In-Reply-To when no part returns it", () => {
  const global = bare("message/global-delivery-status", FAILED, `In-Reply-To: <${SENT}>`);
  assert.deepEqual(readReport(global), {
    kind: "delivery",
    originalMessageId: SENT,
    action: "failed",
    status: "5.2.2",
    permanent: true,
  });
  const withX = gmail("failed", "5.1.1").replace(
    /--000000000000aaaa\r\nContent-Type: text\/rfc822-headers[\s\S]*?(?=--000000000000aaaa--)/,
    "",
  );
  assert.equal(readReport(withX)?.originalMessageId, SENT);
  assert.equal(readReport(bare("message/delivery-status", FAILED))?.originalMessageId, null);
});

test("a failed delivery without a readable 4.x.x or 5.x.x status is 5.0.0, so permanent; a feedback report without a readable type is other", () => {
  const statuses = ["", "Status: unknown", "Status: 2.0.0", "Status: 5.1.1000"];
  for (const status of statuses) {
    const content = ["Reporting-MTA: dns; mx.example.test", "", "Action: failed", status];
    const read = readReport(bare("message/delivery-status", content));
    assert.deepEqual(read?.kind === "delivery" && [read.status, read.permanent], ["5.0.0", true]);
  }
  const delayed = ["", "Action: delayed", "Status: soon"];
  const notFailed = readReport(bare("message/delivery-status", delayed));
  assert.deepEqual(notFailed?.kind === "delivery" && [notFailed.status, notFailed.permanent], [
    null,
    false,
  ]);
  for (const type of ["", "Feedback-Type: (none)", `Feedback-Type: ${"x".repeat(65)}`]) {
    const read = readReport(bare("message/feedback-report", [type, "Version: 1"]));
    assert.equal(read?.kind === "feedback" && read.feedbackType, "other", type);
  }
});

test("no recipient address and no text in what it gives: only the report's own words, whatever the report holds", () => {
  const unsaid = [
    "nobody@example.test",
    "member@example.test",
    "does not exist",
    "Recipient not found",
    "Address not found",
    "couldn't be delivered",
    "abuse report",
    "A synthetic message",
    "Hello.",
  ];
  for (const report of [gmail("failed", "5.1.1"), gmail("delayed", "4.4.7"), exchange, jmrp]) {
    const read = readReport(report);
    const said = JSON.stringify(read);
    assert.deepEqual(
      unsaid.filter((words) => said.includes(words)),
      [],
    );
    const keys = Object.keys(read ?? {}).toSorted();
    const expected =
      read?.kind === "delivery"
        ? ["action", "kind", "originalMessageId", "permanent", "status"]
        : ["feedbackType", "kind", "originalMessageId"];
    assert.deepEqual(keys, expected);
  }
});

test("a report's fields read in linear time: an Action, a Status, a Feedback-Type and an In-Reply-To of 500,000 characters, read in under 500 ms", () => {
  const long = 500_000;
  const inReplyTo = `In-Reply-To: <${"a".repeat(long)}`;
  const delivery = bare(
    "message/delivery-status",
    ["", `Action: ${"x".repeat(long)}`, `Status: ${"5".repeat(long)}`],
    inReplyTo,
  );
  const feedback = bare("message/feedback-report", [`Feedback-Type: ${"-".repeat(long)}`]);
  const started = performance.now();
  const read = [readReport(delivery), readReport(feedback)];
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 500, `${elapsed.toFixed(1)} ms`);
  // None of them reads: no action, so no bounce; the type is other; no Message-ID.
  assert.deepEqual(read, [
    { kind: "delivery", originalMessageId: null, action: null, status: null, permanent: false },
    { kind: "feedback", originalMessageId: null, feedbackType: "other" },
  ]);
});

test("anything else is no report: a plain message, a report without a boundary, a report without a report part", () => {
  assert.equal(readReport(ORIGINAL), undefined);
  assert.equal(readReport(lines("Content-Type: multipart/report", "", "--b", "--b--")), undefined);
  assert.equal(readReport(bare("text/plain", FAILED)), undefined);
});
