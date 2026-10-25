import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTestUser, startTestDb, stopTestDb, type TestDb } from "@/test/integration-db";
import { createWorkspace, type WorkspaceContext } from "@/lib/workspace";
import { createProduct } from "@/lib/products";
import { processInboundEmail, type InboundEmail } from "@/lib/email/inbound";
import {
  getMailDomainState,
  normalizeMailDomain,
  removeMailDomain,
  saveMailDomain,
  setMailDnsResolverForTest,
  verifyMailDomain,
  type DnsResolver,
} from "@/lib/email/mail-domain";

let db: TestDb;
const MX = "mx.mail.test";

/** Fake DNS zone: name -> records, or an error code to simulate failures. */
function zone(entries: Record<string, { mx?: string[]; txt?: string[]; error?: string }>): DnsResolver {
  const get = (host: string) => entries[host] ?? {};
  const fail = (code: string) => Object.assign(new Error(code), { code });
  return {
    async resolveMx(host) {
      const e = get(host);
      if (e.error) throw fail(e.error);
      if (!e.mx) throw fail("ENODATA");
      return e.mx.map((exchange, i) => ({ exchange, priority: (i + 1) * 10 }));
    },
    async resolveTxt(host) {
      const e = get(host);
      if (e.error) throw fail(e.error);
      if (!e.txt) throw fail("ENOTFOUND");
      return e.txt.map((value) => [value]);
    },
  };
}

async function seed() {
  const user = await createTestUser(db.prisma, { email: "owner@example.com" });
  const betaUser = await createTestUser(db.prisma, { email: "beta@example.com" });
  process.env.HOSTED_MODE = "1";
  const alpha = await createWorkspace({ userId: user.id, name: "Alpha" });
  const beta = await createWorkspace({ userId: betaUser.id, name: "Beta" });
  process.env.HOSTED_MODE = "";
  if (!alpha.ok || !beta.ok) throw new Error("seed failed");
  const ctx = (id: string, role: "ADMIN" | "AGENT" = "ADMIN", u = user): WorkspaceContext => ({
    user: { id: u.id, name: "Owner", email: u.email },
    workspace: { id, name: "W" },
    role,
  });
  const alphaCtx = ctx(alpha.workspaceId);
  const betaCtx = ctx(beta.workspaceId, "ADMIN", betaUser);
  const product = await createProduct({ ctx: alphaCtx, name: "Acme" });
  if (!product.ok) throw new Error("product failed");
  return { alphaCtx, betaCtx, agentCtx: ctx(alpha.workspaceId, "AGENT"), productId: product.product.id };
}

async function tokenFor(productId: string) {
  return (await db.prisma.productMailDomain.findUniqueOrThrow({ where: { productId } })).verificationToken;
}

beforeAll(async () => {
  db = await startTestDb();
  process.env.INBOUND_EMAIL_DOMAIN = "inbound.example.org";
  process.env.INBOUND_MX_HOSTS = MX;
});
afterAll(async () => {
  await stopTestDb(db);
});
beforeEach(async () => {
  await db.prisma.productMailDomain.deleteMany();
  await db.prisma.emailDelivery.deleteMany();
  await db.prisma.message.deleteMany();
  await db.prisma.conversation.deleteMany();
  await db.prisma.contact.deleteMany();
  await db.prisma.product.deleteMany();
  await db.prisma.membership.deleteMany();
  await db.prisma.workspace.deleteMany();
  await db.prisma.user.deleteMany();
});
afterEach(() => setMailDnsResolverForTest(null));

