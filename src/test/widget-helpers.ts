import type { TestDb } from "@/test/integration-db";

/** Test helper: force the Workspace availability flag directly. */
export async function setAvailabilityForTest(
  db: TestDb,
  workspaceId: string,
  availability: "LIVE" | "AWAY",
): Promise<void> {
  await db.prisma.workspace.update({ where: { id: workspaceId }, data: { availability } });
}

export { getAvailabilityForProduct } from "@/lib/widget";
