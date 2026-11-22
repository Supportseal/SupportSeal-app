/**
 * Short-lived in-memory cache for the public key → Product lookups that every
 * widget and form request starts with (`loadWidgetProduct`,
 * `loadFormProduct`). Without it each widget request read `products` and
 * `product_domains` again, although both change only when an Admin edits the
 * Product (docs/database-load.md).
 *
 * The Workspace's Live/Away availability inputs, read on every widget boot,
 * are cached here too (`availability:<workspaceId>`: the mode plus, in Auto,
 * the members' business hours).
 *
 * Freshness: every Product and ProductDomain write lives in
 * `src/lib/products.ts`, and the only availability inputs writes are
 * `setAvailability` and `saveBusinessHours` in `src/lib/workspace.ts` (all
 * guarded by db-load-caches.test.ts); they
 * clear this cache in-process, so a single app process sees edits, key rotations
 * and archiving at once. Another app process sees them within
 * `PRODUCT_LOOKUP_TTL_MS`. Only hits are cached: an unknown key always asks
 * the database, so a just-created Product works immediately everywhere.
 */
export const PRODUCT_LOOKUP_TTL_MS = 30_000;
const MAX_ENTRIES = 1_000;

type Entry = { value: unknown; expiresAt: number };
type CacheState = { entries: Map<string, Entry>; generation: number; disabled: boolean };

const globalForCache = globalThis as unknown as { __supportsealProductLookups?: CacheState };
const state: CacheState = globalForCache.__supportsealProductLookups ?? {
  entries: new Map(),
  generation: 0,
  // Integration tests write Products straight through Prisma fixtures, so
  // the cache stays out of their way unless a test switches it on.
  disabled: Boolean(process.env.VITEST),
};
globalForCache.__supportsealProductLookups = state;

/**
 * Returns the cached lookup for `key`, or runs `load` and caches a non-null
 * result for `PRODUCT_LOOKUP_TTL_MS`. A write that lands while `load` is in
 * flight bumps the generation, so the (possibly stale) result is returned to
 * this caller but never stored.
 */
export async function cachedProductLookup<T>(key: string, load: () => Promise<T | null>): Promise<T | null> {
  if (state.disabled) return load();
  const now = Date.now();
  const hit = state.entries.get(key);
  if (hit) {
    if (hit.expiresAt > now) return hit.value as T;
    state.entries.delete(key);
  }
  const generation = state.generation;
  const value = await load();
  if (value !== null && generation === state.generation) {
    if (state.entries.size >= MAX_ENTRIES) {
      const oldest = state.entries.keys().next().value;
      if (oldest !== undefined) state.entries.delete(oldest);
    }
    state.entries.set(key, { value, expiresAt: now + PRODUCT_LOOKUP_TTL_MS });
  }
  return value;
}

/** Drops every cached lookup. Call after any Product or ProductDomain write. */
export function invalidateProductLookups(): void {
  state.generation += 1;
  state.entries.clear();
}

/** Test hook: switch the cache on or off (it starts off under Vitest). */
export function setProductLookupCacheEnabled(enabled: boolean): void {
  state.disabled = !enabled;
  invalidateProductLookups();
}