describe("mail domain setup", () => {
  it("normalizes the domain and refuses the instance's own mail domain", () => {
    expect(normalizeMailDomain("Support@Help.Acme.com")).toBe("help.acme.com");
    expect(normalizeMailDomain("https://help.acme.com/x")).toBe("help.acme.com");
    expect(normalizeMailDomain("inbound.example.org")).toBeNull();
    expect(normalizeMailDomain("a.inbound.example.org")).toBeNull();
    expect(normalizeMailDomain("*.acme.com")).toBeNull();
    expect(normalizeMailDomain("localhost")).toBeNull();
  });

  it("shows the exact MX and TXT records and verifies only when both resolve", async () => {
    const { alphaCtx, productId } = await seed();
    expect(await saveMailDomain({ ctx: alphaCtx, productId, domain: "help.acme.com" })).toEqual({ ok: true });
    const token = await tokenFor(productId);

    const state = await getMailDomainState(alphaCtx, productId);
    expect(state?.status).toBe("pending");
    expect(state?.records).toEqual([
      { id: "mx", type: "MX", host: "help.acme.com", value: MX, priority: 10 },
      { id: "txt", type: "TXT", host: "_inbound-verify.help.acme.com", value: `inbound-verify=${token}` },
    ]);

    // Nothing published yet.
    setMailDnsResolverForTest(zone({}));
    const none = await verifyMailDomain({ ctx: alphaCtx, productId });
    expect(none).toMatchObject({ ok: true, verified: false });
    expect(none.ok && none.checks.map((c) => c.status)).toEqual(["missing", "missing"]);

    // MX only: still not verified (ownership unproven).
    setMailDnsResolverForTest(zone({ "help.acme.com": { mx: [MX] } }));
    expect(await verifyMailDomain({ ctx: alphaCtx, productId })).toMatchObject({ verified: false });
    expect((await getMailDomainState(alphaCtx, productId))?.status).toBe("pending");

    // Wrong token and a foreign MX host are mismatches.
    setMailDnsResolverForTest(
      zone({
        "help.acme.com": { mx: [MX, "aspmx.l.google.com"] },
        "_inbound-verify.help.acme.com": { txt: ["inbound-verify=nope"] },
      }),
    );
    const bad = await verifyMailDomain({ ctx: alphaCtx, productId });
    expect(bad.ok && bad.checks.map((c) => c.status)).toEqual(["mismatch", "mismatch"]);

    // Both correct: verified.
    const good = zone({
      "help.acme.com": { mx: [MX] },
      "_inbound-verify.help.acme.com": { txt: [`inbound-verify=${token}`] },
    });
    setMailDnsResolverForTest(good);
    expect(await verifyMailDomain({ ctx: alphaCtx, productId })).toMatchObject({ ok: true, verified: true });
    expect((await getMailDomainState(alphaCtx, productId))?.status).toBe("verified");

    // A transient DNS failure keeps the verified status; a definitive miss revokes it.
    setMailDnsResolverForTest(zone({ "help.acme.com": { error: "ETIMEOUT" }, "_inbound-verify.help.acme.com": { error: "ESERVFAIL" } }));
    const flaky = await verifyMailDomain({ ctx: alphaCtx, productId });
    expect(flaky.ok && flaky.checks.map((c) => c.status)).toEqual(["unknown", "unknown"]);
    expect((await getMailDomainState(alphaCtx, productId))?.status).toBe("verified");
    setMailDnsResolverForTest(zone({}));
    await verifyMailDomain({ ctx: alphaCtx, productId });
    expect((await getMailDomainState(alphaCtx, productId))?.status).toBe("pending");
  });

  it("derives the MX host from the inbound domain's live MX when not configured", async () => {
    const { alphaCtx, productId } = await seed();
    delete process.env.INBOUND_MX_HOSTS;
    try {
      await saveMailDomain({ ctx: alphaCtx, productId, domain: "help.acme.com" });
      setMailDnsResolverForTest(zone({ "inbound.example.org": { mx: ["mx.sendgrid.net."] } }));
      const state = await getMailDomainState(alphaCtx, productId);
      expect(state?.records[0]).toMatchObject({ type: "MX", value: "mx.sendgrid.net" });
    } finally {
      process.env.INBOUND_MX_HOSTS = MX;
    }
  });

  it("is Admin-only and Workspace-scoped", async () => {
    const { alphaCtx, betaCtx, agentCtx, productId } = await seed();
    expect(await saveMailDomain({ ctx: agentCtx, productId, domain: "help.acme.com" })).toMatchObject({ ok: false });
    await saveMailDomain({ ctx: alphaCtx, productId, domain: "help.acme.com" });
    // Another Workspace can neither read, verify, replace nor remove it.
    expect(await getMailDomainState(betaCtx, productId)).toBeNull();
    expect(await verifyMailDomain({ ctx: betaCtx, productId })).toMatchObject({ ok: false });
    expect(await saveMailDomain({ ctx: betaCtx, productId, domain: "evil.com" })).toMatchObject({ ok: false });
    await removeMailDomain({ ctx: betaCtx, productId });
    expect((await getMailDomainState(alphaCtx, productId))?.domain).toBe("help.acme.com");
  });

  it("allows two pending claims but only one verified domain, enforced by the database", async () => {
    const { alphaCtx, betaCtx, productId } = await seed();
    const other = await createProduct({ ctx: betaCtx, name: "Other" });
    if (!other.ok) throw new Error("product failed");
    await saveMailDomain({ ctx: alphaCtx, productId, domain: "help.acme.com" });
    await saveMailDomain({ ctx: betaCtx, productId: other.product.id, domain: "help.acme.com" });

    const rows = await db.prisma.productMailDomain.findMany({ where: { domain: "help.acme.com" } });
    expect(rows).toHaveLength(2); // pending claims don't conflict

    // The partial unique index (WHERE "verifiedAt" IS NOT NULL) is the
    // backstop for the check-then-update race in verifyMailDomain: whoever
    // verifies second gets P2002, which verifyMailDomain maps to an error.
    await db.prisma.productMailDomain.update({ where: { id: rows[0].id }, data: { verifiedAt: new Date() } });
    await expect(
      db.prisma.productMailDomain.update({ where: { id: rows[1].id }, data: { verifiedAt: new Date() } }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  it("routes mail to a verified domain only, and not to a second claimant", async () => {
    const { alphaCtx, betaCtx, productId } = await seed();
    const other = await createProduct({ ctx: betaCtx, name: "Other" });
    if (!other.ok) throw new Error("product failed");
    const message = (to: string): InboundEmail => ({
      from: { email: "sam@fastmail.dev", name: "Sam" },
      to: [to],
      subject: "Hello",
      text: "Is anyone there?",
      html: null,
      headers: { messageId: `<${to}-${Date.now()}@x>`, inReplyTo: null, references: [], autoSubmitted: null, precedence: null, xAutoreply: null, replyTo: null },
      attachments: [],
    });

    await saveMailDomain({ ctx: alphaCtx, productId, domain: "help.acme.com" });
    // Pending: not routed.
    expect(await processInboundEmail({ email: message("support@help.acme.com") })).toMatchObject({ outcome: "rejected" });

    const token = await tokenFor(productId);
    setMailDnsResolverForTest(
      zone({ "help.acme.com": { mx: [MX] }, "_inbound-verify.help.acme.com": { txt: [`inbound-verify=${token}`] } }),
    );
    await verifyMailDomain({ ctx: alphaCtx, productId });
    const routed = await processInboundEmail({ email: message("Support@Help.Acme.com") });
    expect(routed.outcome).not.toBe("rejected");
    const conversation = await db.prisma.conversation.findFirstOrThrow({ where: { productId } });
    expect(conversation.workspaceId).toBe(alphaCtx.workspace.id);

    // Another Workspace claiming the same domain cannot verify without its own token in DNS.
    await saveMailDomain({ ctx: betaCtx, productId: other.product.id, domain: "help.acme.com" });
    expect(await verifyMailDomain({ ctx: betaCtx, productId: other.product.id })).toMatchObject({ ok: true, verified: false });
  });
});
