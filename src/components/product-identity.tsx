import { cn } from "@/lib/cn";

/**
 * Pick black or white text for a filled colour, whichever contrasts better
 * (docs/design/product-switcher.md: Product colours are arbitrary data).
 */
export function letterColorFor(hex: string): "black" | "white" {
  const normalized = hex.replace("#", "");
  if (normalized.length !== 6) return "white";
  const r = parseInt(normalized.slice(0, 2), 16) / 255;
  const g = parseInt(normalized.slice(2, 4), 16) / 255;
  const b = parseInt(normalized.slice(4, 6), 16) / 255;
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const luminance = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return luminance > 0.35 ? "black" : "white";
}

const SIZES = {
  sm: "size-5 text-[0.625rem]",
  md: "size-7 text-[0.8125rem]",
} as const;

export function ProductMark({
  name,
  color,
  size = "sm",
  className,
}: {
  name: string;
  color: string;
  size?: keyof typeof SIZES;
  className?: string;
}) {
  const letter = (name.trim()[0] ?? "?").toUpperCase();
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-md font-semibold ring-1 ring-inset ring-border",
        SIZES[size],
        className,
      )}
      style={{ backgroundColor: color, color: letterColorFor(color) }}
    >
      {letter}
    </span>
  );
}

export function ProductChip({
  name,
  color,
  archived = false,
  className,
}: {
  name: string;
  color: string;
  archived?: boolean;
  className?: string;
}) {
  return (
    <span className={cn("inline-flex items-center gap-1.5", archived && "opacity-60", className)}>
      <ProductMark name={name} color={color} size="sm" />
      <span className="text-sm text-heading">{name}</span>
      {archived ? <span className="text-xs text-muted">(archived)</span> : null}
    </span>
  );
}
