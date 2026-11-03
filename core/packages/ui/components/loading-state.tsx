import { useTranslations } from "../translations.tsx";

/** A wait, announced: a polite live region (`role="status"`) with the shared word and a spinner. */
export function LoadingState() {
  const t = useTranslations("ui.state");
  return (
    <div role="status" className="wt-loading-state">
      <span className="wt-spinner" aria-hidden="true" />
      {t("loading")}
    </div>
  );
}
