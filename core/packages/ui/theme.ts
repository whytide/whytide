// The theme a person chose (README "Theme"), kept in a cookie so that the host's server renders
// <html data-theme> with it and no page flashes the other theme. No "use client": the web's root
// layout reads it as @whytide/ui/theme; ThemeToggle writes it.
export const THEME_COOKIE = "whytide_theme";
/** A year, in seconds: the choice outlives a session. */
export const THEME_COOKIE_MAX_AGE = 31_536_000;
export const THEMES = ["system", "light", "dark"] as const;
export type Theme = (typeof THEMES)[number];

/** The theme a cookie's value names; `system` for anything else. */
export function themeOf(value: string | undefined): Theme {
  return THEMES.find((theme) => theme === value) ?? "system";
}

/** `data-theme` for a theme: none for the system's, which the stylesheet follows by itself. */
export function themeAttribute(theme: Theme): "light" | "dark" | undefined {
  return theme === "system" ? undefined : theme;
}
