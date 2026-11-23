"use client";
// The sequence editor (README.md "Screens"): the connection request, fixed first; the LinkedIn
// messages in the kit's ReorderableList, each named by the key its place gives it at save (First
// message, Follow-up 1, Follow-up 2), with its action, the price of a LinkedIn send and Remove, the
// first one's draw after the acceptance in words, every later one's delay in business days in the
// kit's NumberField; Add step, a LinkedIn message, until three messages or seven steps; then the
// version's emails, which a save sends back as they are, after the messages, their condition
// included (emailFallback). Save sends the list through PUT …/sequence, whose answer is the version
// now current, its number shown; a refusal names its rule beside the list and saves nothing. A
// delay off its bounds, the most the campaign's answer carries (`limits`, the api's setting), is
// sent without one: the api's rule refuses it (step_delay), never the screen's. The note says that a saved version is joined by new enrollments only. Read-only, for a
// member who may not change the campaign, every control is off and Save is gone.
import { Button, Card, ErrorState, NumberField, ReorderableList, SaveBar } from "@whytide/ui";
import { Plus } from "@whytide/ui/icons";
import { ApiError, browserApi } from "@whytide/web/api/browser";
import { useTranslations } from "next-intl";
import { type FormEvent, type ReactNode, useState } from "react";
import {
  FALLBACK_CONDITION,
  MAX_STEPS,
  SEQUENCE_RULES,
  type SequenceRule,
  STEP_KEYS,
} from "../../domain/campaigns/constants.ts";
import type {
  CampaignResponse,
  SequenceBody,
  SequenceResponse,
  StepResponse,
} from "../../schemas/campaigns.ts";
import { NEW_MESSAGE_DELAY, SEQUENCE_PATH } from "../constants.ts";
import { Price, type PriceEntry } from "./price.tsx";
import { delayBounds, useCampaignWords } from "./words.ts";

/** A LinkedIn message of the list: its row's key, which moves with it, and its delay, if valid. */
type Message = { readonly key: string; readonly delay: number | null };
type Props = {
  workspace: string;
  campaign: CampaignResponse;
  price?: PriceEntry;
  /** Another member's campaign, for a member without campaigns.manage: shown, never changed. */
  readOnly: boolean;
  onSaved: (version: SequenceResponse) => void;
};

const messagesOf = (steps: readonly StepResponse[]): Message[] =>
  steps
    .filter(({ action }) => action === "message")
    .map(({ stepKey, delay }) => ({
      key: stepKey,
      delay: delay.anchor === "prev_step" ? delay.value : null,
    }));
/** The delays a save sends, none for the first message's draw: what tells a change. */
const delaysOf = (messages: readonly Message[]) =>
  messages.map(({ delay }, index) => (index === 0 ? null : delay));
const sameDelays = (a: readonly Message[], b: readonly Message[]) => {
  const [left, right] = [delaysOf(a), delaysOf(b)];
  return left.length === right.length && left.every((delay, index) => delay === right[index]);
};
/** The rule a refusal names (`details.rule`), if it is one of SEQUENCE_RULES. */
function ruleOf(body: unknown): SequenceRule | undefined {
  const rule = (body as { details?: { rule?: unknown } } | undefined)?.details?.rule;
  return SEQUENCE_RULES.find((known) => known === rule);
}

/** The body of PUT …/sequence: the connection request, the messages, then the emails as saved. */
function sequenceOf(messages: readonly Message[], emails: readonly StepResponse[]): SequenceBody {
  const message = ({ delay }: Message, index: number) =>
    index === 0 || delay === null
      ? { action: "message" as const }
      : { action: "message" as const, delayBusinessDays: delay };
  const email = ({ delay }: StepResponse) =>
    delay.anchor === "prev_step"
      ? { action: "email" as const, delayBusinessDays: delay.value }
      : { action: "email" as const };
  return {
    steps: [{ action: "invite" }, ...messages.map(message), ...emails.map(email)],
    emailFallback: emails.some(({ condition }) => condition === FALLBACK_CONDITION),
  };
}

