export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // Issue #25: surface a mixed test/live Stripe configuration loudly at boot.
  // Logged, not fatal — billing routes refuse with billing_misconfigured; the
  // operator fixes the environment, the rest of the app keeps serving.
  // Environment-only: no database, no network, inert when Stripe is unset
  // (FR-HOST-01).
  const { guardBillingConfig } = await import("@/lib/stripe-config");
  guardBillingConfig();

  if (!process.env.DATABASE_URL?.trim() && process.env.NODE_ENV !== "production") {
    const { initDevDb } = await import("@/lib/dev-pglite");
    await initDevDb();
    return;
  }

  if (process.env.DATABASE_URL?.trim()) {
    // ADR-0003 spike follow-up (issue #2): surface database clock/timezone
    // misalignment loudly at boot — it silently drops stream messages
    // otherwise. Logged, not fatal: the operator fixes the database, not
    // the process.
    try {
      const { prisma } = await import("@/lib/prisma");
      const { checkDbAlignment } = await import("@/lib/db-alignment");
      const alignment = await checkDbAlignment(prisma);
      if (!alignment.ok) {
        for (const warning of alignment.warnings) {
          console.error(`[db-alignment] ${warning}`);
        }
      }
    } catch (error) {
      console.error(
        "[db-alignment] clock probe failed:",
        error instanceof Error ? error.message : error,
      );
    }
  }
}
