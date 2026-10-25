import { randomBytes } from "node:crypto";
import { Resolver } from "node:dns/promises";

import { prisma } from "@/lib/prisma";
import { inboundDomain } from "@/lib/email/outbound";
import { normalizeDomain, ProductActionError } from "@/lib/products";
import type { WorkspaceContext } from "@/lib/workspace";

/**
 * Custom inbound mail domain (docs/design/mail-setup.md). The customer
 * points MX at this installation's mail host and publishes a TXT ownership
 * token; verification is plain DNS lookups from this server (no third-party
 * service, identical hosted and self-hosted). Only a *verified* domain
 * routes mail to its Product (src/lib/email/inbound.ts).
 *
 * Why MX + TXT only: receiving mail needs MX; the TXT token proves the
 * customer controls the zone, so nobody can claim a domain whose MX they
 * cannot edit. SPF/DKIM authorise *sending* and are not needed because
 * replies go out from the managed sender (docs/design/sender-domains.md, V2).
 */
export const OWNERSHIP_LABEL = "_inbound-verify";
export const OWNERSHIP_PREFIX = "inbound-verify=";

export type DnsResolver = {
  resolveMx(host: string): Promise<Array<{ exchange: string; priority: number }>>;
  resolveTxt(host: string): Promise<string[][]>;
};

const globalForDns = globalThis as unknown as { __mailDnsResolver?: DnsResolver };

/** Test seam: inject a resolver (or null to restore the real one). */
export function setMailDnsResolverForTest(resolver: DnsResolver | null): void {
  globalForDns.__mailDnsResolver = resolver ?? undefined;
}

function dnsResolver(): DnsResolver {
  if (globalForDns.__mailDnsResolver) return globalForDns.__mailDnsResolver;
  const resolver = new Resolver({ timeout: 4000, tries: 2 });
  // Optional: query specific resolvers (split-horizon DNS, local testing).
  const servers = process.env.MAIL_DNS_SERVERS?.split(",").map((s) => s.trim()).filter(Boolean);
  if (servers?.length) resolver.setServers(servers);
  return resolver;
}

const cleanHost = (host: string) => host.trim().toLowerCase().replace(/\.$/u, "");

type Lookup<T> = { kind: "ok"; value: T } | { kind: "empty" } | { kind: "error" };

/** NXDOMAIN / no records are definitive; timeouts and SERVFAIL are not. */
async function lookup<T extends unknown[]>(run: () => Promise<T>): Promise<Lookup<T>> {
  try {
    const value = await run();
    return value.length > 0 ? { kind: "ok", value } : { kind: "empty" };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENODATA" || code === "ENOTFOUND" ? { kind: "empty" } : { kind: "error" };
  }
}

/** MX hosts customers must use: INBOUND_MX_HOSTS, else the live MX of the inbound domain. */
export async function expectedMxHosts(resolver: DnsResolver = dnsResolver()): Promise<string[]> {
  const configured = process.env.INBOUND_MX_HOSTS?.split(",").map(cleanHost).filter(Boolean);
  if (configured?.length) return configured;
  const found = await lookup(() => resolver.resolveMx(inboundDomain()));
  if (found.kind !== "ok") return [];
  return found.value.sort((a, b) => a.priority - b.priority).map((mx) => cleanHost(mx.exchange));
}

export type MailRecord = { id: "mx" | "txt"; type: "MX" | "TXT"; host: string; value: string; priority?: number };

export function requiredRecords(domain: string, token: string, mxHosts: string[]): MailRecord[] {
  return [
    ...mxHosts.map((value, index) => ({
      id: "mx" as const,
      type: "MX" as const,
      host: domain,
      value,
      priority: (index + 1) * 10,
    })),
    { id: "txt", type: "TXT", host: `${OWNERSHIP_LABEL}.${domain}`, value: `${OWNERSHIP_PREFIX}${token}` },
  ];
}

export type RecordCheck = {
  id: "mx" | "txt";
  label: string;
  status: "ok" | "missing" | "mismatch" | "unknown";
  detail: string;
};

export type DnsCheckResult = { verified: boolean; checks: RecordCheck[] };

export async function checkMailDomainDns(input: {
  domain: string;
  token: string;
  resolver?: DnsResolver;
}): Promise<DnsCheckResult> {
  const resolver = input.resolver ?? dnsResolver();
  const [expected, mx, txt] = await Promise.all([
    expectedMxHosts(resolver),
    lookup(() => resolver.resolveMx(input.domain)),
    lookup(() => resolver.resolveTxt(`${OWNERSHIP_LABEL}.${input.domain}`)),
  ]);

  let mxCheck: RecordCheck;
  if (expected.length === 0) {
    mxCheck = { id: "mx", label: "MX record", status: "unknown", detail: "This installation has not published a mail host (set INBOUND_MX_HOSTS)." };
  } else if (mx.kind === "error") {
    mxCheck = { id: "mx", label: "MX record", status: "unknown", detail: "Couldn't query DNS; try again in a moment." };
  } else if (mx.kind === "empty") {
    mxCheck = { id: "mx", label: "MX record", status: "missing", detail: `No MX record found for ${input.domain}.` };
  } else {
    const hosts = mx.value.map((record) => cleanHost(record.exchange));
    const foreign = hosts.filter((host) => !expected.includes(host));
    mxCheck =
      foreign.length === 0
        ? { id: "mx", label: "MX record", status: "ok", detail: `Mail is routed to ${hosts.join(", ")}.` }
        : {
            id: "mx",
            label: "MX record",
            status: "mismatch",
            detail: `Found ${foreign.join(", ")}. Remove it so all mail reaches ${expected.join(" / ")}.`,
          };
  }

  const wanted = `${OWNERSHIP_PREFIX}${input.token}`;
  let txtCheck: RecordCheck;
  if (txt.kind === "error") {
    txtCheck = { id: "txt", label: "Ownership TXT record", status: "unknown", detail: "Couldn't query DNS; try again in a moment." };
  } else if (txt.kind === "empty") {
    txtCheck = { id: "txt", label: "Ownership TXT record", status: "missing", detail: `No TXT record found at ${OWNERSHIP_LABEL}.${input.domain}.` };
  } else if (txt.value.some((chunks) => chunks.join("") === wanted)) {
    txtCheck = { id: "txt", label: "Ownership TXT record", status: "ok", detail: "Token matches." };
  } else {
    txtCheck = { id: "txt", label: "Ownership TXT record", status: "mismatch", detail: "A TXT record exists but its value does not match the token shown above." };
  }

  const checks = [mxCheck, txtCheck];
  return { verified: checks.every((check) => check.status === "ok"), checks };
}

