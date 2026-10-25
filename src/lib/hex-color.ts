const HEX_COLOR_INPUT = /^#([0-9a-f]{3}|[0-9a-f]{6})$/iu;

/**
 * Parse user-typed colour input for the Product forms: `#RGB` or `#RRGGBB`,
 * case-insensitive, surrounding whitespace tolerated. Returns the canonical
 * lowercase `#rrggbb` (3-digit forms expanded) or null when invalid.
 */
export function expandHexColor(value: string): string | null {
  const digits = HEX_COLOR_INPUT.exec(value.trim())?.[1];
  if (!digits) return null;
  if (digits.length === 6) return `#${digits.toLowerCase()}`;
  const [r, g, b] = digits;
  return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
}
