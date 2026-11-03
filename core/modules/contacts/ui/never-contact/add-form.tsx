// The never-contact screen's add form (list.tsx): Person or Company, then the value as typed, a
// LinkedIn profile for a person, a LinkedIn company page or a domain for a company, which the api
// reads by its URL rules. A person may be recorded as opted out instead, only after a confirmation:
// an opt-out is never removed, so one on a mistyped profile would stay. Add posts POST
// …/contacts/suppression with an Idempotency-Key, which the same body sent again after a failure
// reuses (core/apps/api "Request protection"); while it runs the form waits. The api's error shows
// under the field, in words.
"use client";

import { Button, Dialog, Select, TextField, useErrorText } from "@whytide/ui";
import { Plus } from "@whytide/ui/icons";
import { ApiError, browserApi, data } from "@whytide/web/api/browser";
import { useTranslations } from "next-intl";
import { type FormEvent, useId, useRef, useState } from "react";
import type { BlockKind } from "./block.tsx";

/** The list an entry is added to: the workspace's blocks, or a person's opt-out. */
export type Layer = "blocklist" | "opt_out";
/** What the form posts: the kind, the value as typed, and the list. */
type Body = { readonly kind: BlockKind; readonly value: string; readonly layer: Layer };
/** The last post that failed, with its key, which the same body, sent again, reuses. */
type Attempt = { readonly body: Body; readonly key: string };

const codeOf = (error: unknown) => (error instanceof ApiError ? error.code : "internal_error");
const same = (a: Body, b: Body) => a.kind === b.kind && a.value === b.value && a.layer === b.layer;

/** `onAdded` once the api added the entry, or answered the one already there, with its list. */
export function AddForm(props: { workspace: string; onAdded: (layer: Layer) => void }) {
  const { workspace, onAdded } = props;
  const t = useTranslations("contacts.never_contact");
  const id = useId();
  const [kind, setKind] = useState<BlockKind>("person");
  const [layer, setLayer] = useState<Layer>("blocklist");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string>();
  const [confirming, setConfirming] = useState(false);
  const running = useRef(false);
  const last = useRef<Attempt>(undefined);
  const failure = useErrorText("contacts", failed ?? "internal_error");
  const body: Body = { kind, value: value.trim(), layer: kind === "person" ? layer : "blocklist" };

  async function add(sent: Body) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setFailed(undefined);
    const key =
      last.current && same(last.current.body, sent) ? last.current.key : crypto.randomUUID();
    try {
      await data(
        browserApi().POST("/v1/workspaces/{workspaceId}/contacts/suppression", {
          params: { path: { workspaceId: workspace }, header: { "Idempotency-Key": key } },
          body: sent,
        }),
      );
      last.current = undefined;
      setValue("");
      onAdded(sent.layer);
    } catch (error) {
      last.current = { body: sent, key };
      setFailed(codeOf(error));
    } finally {
      running.current = false;
      setBusy(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (body.layer === "opt_out") setConfirming(true);
    else void add(body);
  }

  const person = kind === "person";
  return (
    <section
      aria-labelledby={`${id}-title`}
      className="mb-8 grid gap-4 rounded-xl border border-line bg-surface p-5 shadow-xs"
    >
      <h2 id={`${id}-title`} className="font-semibold text-ink">
        {t("form.title")}
      </h2>
      <form onSubmit={submit} className="grid justify-items-start gap-4">
        <div className="flex w-full flex-wrap items-start gap-4">
          <div className="w-full sm:w-64">
            <Select
              label={t("form.kind")}
              value={kind}
              onChange={(event) => {
                setKind(event.target.value as BlockKind);
                setFailed(undefined);
              }}
              options={[
                { value: "person", label: t("kind.person") },
                { value: "company", label: t("kind.company") },
              ]}
            />
          </div>
          {person && (
            <div className="w-full sm:w-64">
              <Select
                label={t("form.list")}
                value={layer}
                onChange={(event) => setLayer(event.target.value as Layer)}
                options={[
                  { value: "blocklist", label: t("list.blocklist") },
                  { value: "opt_out", label: t("list.opt_out") },
                ]}
              />
            </div>
          )}
          <div className="min-w-0 flex-1 basis-80">
            <TextField
              label={person ? t("form.value_person") : t("form.value_company")}
              hint={person ? t("form.hint_person") : t("form.hint_company")}
              error={failed === undefined ? undefined : failure}
              value={value}
              onChange={(event) => {
                setValue(event.target.value);
                setFailed(undefined);
              }}
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
            />
          </div>
        </div>
        <Button type="submit" variant="primary" loading={busy}>
          <Plus aria-hidden="true" />
          {t("form.add")}
        </Button>
      </form>
      <Dialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title={t("opt_out.title")}
        actions={
          <Button
            variant="danger"
            onClick={() => {
              setConfirming(false);
              void add(body);
            }}
          >
            {t("opt_out.confirm")}
          </Button>
        }
      >
        <p>{t("opt_out.body")}</p>
        <p className="mb-3 break-all font-medium text-ink">{body.value}</p>
      </Dialog>
    </section>
  );
}
