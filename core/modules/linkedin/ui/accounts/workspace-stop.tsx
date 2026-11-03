"use client";
// The workspace's "Stop everything" (README.md "Screen"), a card loaded in the browser with its
// loading state and its error state with a retry: a Switch, on while the workspace is stopped, that
// asks for confirmation both ways. Stopped, no LinkedIn action of the workspace runs from the next
// one, reads included, for every account, until the stop is lifted. The operator's stop of the
// workspace or of the instance shows the Switch locked, saying so. A failed change shows its code
// in words, with a retry.
import { Button, Dialog, ErrorState, LoadingState, Switch } from "@whytide/ui";
import { Lock, OctagonX } from "@whytide/ui/icons";
import { ApiError, browserApi, data } from "@whytide/web/api/browser";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { ControlsResponse } from "../../schemas/controls.ts";

const NOTE = "flex items-start gap-2.5 rounded-lg px-3 py-2.5 text-sm";
const ICON = "mt-0.5 size-4 shrink-0";

export function WorkspaceStop({ workspaceId }: { workspaceId: string }) {
  const t = useTranslations("linkedin.controls");
  const id = useId();
  const [controls, setControls] = useState<ControlsResponse>();
  const [failure, setFailure] = useState<string>();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  /** The action that failed last, which the error's retry runs again. */
  const failed = useRef<() => Promise<void>>(undefined);

  const load = useCallback(async () => {
    failed.current = load;
    setFailure(undefined);
    setControls(undefined);
    try {
      const params = { path: { workspaceId } };
      const path = "/v1/workspaces/{workspaceId}/linkedin/controls";
      setControls(await data(browserApi().GET(path, { params })));
    } catch (error) {
      setFailure(error instanceof ApiError ? error.code : "internal_error");
    }
  }, [workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function change() {
    const stopped = !controls?.workspace.stopped;
    failed.current = change;
    setConfirming(false);
    setBusy(true);
    setFailure(undefined);
    try {
      const params = { path: { workspaceId } };
      const path = "/v1/workspaces/{workspaceId}/linkedin/controls";
      setControls(await data(browserApi().PUT(path, { params, body: { stopped } })));
    } catch (error) {
      setFailure(error instanceof ApiError ? error.code : "internal_error");
    } finally {
      setBusy(false);
    }
  }

  const stopped = controls?.workspace.stopped ?? false;
  const locked =
    controls?.platform.stopped === true
      ? t("locked.platform")
      : controls?.workspace.stopSource === "operator"
        ? t("locked.workspace")
        : undefined;
  return (
    <section
      aria-labelledby={`${id}-title`}
      className="grid max-w-3xl min-w-0 content-start gap-4 rounded-xl border border-line bg-surface p-5 shadow-xs sm:p-6"
    >
      <h2 id={`${id}-title`} className="flex items-center gap-2 font-semibold text-ink">
        <OctagonX aria-hidden="true" className="size-4 text-ink-muted" />
        {t("stop.title")}
      </h2>
      {controls === undefined && failure === undefined ? (
        <div aria-label={t("stop.loading")} aria-busy="true">
          <LoadingState />
        </div>
      ) : null}
      {controls === undefined ? null : (
        <>
          <div className="flex items-start justify-between gap-4">
            <div className="grid min-w-0 gap-1">
              <label htmlFor={`${id}-switch`} className="font-medium text-ink">
                {t("stop.label")}
              </label>
              <p id={`${id}-about`} className="text-sm text-ink-muted">
                {t("stop.description")}
              </p>
            </div>
            <Switch
              id={`${id}-switch`}
              checked={stopped}
              disabled={busy || locked !== undefined}
              aria-describedby={locked === undefined ? `${id}-about` : `${id}-about ${id}-locked`}
              onChange={() => setConfirming(true)}
            />
          </div>
          {stopped && controls.workspace.stopSource === "tester" ? (
            <p className={`${NOTE} border border-danger-line bg-danger-soft text-danger-ink`}>
              <OctagonX aria-hidden="true" className={ICON} />
              {t("stop.on")}
            </p>
          ) : null}
          {locked === undefined ? null : (
            <p id={`${id}-locked`} className={`${NOTE} bg-muted text-ink`}>
              <Lock aria-hidden="true" className={`${ICON} text-ink-muted`} />
              {locked}
            </p>
          )}
        </>
      )}
      {failure === undefined ? null : (
        <>
          {controls === undefined ? <p className="text-ink">{t("stop.error")}</p> : null}
          <ErrorState module="linkedin" code={failure} onRetry={() => void failed.current?.()} />
        </>
      )}
      <Dialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title={stopped ? t("lift.confirm_title") : t("stop.confirm_title")}
        actions={
          <Button variant={stopped ? "primary" : "danger"} onClick={change}>
            {stopped ? t("lift.confirm") : t("stop.confirm")}
          </Button>
        }
      >
        <p className="my-3">{stopped ? t("lift.confirm_body") : t("stop.confirm_body")}</p>
      </Dialog>
    </section>
  );
}
