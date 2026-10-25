import { after } from "next/server";

import { WidgetHostOutcome } from "@/generated/prisma/client";
import { isOriginAllowed } from "@/lib/widget";
import { normalizeDomain, wwwSibling } from "@/lib/domain";
import { prisma } from "@/lib/prisma";
import { patchProduct } from "@/lib/products";
import type { WorkspaceContext } from "@/lib/workspace";

/**
 * Installation signal (issue #192, docs/open-questions.md): per Product, the
 * last time `GET /api/widget/config` was loaded from — or refused for — a
 * hostname. The write is triggered by unauthenticated public requests, so
 * every layer is defensive:
 *
 *  1. `classifyConfigRequest` / `normalizeSignalHost` are pure: an invalid or
 *     oversized host is dropped before anything touches memory or the DB.
 *  2. `HostSignalThrottle` is in-memory and per instance: at most one write
 *     per (Product, outcome, host) per hour, and a small budget of *new*
 *     hosts per Product per minute, so the hot path never gains a DB round
 *     trip and a flood of spoofed hosts cannot become a flood of writes.
 *  3. The write runs after the response (`after`), swallows and logs its own
 *     errors, and is a no-op for unknown or archived Products.
 *  4. In the DB, a per-Product row lock serialises writers, the cap is
 *     checked under that lock, and the unique (productId, host, outcome)
 *     index is the backstop. Pruning is lazy, inside the same write.
 */

/** Distinct hosts kept per Product and outcome. */
export const HOST_SIGNAL_CAP = 50;
/** A row is updated at most once per interval, in memory and in the DB. */
export const HOST_SIGNAL_WRITE_INTERVAL_MS = 60 * 60 * 1000;
/** Refused hosts are forgotten after 30 days. */
export const REJECTED_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Loaded hosts are forgotten after 90 days without a load (overridable default). */
export const LOADED_TTL_MS = 90 * 24 * 60 * 60 * 1000;
/** New (Product, host) admissions per Product per minute, per instance. */
export const NEW_HOST_BUDGET_PER_MINUTE = 10;
const THROTTLE_MAX_KEYS = 5_000;
/** The `host` param is a URL or hostname; anything longer is not a real one. */
const MAX_RAW_HOST_LENGTH = 512;

export type HostSignal = { host: string; outcome: WidgetHostOutcome };

/**
 * The embedding hostname the loader declared (`host` param), derived exactly
 * like the origin gate does (`isWidgetOriginAllowed`), then normalised and
 * validated like the allowlist (`normalizeDomain`). Wildcards, IPs, empty or
 * oversized values return null.
 */
export function normalizeSignalHost(raw: string | null | undefined): string | null {
  if (!raw || raw.length > MAX_RAW_HOST_LENGTH) return null;
  let hostname: string;
  try {
    hostname = new URL(raw).hostname;
  } catch {
    hostname = raw.trim().toLowerCase();
  }
  if (!hostname || hostname.startsWith("*.")) return null;
  return normalizeDomain(hostname);
}

/**
 * Decide what, if anything, a config request says about installation.
 * `allowed` is the origin gate's verdict. A request admitted only by the
 * signed test token (hosted test page) is not an install and records nothing.
 */
export function classifyConfigRequest(input: {
  hostParam: string | null;
  referer: string | null;
  productDomains: string[];
  allowed: boolean;
  serviceHostname: string | null;
  serviceIsProduction: boolean;
}): HostSignal | null {
  const declared = normalizeSignalHost(input.hostParam);
  if (!declared) return null;
  const covered = (host: string) => isOriginAllowed(host, input.productDomains, input.serviceIsProduction);
  if (input.allowed) {
    return covered(declared) ? { host: declared, outcome: WidgetHostOutcome.LOADED } : null;
  }
  // Refused: blame the declared host if the allowlist misses it, else the
  // Referer's host (the gate also checks it).
  let refererHost: string | null = null;
  if (input.referer && input.referer.length <= MAX_RAW_HOST_LENGTH * 4) {
    try {
      refererHost = normalizeSignalHost(new URL(input.referer).hostname);
    } catch {
      refererHost = null;
    }
  }
  const culprit = [declared, refererHost].find(
    (host): host is string => host !== null && host !== input.serviceHostname && !covered(host),
  );
  return culprit ? { host: culprit, outcome: WidgetHostOutcome.REJECTED } : null;
}

/** In-memory, per-instance gate in front of the DB. Bounded in size. */
export class HostSignalThrottle {
  private readonly seen = new Map<string, number>();
  private readonly budgets = new Map<string, { windowStart: number; count: number }>();

