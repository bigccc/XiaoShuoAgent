export type ThemeChoice = "system" | "light" | "dark";
const KEY = "novel-theme";

export function getThemeChoice(): ThemeChoice {
  const value = localStorage.getItem(KEY);
  return value === "light" || value === "dark" ? value : "system";
}

function systemDark() {
  return window.matchMedia("(prefers-color-scheme: dark)");
}

export function applyTheme(choice: ThemeChoice) {
  const dark =
    choice === "dark" || (choice === "system" && systemDark().matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
}

export function setThemeChoice(choice: ThemeChoice) {
  localStorage.setItem(KEY, choice);
  applyTheme(choice);
}

export function initTheme() {
  applyTheme(getThemeChoice());
  systemDark().addEventListener("change", () => applyTheme(getThemeChoice()));
}
