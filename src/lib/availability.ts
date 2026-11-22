import {
  effectiveAvailability,
  type AvailabilityMode,
  type EffectiveAvailability,
  type MemberHours,
} from "@/lib/business-hours";
import { prisma } from "@/lib/prisma";
import { cachedProductLookup } from "@/lib/product-lookup-cache";

type AvailabilityState = { mode: AvailabilityMode; members: MemberHours[] };

/**
 * The Workspace's availability mode plus, in AUTO, every member's business
 * hours (the inputs; the Live/Away result depends on the clock, so callers
 * compute it per request with `effectiveAvailability`).
 */
async function readAvailabilityState(workspaceId: string): Promise<AvailabilityState | null> {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { availability: true },
  });
  if (!workspace) return null;
  if (workspace.availability !== "AUTO") return { mode: workspace.availability, members: [] };
  const memberships = await prisma.membership.findMany({
    // Hours and time zone are always written together (saveBusinessHours).
    where: { workspaceId, businessHoursTimeZone: { not: null } },
    select: { businessHoursTimeZone: true, businessHours: true },
  });
  return {
    mode: "AUTO",
    members: memberships.map((m) => ({ timeZone: m.businessHoursTimeZone, hours: m.businessHours })),
  };
}

/** Dashboard read (uncached): the chosen mode and what the widget shows now. */
export async function getWorkspaceAvailability(
  workspaceId: string,
  now = new Date(),
): Promise<{ mode: AvailabilityMode; effective: EffectiveAvailability }> {
  const state = (await readAvailabilityState(workspaceId)) ?? { mode: "LIVE" as const, members: [] };
  return { mode: state.mode, effective: effectiveAvailability(state.mode, state.members, now) };
}

/**
 * Widget read: Live/Away now. The inputs are cached briefly in memory like
 * the Product lookups (product-lookup-cache.ts); `setAvailability` and
 * `saveBusinessHours` in workspace.ts, the only writers, clear the cache.
 * The clock is applied per call, so a cached AUTO state still switches at
 * the exact start and end of someone's hours.
 */
export async function getCachedEffectiveAvailability(
  workspaceId: string,
  now = new Date(),
): Promise<EffectiveAvailability> {
  const state = await cachedProductLookup(`availability:${workspaceId}`, () => readAvailabilityState(workspaceId));
  if (!state) return "LIVE";
  return effectiveAvailability(state.mode, state.members, now);
}