  constructor(private readonly intervalMs = HOST_SIGNAL_WRITE_INTERVAL_MS) {}

  private key(productId: string, signal: HostSignal) {
    return `${productId}|${signal.outcome}|${signal.host}`;
  }

  /** True when the caller should schedule a write; records the admission. */
  admit(productId: string, signal: HostSignal, now = Date.now()): boolean {
    const key = this.key(productId, signal);
    const expiresAt = this.seen.get(key);
    if (expiresAt !== undefined && now < expiresAt) return false;
    if (expiresAt === undefined && !this.takeNewHostBudget(productId, now)) return false;
    this.seen.delete(key);
    this.seen.set(key, now + this.intervalMs);
    if (this.seen.size > THROTTLE_MAX_KEYS) {
      const oldest = this.seen.keys().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    return true;
  }

  clear() {
    this.seen.clear();
    this.budgets.clear();
  }

  /** A failed write is retried by the next request instead of waiting an hour. */
  forget(productId: string, signal: HostSignal) {
    this.seen.delete(this.key(productId, signal));
  }

  private takeNewHostBudget(productId: string, now: number): boolean {
    const budget = this.budgets.get(productId);
    if (!budget || now - budget.windowStart >= 60_000) {
      if (this.budgets.size >= THROTTLE_MAX_KEYS) this.budgets.clear();
      this.budgets.set(productId, { windowStart: now, count: 1 });
      return true;
    }
    if (budget.count >= NEW_HOST_BUDGET_PER_MINUTE) return false;
    budget.count += 1;
    return true;
  }
}

const throttle = new HostSignalThrottle();

export type RecordResult = "written" | "unchanged" | "capped" | "no_product";

/**
 * Record one signal. Concurrency: the Product row is locked `FOR NO KEY
 * UPDATE` (FK checks from other inserts still pass), so writers for one
 * Product run one at a time; the count/evict/insert below is therefore
 * race-free and the Product can never exceed the cap. The same lock query
 * only matches an unarchived Product, so unknown and archived Products write
 * nothing no matter what the caller believes. The unique index on
 * (productId, host, outcome) stays as the backstop, and the conditional
 * update (`lastSeenAt` older than the interval) keeps the hourly throttle
 * true across instances and restarts.
 */
export async function recordHostSignal(
  productId: string,
  signal: HostSignal,
  now: Date = new Date(),
): Promise<RecordResult> {
  return prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM products WHERE id = ${productId} AND "archivedAt" IS NULL FOR NO KEY UPDATE`;
    if (locked.length === 0) return "no_product";

    await tx.widgetHostSignal.deleteMany({
      where: {
        productId,
        OR: [
          { outcome: WidgetHostOutcome.REJECTED, lastSeenAt: { lt: new Date(now.getTime() - REJECTED_TTL_MS) } },
          { outcome: WidgetHostOutcome.LOADED, lastSeenAt: { lt: new Date(now.getTime() - LOADED_TTL_MS) } },
        ],
      },
    });

    const key = { productId, host: signal.host, outcome: signal.outcome };
    const refreshed = await tx.widgetHostSignal.updateMany({
      where: { ...key, lastSeenAt: { lt: new Date(now.getTime() - HOST_SIGNAL_WRITE_INTERVAL_MS) } },
      data: { lastSeenAt: now },
    });
    if (refreshed.count === 0) {
      if (await tx.widgetHostSignal.findUnique({ where: { productId_host_outcome: key }, select: { id: true } })) {
        return "unchanged";
      }
      const count = await tx.widgetHostSignal.count({ where: { productId, outcome: signal.outcome } });
      if (count >= HOST_SIGNAL_CAP) {
        // Refused hosts are most useful when recent: replace the stalest.
        // Loaded hosts keep their slots, so spoofed subdomains of a
        // wildcard entry cannot push a real host out.
        if (signal.outcome === WidgetHostOutcome.LOADED) return "capped";
        const stale = await tx.widgetHostSignal.findMany({
          where: { productId, outcome: signal.outcome },
          orderBy: { lastSeenAt: "asc" },
          take: count - HOST_SIGNAL_CAP + 1,
          select: { id: true },
        });
        await tx.widgetHostSignal.deleteMany({ where: { id: { in: stale.map((row) => row.id) } } });
      }
      await tx.widgetHostSignal.create({ data: { ...key, lastSeenAt: now } });
    }
    if (signal.outcome === WidgetHostOutcome.LOADED) {
      // The host is evidently allowed now; an old refusal is stale.
      await tx.widgetHostSignal.deleteMany({
        where: { productId, host: signal.host, outcome: WidgetHostOutcome.REJECTED },
      });
    }
    return "written";
  });
}

function runAfterResponse(task: () => Promise<unknown>) {
  const guarded = () =>
    task().catch((error: unknown) => {
      console.warn("[install-signal] write failed:", error instanceof Error ? error.message : "unknown error");
    });
  try {
    after(guarded);
  } catch {
    // Outside a request scope (scripts, tests): fire and forget.
    void guarded();
  }
}

/**
 * Route glue. Synchronous and DB-free on the request path; never throws.
 * Call only with a Product resolved from a real, unarchived widget key.
 */
export function noteWidgetConfigRequest(input: {
  productId: string;
  productDomains: string[];
  hostParam: string | null;
  referer: string | null;
  allowed: boolean;
  serviceHostname: string | null;
  serviceIsProduction: boolean;
}): void {
  try {
    const signal = classifyConfigRequest(input);
    if (!signal || !throttle.admit(input.productId, signal)) return;
    runAfterResponse(async () => {
      try {
        await recordHostSignal(input.productId, signal);
      } catch (error) {
        throttle.forget(input.productId, signal);
        throw error;
      }
    });
  } catch {
    // Telemetry must never fail a public request.
  }
}

/** Test seam: the module-level throttle is per process. */
export function resetHostSignalThrottleForTests() {
  throttle.clear();
}

export type InstallSignals = {
  loaded: { host: string; lastSeenAt: Date }[];
  rejected: { host: string; lastSeenAt: Date; sibling: string | null }[];
};

/** Workspace-scoped read for the Installation panel; null when the Product is not in the Workspace. */
export async function getInstallSignals(input: {
  workspaceId: string;
  productId: string;
  now?: Date;
}): Promise<InstallSignals | null> {
  const now = input.now ?? new Date();
  const product = await prisma.product.findFirst({
    where: { id: input.productId, workspaceId: input.workspaceId },
    select: {
      domains: { select: { domain: true } },
      widgetHostSignals: { orderBy: { lastSeenAt: "desc" } },
    },
  });
  if (!product) return null;
  const domains = product.domains.map((d) => d.domain);
  const loaded: InstallSignals["loaded"] = [];
  const rejected: InstallSignals["rejected"] = [];
  for (const row of product.widgetHostSignals) {
    const age = now.getTime() - row.lastSeenAt.getTime();
    if (row.outcome === WidgetHostOutcome.LOADED) {
      if (age < LOADED_TTL_MS) loaded.push({ host: row.host, lastSeenAt: row.lastSeenAt });
    } else if (age < REJECTED_TTL_MS && !isOriginAllowed(row.host, domains, true)) {
      const sibling = wwwSibling(row.host);
      rejected.push({
        host: row.host,
        lastSeenAt: row.lastSeenAt,
        sibling: sibling && !domains.includes(sibling) ? sibling : null,
      });
    }
  }
  return { loaded, rejected };
}

/**
 * The panel's Allow button: add a recorded refused host to the Product's
 * allowlist through the shared domain core (`patchProduct`: admin-only,
 * Workspace-scoped, apex/www sibling logic), then clear its rejected row(s).
 */
export async function allowRejectedHost(input: {
  ctx: WorkspaceContext;
  productId: string;
  host: string;
  includeSibling: boolean;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const host = normalizeSignalHost(input.host);
  if (!host) return { ok: false, error: "That is not a valid hostname." };
  const product = await prisma.product.findFirst({
    where: { id: input.productId, workspaceId: input.ctx.workspace.id },
    select: { id: true },
  });
  if (!product) return { ok: false, error: "Product not found." };
  const recorded = await prisma.widgetHostSignal.findUnique({
    where: { productId_host_outcome: { productId: product.id, host, outcome: WidgetHostOutcome.REJECTED } },
    select: { id: true },
  });
  if (!recorded) return { ok: false, error: "That host is not in the rejected list (it may have expired)." };

  const patched = await patchProduct({
    ctx: input.ctx,
    productId: product.id,
    addDomains: [host],
    includeSiblings: input.includeSibling,
  });
  // "Already configured" is the end state the admin asked for.
  if (!patched.ok && patched.kind !== "conflict") return { ok: false, error: patched.error };

  const sibling = input.includeSibling ? wwwSibling(host) : null;
  await prisma.widgetHostSignal.deleteMany({
    where: {
      productId: product.id,
      outcome: WidgetHostOutcome.REJECTED,
      host: { in: sibling ? [host, sibling] : [host] },
    },
  });
  return { ok: true };
}
