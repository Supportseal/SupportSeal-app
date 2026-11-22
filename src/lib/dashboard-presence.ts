/**
 * Which members have a dashboard open right now, in this process
 * (docs/design/agent-alerts.md). The inbox stream (`/api/inbox/stream`) is
 * connected for as long as any dashboard tab is open, so a live stream means
 * the member already gets the in-tab notification and sound and needs no
 * email. In memory only: no database writes, so an open tab costs nothing.
 * With several app processes a member connected to another process counts
 * as away here and may get an email they did not need; never a missed one.
 */

const globalForPresence = globalThis as unknown as {
  __supportsealDashboardStreams?: Map<string, number>;
};

const streams = (globalForPresence.__supportsealDashboardStreams ??= new Map<string, number>());

/** Register one open dashboard stream; call the returned function when it closes. */
export function trackDashboardStream(membershipId: string): () => void {
  streams.set(membershipId, (streams.get(membershipId) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (streams.get(membershipId) ?? 1) - 1;
    if (left > 0) streams.set(membershipId, left);
    else streams.delete(membershipId);
  };
}

export function hasOpenDashboard(membershipId: string): boolean {
  return (streams.get(membershipId) ?? 0) > 0;
}

/** Tests only. */
export function resetDashboardPresenceForTest(): void {
  streams.clear();
}
