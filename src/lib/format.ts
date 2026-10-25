/** Client-safe formatting helpers (no server imports). */

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Deterministic "5 minutes ago" from two instants (no clock reads, so server and client agree). */
export function formatRelativeTime(then: Date | string, now: Date | string): string {
  const seconds = Math.max(0, Math.floor((new Date(now).getTime() - new Date(then).getTime()) / 1000));
  if (seconds < 60) return "just now";
  const units: [number, string][] = [
    [86_400, "day"],
    [3_600, "hour"],
    [60, "minute"],
  ];
  for (const [size, label] of units) {
    if (seconds >= size) {
      const count = Math.floor(seconds / size);
      return `${count} ${label}${count === 1 ? "" : "s"} ago`;
    }
  }
  return "just now";
}
