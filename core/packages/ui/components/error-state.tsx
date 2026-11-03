import { CircleAlert, RotateCw } from "lucide-react";
import { useErrorText, useTranslations } from "../translations.tsx";
import { Button } from "./button.tsx";

type ErrorStateProps = { module: string; code: string; onRetry?: () => void };

/** An error the API answered with a machine code, in words (an alert), never the code itself. */
export function ErrorState({ module, code, onRetry }: ErrorStateProps) {
  const t = useTranslations("ui");
  const text = useErrorText(module, code);
  return (
    <div role="alert" className="wt-error-state">
      <strong className="flex items-center gap-2 font-semibold text-danger-ink">
        <CircleAlert aria-hidden="true" className="size-4 shrink-0" />
        {t("state.error")}
      </strong>
      <p className="text-ink-muted">{text}</p>
      {onRetry ? (
        <Button size="sm" onClick={onRetry}>
          <RotateCw aria-hidden="true" />
          {t("action.retry")}
        </Button>
      ) : null}
    </div>
  );
}
