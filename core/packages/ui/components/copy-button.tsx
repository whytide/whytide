import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslations } from "../translations.tsx";
import { Button } from "./button.tsx";
import { Toast } from "./toast.tsx";

/** Copies `value` with the Clipboard API, then says so, or that it failed, in a toast for two seconds. */
export function CopyButton({ value }: { value: string }) {
  const t = useTranslations("ui");
  const [result, setResult] = useState<"copied" | "failed">();
  useEffect(() => {
    if (!result) return;
    const timer = setTimeout(() => setResult(undefined), 2000);
    return () => clearTimeout(timer);
  }, [result]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setResult("copied");
    } catch {
      setResult("failed");
    }
  };
  const said = { copied: t("state.copied"), failed: t("state.error") };
  return (
    <>
      <Button onClick={copy}>
        {result === "copied" ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
        {t("action.copy")}
      </Button>
      <Toast message={result && said[result]} />
    </>
  );
}
