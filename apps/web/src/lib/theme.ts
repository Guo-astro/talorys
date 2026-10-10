export type ThemePreference = "system" | "light" | "dark";

const KEY = "talorys.theme";
let media: MediaQueryList | null = null;

function resolve(pref: ThemePreference): "light" | "dark" {
  if (pref !== "system") return pref;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function applyTheme(pref: ThemePreference): void {
  try {
    localStorage.setItem(KEY, pref);
  } catch {
    /* storage unavailable */
  }
  const set = () => document.documentElement.classList.toggle("dark", resolve(pref) === "dark");
  set();
  media?.removeEventListener("change", set);
  if (pref === "system") {
    media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", set);
  }
}

/** Applies the last known theme before first render (no inline scripts under our CSP). */
export function initTheme(): void {
  let pref: ThemePreference = "system";
  try {
    pref = (localStorage.getItem(KEY) as ThemePreference | null) ?? "system";
  } catch {
    /* ignore */
  }
  applyTheme(pref);
}