// --- Persistence (Workspace-scoped, Admin only) ------------------------------

export type MailDomainState = {
  domain: string;
  status: "pending" | "verified";
  verifiedAt: Date | null;
  lastCheckedAt: Date | null;
  records: MailRecord[];
};

function assertAdmin(ctx: WorkspaceContext): void {
  if (ctx.role !== "ADMIN") throw new ProductActionError("Only Workspace admins can manage mail setup.");
}

/** Own domain only: not the instance's inbound domain or a subdomain of it. */
export function normalizeMailDomain(input: string): string | null {
  const raw = input.trim().toLowerCase();
  const domain = normalizeDomain(raw.includes("@") ? raw.slice(raw.lastIndexOf("@") + 1) : raw);
  if (!domain || domain === "localhost" || domain.startsWith("*.")) return null;
  const own = cleanHost(inboundDomain());
  return domain === own || domain.endsWith(`.${own}`) ? null : domain;
}

async function loadRow(ctx: WorkspaceContext, productId: string) {
  return prisma.productMailDomain.findFirst({
    where: { productId, product: { workspaceId: ctx.workspace.id } },
  });
}

export async function getMailDomainState(
  ctx: WorkspaceContext,
  productId: string,
): Promise<MailDomainState | null> {
  const row = await loadRow(ctx, productId);
  if (!row) return null;
  return {
    domain: row.domain,
    status: row.verifiedAt ? "verified" : "pending",
    verifiedAt: row.verifiedAt,
    lastCheckedAt: row.lastCheckedAt,
    records: requiredRecords(row.domain, row.verificationToken, await expectedMxHosts()),
  };
}

export async function saveMailDomain(input: {
  ctx: WorkspaceContext;
  productId: string;
  domain: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    assertAdmin(input.ctx);
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
  const domain = normalizeMailDomain(input.domain);
  if (!domain) {
    return { ok: false, error: "Enter a domain you own, like support.example.com (not this installation's own mail domain)." };
  }
  const product = await prisma.product.findFirst({
    where: { id: input.productId, workspaceId: input.ctx.workspace.id },
    select: { id: true, mailDomain: { select: { domain: true } } },
  });
  if (!product) return { ok: false, error: "Product not found." };
  if (product.mailDomain?.domain === domain) return { ok: true };

  // A new domain gets a fresh token and must be verified from scratch.
  const data = {
    domain,
    verificationToken: randomBytes(16).toString("hex"),
    verifiedAt: null,
    lastCheckedAt: null,
  };
  await prisma.productMailDomain.upsert({
    where: { productId: product.id },
    create: { productId: product.id, ...data },
    update: data,
  });
  return { ok: true };
}

export type VerifyOutcome =
  | { ok: true; verified: boolean; checks: RecordCheck[] }
  | { ok: false; error: string };

/**
 * Query DNS and mark the domain verified only when MX and the ownership
 * token both resolve correctly. A definitive failure (missing/mismatched
 * record) revokes an earlier verification so status never lies; a transient
 * lookup failure ("unknown") changes nothing.
 */
export async function verifyMailDomain(input: {
  ctx: WorkspaceContext;
  productId: string;
}): Promise<VerifyOutcome> {
  try {
    assertAdmin(input.ctx);
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
  const row = await loadRow(input.ctx, input.productId);
  if (!row) return { ok: false, error: "Add a mail domain first." };

  const result = await checkMailDomainDns({ domain: row.domain, token: row.verificationToken });
  const definitiveFailure = !result.verified && result.checks.every((check) => check.status !== "unknown");
  if (result.verified) {
    const taken = await prisma.productMailDomain.findFirst({
      where: { domain: row.domain, verifiedAt: { not: null }, NOT: { productId: row.productId } },
      select: { id: true },
    });
    if (taken) return { ok: false, error: "This domain is already verified for another Product." };
  }
  try {
    await prisma.productMailDomain.update({
      where: { id: row.id },
      data: {
        lastCheckedAt: new Date(),
        ...(result.verified ? { verifiedAt: row.verifiedAt ?? new Date() } : {}),
        ...(definitiveFailure ? { verifiedAt: null } : {}),
      },
    });
  } catch (error) {
    // The partial unique index on verified (domain) rows is the backstop for
    // the check-then-update race: a concurrent verify that won the domain
    // makes this update violate it (P2002). Report it, never crash the action.
    if ((error as { code?: string }).code === "P2002") {
      return { ok: false, error: "This domain is already verified for another Product." };
    }
    throw error;
  }
  return { ok: true, verified: result.verified, checks: result.checks };
}

export async function removeMailDomain(input: {
  ctx: WorkspaceContext;
  productId: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    assertAdmin(input.ctx);
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
  await prisma.productMailDomain.deleteMany({
    where: { productId: input.productId, product: { workspaceId: input.ctx.workspace.id } },
  });
  return { ok: true };
}
