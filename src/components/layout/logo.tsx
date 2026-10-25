import Link from "next/link";

import { cn } from "@/lib/cn";
import { brand } from "@/lib/brand";
import { siteConfig } from "@/config/site";

/**
 * SupportSeal mark (docs/design/brand.md, "Logo direction"), drawn on a
 * 64-unit grid so the 4-unit outline is 2px at 32px. Two variants:
 * - light: mint tile, white speech bubble with an ink outline (tail
 *   bottom-left) holding a seal face;
 * - dark (for dark surfaces): ink tile, the same bubble scaled down inside a
 *   thick mint band.
 * The markup is built once here for both the React mark and the standalone
 * SVGs; src/app/icon.svg and public/brand/mark-*.svg are `sealMarkSvg()`
 * verbatim (unit test).
 */
const MARK = {
  tileRadius: 18,
  bubble: "M12.1 41.5 9 51.5l13.3-1.5A23 21 0 1 0 12.1 41.5Z",
  eyes: '<circle cx="21.5" cy="29" r="2.9"/><circle cx="42.5" cy="29" r="2.9"/>',
  nose: "M28.6 30.1c2.3-.8 4.5-.8 6.8 0 .9.3 1.2 1.3.6 2l-2.8 2.6c-.7.6-1.7.6-2.4 0L28 32.1c-.6-.7-.3-1.7.6-2Z",
  mouth: "M26.3 37.3c.9 1.4 2 2 3.1 2 1.4 0 2.6-1 2.6-3.2 0 2.2 1.2 3.2 2.6 3.2 1.1 0 2.2-.6 3.1-2",
  whiskers: "M15.8 34h5M16.2 37.6l4.6-1.1M43.2 34h5M43.2 36.5l4.6 1.1",
  // Dark variant: bubble scaled about the centre; ink ring inside a mint band.
  darkScale: 0.74,
  darkRing: 3.4,
  darkBand: 13,
} as const;

type MarkColors = { mint: string; ink: string; bubble: string };

/** Hex colours for standalone SVGs (favicon, rasterised icons, OG card). */
const MARK_HEX: MarkColors = { mint: "#3ddc97", ink: "#053b2a", bubble: "#ffffff" };

/**
 * Wordmark tones per surface (brand.md, "Logo contrast"); mirrors the
 * --vx-logo-* tokens for standalone assets (brand card, lockup SVGs). Both
 * tones meet 4.5:1 on their surface: signature mint is too light for text on
 * white, so light surfaces take ink + deep mint.
 */
export const WORDMARK_HEX = {
  light: { lead: "#053b2a", accent: "#08765a" },
  dark: { lead: "#e8f0ec", accent: "#3ddc97" },
} as const;

const TOKEN_COLORS: MarkColors = {
  mint: "var(--vx-brand-mint)",
  ink: "var(--vx-brand-ink)",
  bubble: "#ffffff",
};

function faceMarkup(c: MarkColors): string {
  return (
    `<g fill="${c.ink}">${MARK.eyes}<path d="${MARK.nose}"/></g>` +
    `<g fill="none" stroke="${c.ink}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">` +
    `<path d="${MARK.mouth}"/><path d="${MARK.whiskers}"/></g>`
  );
}

function lightMarkup(c: MarkColors, className = ""): string {
  const cls = className ? ` class="${className}"` : "";
  return (
    `<g${cls}><rect width="64" height="64" rx="${MARK.tileRadius}" fill="${c.mint}"/>` +
    `<path d="${MARK.bubble}" fill="${c.bubble}" stroke="${c.ink}" stroke-width="4" stroke-linejoin="round"/>` +
    `${faceMarkup(c)}</g>`
  );
}

function darkMarkup(c: MarkColors, className = ""): string {
  const cls = className ? ` class="${className}"` : "";
  const offset = Number((32 * (1 - MARK.darkScale)).toFixed(2));
  return (
    `<g${cls}><rect width="64" height="64" rx="${MARK.tileRadius}" fill="${c.ink}"/>` +
    `<g transform="translate(${offset} ${offset}) scale(${MARK.darkScale})">` +
    `<path d="${MARK.bubble}" fill="none" stroke="${c.mint}" stroke-width="${MARK.darkBand}" stroke-linejoin="round"/>` +
    `<path d="${MARK.bubble}" fill="${c.bubble}" stroke="${c.ink}" stroke-width="${MARK.darkRing}" stroke-linejoin="round"/>` +
    `${faceMarkup(c)}</g></g>`
  );
}

// Static, constant markup (no user input); one source for both variants.
const IN_APP_MARK = lightMarkup(TOKEN_COLORS, "dark:hidden") + darkMarkup(TOKEN_COLORS, "hidden dark:inline");

/** SupportSeal mark; switches to the dark-surface variant in dark mode. */
export function SealMark({ size = 32, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      aria-hidden
      className={cn("shrink-0", className)}
      dangerouslySetInnerHTML={{ __html: IN_APP_MARK }}
    />
  );
}

/**
 * Standalone SVG of the mark. The favicon (src/app/icon.svg) is the mint
 * tile in every colour scheme: the ink tile of the dark variant is ~1:1
 * against dark tab bars and its banded bubble is too thin at 16px, while the
 * mint tile is ≥6.8:1 there and its ink outline ≥9.6:1 on light tab bars.
 */
export function sealMarkSvg(variant: "light" | "dark" = "light"): string {
  const body = variant === "light" ? lightMarkup(MARK_HEX) : darkMarkup(MARK_HEX);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">\n  ${body}\n</svg>\n`;
}

/**
 * Splits the configured name for the two-tone wordmark: when it ends in the
 * brand short name ("Support" + "Seal") the suffix takes the accent colour;
 * any other configured name renders in one colour.
 */
export function splitWordmark(name: string, accent: string = brand.shortName): [string, string] {
  if (accent && name.length > accent.length && name.endsWith(accent)) {
    return [name.slice(0, -accent.length), accent];
  }
  return [name, ""];
}

export function Logo({
  collapsed = false,
  href = "/inbox",
  className,
}: { collapsed?: boolean; href?: string; className?: string }) {
  const [lead, accent] = splitWordmark(siteConfig.name);
  return (
    // No prefetch, anywhere the logo renders: on logged-out auth pages it
    // points at the protected /inbox, and a logged-out prefetch stores the
    // proxy's 307-to-/login in the client router cache, which later soft
    // navigations to /inbox replay (see login-form.tsx). Everywhere else the
    // logo targets the page you are effectively already on (/inbox from the
    // app, / from marketing), so prefetching it buys nothing.
    <Link href={href} prefetch={false} className={cn("flex items-center gap-2.5 overflow-hidden", className)}>
      <SealMark size={32} />
      {/* Logotype tones (brand.md, "Logo contrast"): ink + deep mint on light, heading + signature mint on dark. */}
      <span
        className={cn(
          "min-w-0 truncate text-[1.375rem] font-bold tracking-[-0.02em] text-logo-lead transition-opacity",
          collapsed && "opacity-0 lg:hidden",
        )}
      >
        {lead}
        {accent ? <span className="text-logo-accent">{accent}</span> : null}
      </span>
    </Link>
  );
}
