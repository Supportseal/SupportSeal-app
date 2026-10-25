import { cn } from "@/lib/cn";

const PALETTE = [
  "bg-primary-label text-primary",
  "bg-success-label text-success",
  "bg-warning-label text-warning",
  "bg-info-label text-info",
  "bg-danger-label text-danger",
];

function initials(name: string) {
  return name
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

function colorFor(name: string) {
  let hash = 0;
  for (const char of name) hash = (hash + char.charCodeAt(0)) % PALETTE.length;
  return PALETTE[hash] ?? PALETTE[0];
}

export function Avatar({
  name,
  src,
  size = 38,
  className,
  status,
}: {
  name: string;
  src?: string;
  size?: number;
  className?: string;
  status?: "online" | "offline" | "busy" | "away";
}) {
  const statusColor = {
    online: "bg-success",
    offline: "bg-secondary",
    busy: "bg-danger",
    away: "bg-warning",
  };

  return (
    <span
      className={cn("relative inline-flex shrink-0 rounded-full", className)}
      style={{ width: size, height: size }}
    >
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt={name}
          className="size-full rounded-full object-cover"
        />
      ) : (
        <span
          className={cn(
            "flex size-full items-center justify-center rounded-full text-[0.6875rem] font-medium",
            colorFor(name),
          )}
        >
          {initials(name)}
        </span>
      )}
      {status ? (
        <span
          className={cn(
            "absolute right-0 bottom-0 size-2.5 rounded-full ring-2 ring-surface",
            statusColor[status],
          )}
        />
      ) : null}
    </span>
  );
}

export function AvatarGroup({
  people,
  max = 4,
  size = 32,
}: {
  people: { name: string; src?: string }[];
  max?: number;
  size?: number;
}) {
  const shown = people.slice(0, max);
  const extra = people.length - shown.length;

  return (
    <div className="flex items-center">
      {shown.map((person, index) => (
        <Avatar
          key={`${person.name}-${index}`}
          name={person.name}
          src={person.src}
          size={size}
          className={cn("ring-2 ring-surface", index > 0 && "-ml-2")}
        />
      ))}
      {extra > 0 ? (
        <span
          className="-ml-2 inline-flex items-center justify-center rounded-full bg-secondary-label text-[0.6875rem] font-medium text-body ring-2 ring-surface"
          style={{ width: size, height: size }}
        >
          +{extra}
        </span>
      ) : null}
    </div>
  );
}