export function Editor({ workspace, campaign, price, readOnly, onSaved }: Props) {
  const t = useTranslations("campaigns.editor");
  const kit = useTranslations("ui.action");
  const words = useCampaignWords();
  const bounds = delayBounds(campaign);
  const saved = messagesOf(campaign.steps);
  const emails = campaign.steps.filter(({ action }) => action === "email");
  const [messages, setMessages] = useState(saved);
  const [added, setAdded] = useState(0);
  const [busy, setBusy] = useState(false);
  const [rule, setRule] = useState<SequenceRule>();
  const [failure, setFailure] = useState<string>();
  const [version, setVersion] = useState<number>();
  const dirty = !sameDelays(messages, saved);
  const canAdd =
    messages.length < STEP_KEYS.message.length && 1 + messages.length + emails.length < MAX_STEPS;

  const move = (from: number, to: number) =>
    setMessages((list) => {
      const next = [...list];
      const [item] = next.splice(from, 1);
      if (item !== undefined) next.splice(to, 0, item);
      return next;
    });
  const remove = (index: number) => setMessages((list) => list.filter((_, at) => at !== index));
  const add = () => {
    setMessages((list) => [...list, { key: `added_${added}`, delay: NEW_MESSAGE_DELAY }]);
    setAdded(added + 1);
  };
  const delay = (index: number, value: number | null) =>
    setMessages((list) => list.map((one, at) => (at === index ? { ...one, delay: value } : one)));

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setRule(undefined);
    setFailure(undefined);
    setVersion(undefined);
    try {
      const params = { path: { workspaceId: workspace, campaignId: campaign.id } };
      const body = sequenceOf(messages, emails);
      const { data, error, response } = await browserApi().PUT(SEQUENCE_PATH, { params, body });
      if (response.ok && data !== undefined) {
        setMessages(messagesOf(data.steps));
        setVersion(data.versionNo);
        onSaved(data);
      } else {
        setFailure(new ApiError(response.status, error).code);
        setRule(ruleOf(error));
      }
    } catch {
      setFailure(new ApiError(500, undefined).code);
    }
    setBusy(false);
  }

  const items = messages.map((message, index) => {
    const name = words.step(STEP_KEYS.message[index] ?? "", "message");
    return {
      key: message.key,
      name,
      content: (
        <div className="grid gap-2">
          <StepLine name={name} action={words.action("message")} price={price} />
          {index === 0 ? (
            <p className="text-sm text-ink-muted">{words.draw()}</p>
          ) : (
            <NumberField
              label={t("delay", { step: name })}
              value={message.delay}
              onChange={(value) => delay(index, value)}
              min={bounds.min}
              max={bounds.max}
              error={message.delay === null ? t("delay_invalid", bounds) : undefined}
            />
          )}
        </div>
      ),
    };
  });

  return (
    <Card
      title={t("steps")}
      description={t("steps_description", { messages: STEP_KEYS.message.length })}
    >
      {/* A field is min-w-64 wide: beside the list's buttons, a phone's row has less. The unit is
          in the label, so the box alone sits beside them. */}
      <LockedForm
        readOnly={readOnly}
        className="grid gap-4 [&_.wt-field]:min-w-0"
        onSubmit={submit}
      >
        <div className="rounded-xl border border-line bg-surface p-3 shadow-xs">
          <StepLine
            name={words.step("connect", "invite")}
            action={words.action("invite")}
            price={price}
          />
          <p className="text-sm text-ink-muted">{t("at_enrollment")}</p>
        </div>
        <ReorderableList items={items} onMove={move} onRemove={remove} />
        {rule === undefined ? null : (
          <p role="alert" className="text-pretty text-sm font-medium text-danger-ink">
            {words.rule(rule, bounds)}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <Button onClick={add} disabled={!canAdd}>
            <Plus aria-hidden="true" />
            {t("add_step")}
          </Button>
          <p className="text-sm text-ink-muted">
            {t("add_limit", { messages: STEP_KEYS.message.length, steps: MAX_STEPS })}
          </p>
        </div>
        {emails.length === 0 ? null : (
          <div className="grid gap-2">
            <h3 className="font-medium text-ink">{t("emails")}</h3>
            <p className="text-pretty text-sm text-ink-muted">{t("emails_note")}</p>
            <ol className="grid gap-2">
              {emails.map((step) => (
                <li
                  key={step.stepKey}
                  className="grid gap-1 rounded-xl border border-line bg-surface p-3 shadow-xs"
                >
                  <StepLine
                    name={words.step(step.stepKey, "email")}
                    action={words.action("email")}
                  />
                  <p className="text-sm text-ink-muted">{words.delay(step.delay)}</p>
                  {step.condition === FALLBACK_CONDITION ? (
                    <p className="text-sm text-ink-muted">{t("fallback")}</p>
                  ) : null}
                </li>
              ))}
            </ol>
          </div>
        )}
        {failure === undefined ? null : <ErrorState module="campaigns" code={failure} />}
        {readOnly ? null : (
          <SaveBar
            dirty={dirty}
            note={
              <span role="status">
                {version === undefined ? t("version_note") : t("saved", { version })}
              </span>
            }
          >
            <Button type="submit" variant="primary" loading={busy} disabled={!dirty}>
              {kit("save")}
            </Button>
          </SaveBar>
        )}
      </LockedForm>
    </Card>
  );
}

/** The editor's form; read-only, a disabled fieldset holds its controls, so none of them works. */
function LockedForm(props: {
  readOnly: boolean;
  className: string;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  children: ReactNode;
}) {
  return (
    <form onSubmit={props.onSubmit}>
      <fieldset disabled={props.readOnly} className={`min-w-0 ${props.className}`}>
        {props.children}
      </fieldset>
    </form>
  );
}

/** A step's name, its action and, for a LinkedIn step, the price of a send. */
function StepLine(props: { name: string; action: string; price?: PriceEntry | undefined }) {
  const { name, action, price } = props;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <span className="font-medium text-ink">{name}</span>
      <span className="text-sm text-ink-muted">{action}</span>
      {price === undefined ? null : <Price price={price} />}
    </div>
  );
}
