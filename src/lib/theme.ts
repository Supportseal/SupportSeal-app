const TOKEN_KEYS = [
  "primary",
  "primary-dark",
  "primary-light",
  "success",
  "danger",
  "warning",
  "info",
  "secondary",
  "heading",
  "body",
  "muted",
  "border",
  "surface",
  "body-bg",
] as const;

export type ThemeColorKey = (typeof TOKEN_KEYS)[number];

export type ThemeColors = Record<ThemeColorKey, string>;

const FALLBACK: ThemeColors = {
  primary: "#08765a",
  "primary-dark": "#06644c",
  "primary-light": "#3ddc97",
  success: "#1e7b34",
  danger: "#c42b2b",
  warning: "#8f5500",
  info: "#0e6ba0",
  secondary: "#5f6f69",
  heading: "#15261f",
  body: "#43544d",
  muted: "#5f6f69",
  border: "#dce5e1",
  surface: "#ffffff",
  "body-bg": "#f5f8f7",
};

export function readCssVar(name: string, fallback = ""): string {
  if (typeof window === "undefined") return fallback;
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return value || fallback;
}

export function readThemeColors(): ThemeColors {
  return TOKEN_KEYS.reduce((acc, key) => {
    acc[key] = readCssVar(`--vx-${key}`, FALLBACK[key]);
    return acc;
  }, {} as ThemeColors);
}
