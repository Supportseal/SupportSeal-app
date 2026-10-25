# Brand — V1 design

Status: design direction for the build thread. The maintainer decided (2026-09-25) that
**SupportSeal** is the product name and the brand is **mint green**; this doc
defines the palette, design tokens and logo direction. It replaces
the kit's original placeholder violet primary (`#7367f0`) and its purple-tinted
neutrals everywhere in the SupportSeal app.

**Domain (maintainer, 2026-09-29):** the official domain is
[supportseal.app](https://supportseal.app) — the name stays SupportSeal after
a rename shortlist; `supportseal.com` is investor-held and not pursued. Host
layout (apex vs `app.` subdomain) is decided at deployment
([issue #5](https://github.com/Supportseal/SupportSeal-app/issues/5)).

**UI kit baseline:** `src/components` and `src/styles/tokens.css` (paths relative to `src/`). Tokens live in `styles/tokens.css`
(light on `:root`, dark on `.dark`) and are mapped to Tailwind in
`app/globals.css`. Keep the `--vx-*` names so kit components work
unchanged, apart from the component adjustments listed below.

## Brand in one line

A calm, deep mint-green interface (`#08765A`) with a bright signature mint
(`#3DDC97`) reserved for the logo, dark mode and highlights, on cool
green-grey neutrals. All text and interactive states meet WCAG 2.2 AA in
light and dark mode.

## Palette

### Mint scale (reference)

| Step | Hex | Contrast vs white | Use |
| --- | --- | --- | --- |
| mint-50 | `#ECFBF4` | 1.07 | Tints, hover washes |
| mint-100 | `#D3F6E6` | 1.16 | Tints |
| mint-200 | `#A6EDCF` | 1.34 | Decorative |
| mint-300 | `#6FE4B4` | 1.56 | Decorative |
| **mint-400** | **`#3DDC97`** | 1.77 | **Signature mint**: logo tile, dark-mode primary, illustrations. Never text or a sole UI boundary on light surfaces |
| mint-500 | `#1FB97C` | 2.53 | Decorative only (fails 3:1 on white) |
| mint-600 | `#0E9567` | 3.81 | Large text / icons ≥ 3:1 only; avoid for body text |
| **mint-700** | **`#08765A`** | **5.60** | **Light-mode primary**: buttons, links, focus, active states; wordmark accent ("Seal") on light surfaces |
| mint-800 | `#06644C` | 7.16 | Light-mode primary hover/pressed |
| **mint-900** | **`#053B2A`** | 12.61 | **Brand ink**: logo glyph on mint, text on mint-400 (7.13:1), wordmark lead ("Support") on light surfaces |

Why two greens: a mint light enough to read as "mint" (`#3DDC97`) cannot
carry white text or meet 3:1 as a UI boundary on white. The interface
therefore uses mint-700 in light mode, and switches to the signature mint in
dark mode, where it has 9.36:1 against the surface.

### Neutrals (cool green-grey)

| Role | Light | Dark |
| --- | --- | --- |
| Page background (`--vx-body-bg`) | `#F5F8F7` | `#0E1614` |
| Surface (`--vx-surface`) | `#FFFFFF` | `#16211D` |
| Surface 2 (`--vx-surface-2`) | `#EFF4F2` | `#111A17` |
| Hover (`--vx-hover`) | `#EAF1EE` | `#1F2C27` |
| Heading text (`--vx-heading`) | `#15261F` | `#E8F0EC` |
| Body text (`--vx-body`) | `#43544D` | `#BDCBC5` |
| Muted text (`--vx-muted`) | `#5F6F69` | `#8FA19A` |
| Divider (`--vx-border`) | `#DCE5E1` | `#2A3833` |
| Control border (`--vx-border-strong`, new) | `#7A8B85` | `#5D6E68` |

The original `--vx-muted` (`#A5A3AE`, about 2.5:1) failed AA for the hints and
timestamps it's used for. The new muted value passes 4.5:1 on every surface.

### Status colours

Status hues are chosen to be distinguishable from the primary: success is a
yellower green (hue ≈ 135°) than the teal-leaning primary (≈ 160°). Status
is never conveyed by colour alone (badge text or icon always accompanies it).

| Status | Light fill/text | Light label bg | Dark fill/text | Dark label bg |
| --- | --- | --- | --- | --- |
| Success | `#1E7B34` | `#E5F3E8` | `#5AD17A` | `rgba(90,209,122,0.16)` |
| Danger | `#C42B2B` | `#FDEAEA` | `#FF8A80` | `rgba(255,138,128,0.16)` |
| Warning | `#8F5500` | `#FDF0DC` | `#F2B544` | `rgba(242,181,68,0.16)` |
| Info | `#0E6BA0` | `#E3F0F8` | `#5CB8EC` | `rgba(92,184,236,0.16)` |
| Secondary | `#5F6F69` | `#EEF2F0` | `#8FA19A` | `rgba(143,161,154,0.16)` |

## Design tokens (`styles/tokens.css`)

```css
:root {
  --vx-brand-mint: #3ddc97;
  --vx-brand-ink: #053b2a;
  --vx-logo-lead: #053b2a;
  --vx-logo-accent: #08765a;

  --vx-primary: #08765a;
  --vx-primary-dark: #06644c;
  --vx-primary-light: #3ddc97;
  --vx-primary-label: #e3f5ed;
  --vx-primary-contrast: #ffffff;

  --vx-secondary: #5f6f69;
  --vx-secondary-dark: #4b5a55;
  --vx-secondary-label: #eef2f0;
  --vx-secondary-contrast: #ffffff;

  --vx-success: #1e7b34;
  --vx-success-dark: #186a2c;
  --vx-success-label: #e5f3e8;
  --vx-success-contrast: #ffffff;

  --vx-danger: #c42b2b;
  --vx-danger-dark: #a82424;
  --vx-danger-label: #fdeaea;
  --vx-danger-contrast: #ffffff;

  --vx-warning: #8f5500;
  --vx-warning-dark: #7a4800;
  --vx-warning-label: #fdf0dc;
  --vx-warning-contrast: #ffffff;

  --vx-info: #0e6ba0;
  --vx-info-dark: #0b5a87;
  --vx-info-label: #e3f0f8;
  --vx-info-contrast: #ffffff;

  --vx-dark: #15261f;
  --vx-dark-label: #e4ebe8;

  --vx-body-bg: #f5f8f7;
  --vx-surface: #ffffff;
  --vx-surface-2: #eff4f2;
  --vx-heading: #15261f;
  --vx-body: #43544d;
  --vx-muted: #5f6f69;
  --vx-border: #dce5e1;
  --vx-border-strong: #7a8b85;
  --vx-hover: #eaf1ee;
  --vx-focus-ring: rgba(8, 118, 90, 0.28);

  /* layout tokens unchanged from the original kit */
  --vx-shadow-card: 0 0.25rem 1.125rem rgba(21, 38, 31, 0.08);
  --vx-shadow-menu: 0 0.25rem 1.5rem rgba(21, 38, 31, 0.16);
}

.dark {
  --vx-logo-lead: #e8f0ec;
  --vx-logo-accent: #3ddc97;

  --vx-primary: #3ddc97;
  --vx-primary-dark: #62e5ad; /* hover lightens in dark mode */
  --vx-primary-light: #3ddc97;
  --vx-primary-label: rgba(61, 220, 151, 0.16);
  --vx-primary-contrast: #04261a;

  --vx-secondary: #8fa19a;
  --vx-secondary-dark: #a5b4ae;
  --vx-secondary-label: rgba(143, 161, 154, 0.16);
  --vx-secondary-contrast: #0e1614;

  --vx-success: #5ad17a;
  --vx-success-dark: #74da8f;
  --vx-success-label: rgba(90, 209, 122, 0.16);
  --vx-success-contrast: #0e1614;

  --vx-danger: #ff8a80;
  --vx-danger-dark: #ffa39b;
  --vx-danger-label: rgba(255, 138, 128, 0.16);
  --vx-danger-contrast: #0e1614;

  --vx-warning: #f2b544;
  --vx-warning-dark: #f5c466;
  --vx-warning-label: rgba(242, 181, 68, 0.16);
  --vx-warning-contrast: #0e1614;

  --vx-info: #5cb8ec;
  --vx-info-dark: #7cc6f0;
  --vx-info-label: rgba(92, 184, 236, 0.16);
  --vx-info-contrast: #0e1614;

  --vx-dark: #e8f0ec;
  --vx-dark-label: rgba(232, 240, 236, 0.16);

  --vx-body-bg: #0e1614;
  --vx-surface: #16211d;
  --vx-surface-2: #111a17;
  --vx-heading: #e8f0ec;
  --vx-body: #bdcbc5;
  --vx-muted: #8fa19a;
  --vx-border: #2a3833;
  --vx-border-strong: #5d6e68;
  --vx-hover: #1f2c27;
  --vx-focus-ring: rgba(61, 220, 151, 0.36);
  --vx-shadow-card: 0 0.25rem 1.125rem rgba(0, 0, 0, 0.4);
  --vx-shadow-menu: 0 0.25rem 1.5rem rgba(0, 0, 0, 0.55);
}
```

Map the new tokens in `app/globals.css` `@theme inline` alongside the
existing ones: `--color-brand-mint`, `--color-brand-ink`,
`--color-logo-lead`, `--color-logo-accent`,
`--color-border-strong` and `--color-{primary,secondary,success,danger,
warning,info}-contrast`. Keep the sidebar, header, radius and spacing layout
tokens exactly as in the original kit.

## Contrast verification

Computed with the WCAG 2.x relative-luminance formula. Dark-mode label
backgrounds are the 16% rgba values composited over `--vx-surface`.

| Pair | Light | Dark | Requirement |
| --- | --- | --- | --- |
| Heading on surface / page bg | 15.80 / 14.79 | 14.26 / 15.83 | 4.5 text |
| Body on surface / hover | 8.03 / 7.01 | 9.86 / 8.64 | 4.5 text |
| Muted on surface / page bg / hover | 5.30 / 4.96 / 4.62 | 6.09 / 6.76 / 5.34 | 4.5 text |
| Primary text on surface / page bg | 5.60 / 5.24 | 9.36 / 10.39 | 4.5 text |
| Primary text on primary-label (active nav, label buttons) | 4.95 | 6.58 | 4.5 text |
| Primary text on hover | 4.88 | 8.21 | 4.5 text |
| Contrast text on primary fill (solid button) | 5.60 | 9.16 | 4.5 text |
| Contrast text on primary hover fill | 7.16 | 10.28 | 4.5 text |
| Control border on surface / page bg | 3.58 / 3.35 | 3.07 / 3.41 | 3.0 UI boundary |
| Focus outline (primary) on surface | 5.60 | 9.36 | 3.0 UI |
| Success text on surface / label | 5.33 / 4.65 | 8.54 / 6.13 | 4.5 text |
| Danger text on surface / label | 5.63 / 4.86 | 7.25 / 5.48 | 4.5 text |
| Warning text on surface / label | 6.06 / 5.39 | 9.03 / 6.43 | 4.5 text |
| Info text on surface / label | 5.79 / 4.98 | 7.50 / 5.54 | 4.5 text |
| Contrast text on status fills | 5.33–6.06 | 8.04–10.03 | 4.5 text |
| Secondary: contrast text on fill / body on label | 5.30 / 7.11 | 6.76 / — | 4.5 text |
| Brand ink on signature mint (logo glyph) | 7.13 | 7.13 | 4.5 (logos exempt; kept anyway) |
| Wordmark lead on surface / page bg | 12.61 / 11.80 | 14.26 / 15.83 | 4.5 (see "Logo contrast") |
| Wordmark accent on surface / page bg | 5.60 / 5.24 | 9.36 / 10.39 | 4.5 (see "Logo contrast") |

Notes:

- `--vx-border` (1.29 light / 1.35 dark) is for decorative dividers only.
  Inputs, selects, checkboxes, radios, switches (off state) and other
  control outlines use `--vx-border-strong`, to meet WCAG 1.4.11 non-text
  contrast.
- A selected list row's `bg-primary-label` fill is only 1.13:1 against
  white, so the selection must also carry the 3px primary inset border
  (5.60:1), as specified in `support-inbox.md`.
- Do not use mint-400–600 for text or thin icons on light surfaces.

## Required component adjustments (original kit → SupportSeal)

1. **Solid variants use contrast tokens, not `text-white`**: `button.tsx`,
   `badge.tsx`, `alert.tsx` (`solid`), `card.tsx` (`solid`), active
   `sidebar.tsx` links and `tabs.tsx` triggers switch `text-white` to
   `text-{color}-contrast`. Otherwise dark mode puts white text on
   `#3DDC97` (1.77:1).
2. **Remove hard-coded violet shadows**: the `rgba(115,103,240,…)` shadows in
   `button.tsx`, `sidebar.tsx` and `tabs.tsx` (and the status-coloured
   rgba shadows in `button.tsx`) become
   `color-mix(in srgb, var(--vx-primary) 35%, transparent)` (or the matching
   status token). Grep for `115,103,240` and `#7367f0`; neither may remain.
3. **Control borders**: `input.tsx`, `select.tsx`, `checkbox.tsx`,
   `radio-group.tsx`, `tag-input.tsx`, `switch.tsx` (off track) use
   `border-border-strong`.
4. **Fallbacks**: `lib/theme.ts` `FALLBACK` values mirror the new light
   tokens.
5. **Logo**: `components/layout/logo.tsx` gets the SupportSeal mark below;
   the placeholder violet gradient is removed.

## Logo direction

Refreshed 2026-10-04 from the maintainer's reference artwork (horizontal lockup with
"Support" in deep green and "Seal" in mint; icon-only tile with a seal face).

- **Mark: "support seal"**: a rounded-square tile (radius ≈ 28% of its size,
  the same family as the `ProductMark`) in signature mint `#3DDC97`, holding
  a white speech bubble with a brand-ink (`#053B2A`) outline and its tail at
  the bottom-left. Inside the bubble sits a minimal seal face: two dot eyes,
  a rounded nose, a w-shaped mouth and two short whiskers per side. 64-unit
  grid, 4-unit outline (2px at 32px), flat colours, no gradients
  (no gradients, no decoration). The geometry lives once in
  `src/components/layout/logo.tsx`; `src/app/icon.svg` is generated from it
  (`sealMarkSvg()`, asserted equal in a unit test).
- **Wordmark**: the configured name (`siteConfig.name`, never hard-coded) in Public Sans Bold (700), `-0.02em` tracking. When the
  name ends in the brand short name, it splits in two tones (`--vx-logo-lead`
  and `--vx-logo-accent`, see "Logo contrast"): "Support" in brand ink and
  "Seal" in deep mint on light surfaces; "Support" in the heading tone and
  "Seal" in signature mint on dark surfaces. Any other configured name
  renders in one colour (the lead tone).
- **Lockups**: horizontal (mark + wordmark: sidebar, auth pages, onboarding,
  marketing header and footer); mark-only (collapsed sidebar, favicon, app
  icon). Clear space = ¼ of the mark height.
- **Dark-surface variant** (reference 07, 2026-10-04): ink tile
  (`#053B2A`) with the same bubble scaled to 74% inside a thick mint band,
  a thin ink ring and the white interior; the face stays ink. The in-app
  mark switches to it in dark mode (same SVG, `dark:` classes). On a dark
  field the ink tile blends in and the mint-banded bubble carries the mark,
  so use it at 32px and up only; never as the favicon (see "Logo
  contrast").
- **Site assets** (rasterised from the SVG mark): `src/app/icon.svg` (mint
  tile in every colour scheme),
  `src/app/favicon.ico` (16/32/48 px), `src/app/apple-icon.png` (180 px,
  full-bleed mint), `public/icons/icon-192.png`, `icon-512.png` and
  `icon-maskable-512.png` (content inside the 80% safe zone), referenced by
  `src/app/manifest.ts` (light variant; `favicon.ico` is the light-only
  legacy fallback). The brand card (`src/components/marketing/brand-card.tsx` in the private `supportseal-marketing` repository)
  is rendered at build time from the mark, the configured name and tagline,
  with flat corner waves: light for Open Graph
  (`src/app/(marketing)/opengraph-image.tsx`, same repository), dark-surface for X/Twitter
  (`twitter-image.tsx`).
- **Brand kit** (`public/brand/`, for README, press and partner use; the app
  itself renders the `Logo` component): `mark-light.svg` (mint tile, any
  surface), `mark-dark.svg` (dark-surface variant), and the horizontal
  lockups `logo-horizontal-light.svg` / `logo-horizontal-dark.svg`. The marks
  equal `sealMarkSvg()` output (unit test). The lockups are the mark plus the
  wordmark converted to Public Sans Bold outlines (64-unit height, 20-unit
  gap, 44-unit type, cap height centred on the mark), so they render the same
  without the font installed. They are the one deliberate exception to "the
  name never appears in image files" (`marketing-site.md`, now in the private `supportseal-marketing` repository): regenerate them
  after a rename; the unit test fails while their `aria-label` differs from
  `siteConfig.name`.
- **Widget**: no SupportSeal branding in V1 (unchanged).

### Logo contrast

Decided 2026-10-05 after the logo refresh: signature-mint "Seal" on white
measured 1.77:1 (1.65:1 on the `#F5F8F7` page background), and the
dark-scheme favicon's ink tile measured ~1.0–1.3:1 against dark browser tab
bars (`#35363A`, `#202124`). Rules:

- **Wordmark text meets 4.5:1 on its surface in both tones**, even though
  logotypes are exempt from WCAG 1.4.3: the lockup sits at text size in the
  sidebar, auth pages and marketing chrome, where it is read as text.
- **Light surfaces** (`#FFFFFF`, `#F5F8F7`, `#EFF4F2`): "Support" in brand ink
  `#053B2A` (12.61 / 11.80 / 11.34), "Seal" in mint-700 `#08765A` (5.60 /
  5.24 / 5.04). The two tones stay distinct (2.25:1 between them). mint-600
  `#0E9567` (3.81:1) and signature mint are never wordmark text on light.
- **Dark surfaces** (`#16211D`, `#0E1614`, ink `#053B2A`): "Support" in
  `#E8F0EC` (14.26 / 15.83 / 10.87), "Seal" in signature mint `#3DDC97` (9.36
  / 10.39 / 7.13).
- **Tile**: signature mint stays the tile colour everywhere (logos, app
  icons, favicon). The favicon does not switch with `prefers-color-scheme`:
  the mint tile is 6.83:1 against `#35363A` and 9.11:1 against `#202124`,
  and on light tab bars (`#DEE1E6`, white) the ink bubble outline carries the
  shape at 9.62 / 12.61:1.
- Tokens: `--vx-logo-lead` / `--vx-logo-accent` (`text-logo-lead`,
  `text-logo-accent`); standalone assets use the mirrored `WORDMARK_HEX` in
  `logo.tsx` (unit test keeps them in sync and asserts the ratios).

## Product colours vs the brand

- Product primary colours are customer data and never replace brand tokens
  in the dashboard chrome (`app-shell.md`, `product-switcher.md`).
- Because the brand is green, the onboarding/Product-settings preset
  swatches should not include a colour close to `#08765A` or `#3DDC97`.
  Otherwise a Product mark reads as app UI. Suggested presets (all with
  auto black/white letter contrast): `#2563EB` blue, `#7C3AED` violet,
  `#DB2777` pink, `#DC2626` red, `#EA580C` orange, `#CA8A04` amber,
  `#0891B2` cyan, `#475569` slate. Customers may still pick any hex.
- The chat widget uses the **Product** colour, not SupportSeal mint, and
  shows no SupportSeal branding in V1 (a "Powered by" line is not
  specified anywhere; add it only if the maintainer asks).

## Not in V1

Brand illustration system · marketing-site art direction (marketing is out
of V1; launch direction in `marketing-site.md` in the private `supportseal-marketing` repository) · custom font licensing (Public Sans stays) · per-Workspace
white-labelling of the dashboard · high-contrast theme beyond AA.
