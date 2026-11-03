import { Monitor, Moon, Sun } from "lucide-react";
import { useId, useSyncExternalStore } from "react";
import {
  THEME_COOKIE,
  THEME_COOKIE_MAX_AGE,
  THEMES,
  type Theme,
  themeAttribute,
  themeOf,
} from "../theme.ts";
import { useTranslations } from "../translations.tsx";

const ICONS = { system: Monitor, light: Sun, dark: Moon };

/** The theme follows `data-theme` on <html>, which this toggle and the root layout set. */
function subscribe(changed: () => void) {
  const observer = new MutationObserver(changed);
  observer.observe(document.documentElement, { attributeFilter: ["data-theme"] });
  return () => observer.disconnect();
}
const chosen = () => themeOf(document.documentElement.dataset.theme);
const onServer = (): Theme => "system";

function choose(theme: Theme) {
  const secure = window.location.protocol === "https:" ? "; secure" : "";
  document.cookie = `${THEME_COOKIE}=${theme}; path=/; max-age=${THEME_COOKIE_MAX_AGE}; samesite=lax${secure}`;
  const attribute = themeAttribute(theme);
  if (attribute) document.documentElement.dataset.theme = attribute;
  else delete document.documentElement.dataset.theme;
}

/**
 * System, light or dark, as three radios: the choice applies at once and is kept in a cookie
 * (theme.ts), which the root layout reads, so the next page renders in it with no flash.
 */
export function ThemeToggle() {
  const t = useTranslations("ui.theme");
  const name = useId();
  const theme = useSyncExternalStore(subscribe, chosen, onServer);
  const words = { system: t("system"), light: t("light"), dark: t("dark") };
  return (
    <fieldset className="grid gap-1.5">
      <legend className="mb-1.5 text-xs font-medium text-ink-muted">{t("label")}</legend>
      <div className="grid grid-cols-3 gap-0.5 rounded-lg bg-muted p-0.5 ring-1 ring-line ring-inset">
        {THEMES.map((choice) => {
          const Icon = ICONS[choice];
          return (
            <label
              key={choice}
              className="flex h-7 cursor-pointer items-center justify-center gap-1.5 rounded-md text-xs font-medium text-ink-muted transition hover:text-ink has-checked:bg-raised has-checked:text-ink has-checked:shadow-sm has-focus-visible:outline-2 has-focus-visible:outline-focus"
            >
              <input
                type="radio"
                name={name}
                value={choice}
                checked={theme === choice}
                onChange={() => choose(choice)}
                className="sr-only"
              />
              <Icon aria-hidden="true" className="size-3.5" />
              {words[choice]}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
