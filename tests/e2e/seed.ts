#!/usr/bin/env node
/**
 * E2E fixtures (hosted suite). Runs BEFORE the dev server starts (bootstrap
 * chain), while the PGlite file has a single writer. Creates the second
 * Workspace used by the cross-Workspace isolation tests (docs/FRD.md, FR-SEC-01) and
 * writes the fixture values tests need to tests/e2e/.runtime/hosted/fixtures.json.
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";

async function main() {
  process.env.DATABASE_URL = process.env.DATABASE_URL || "";
  const { initDevDb } = await import("../../src/lib/dev-pglite");
  const prisma = await initDevDb();

  const ownerEmail = "beta-owner@e2e.test";
  const ownerPassword = "correct-horse-beta";

  const { getAuth } = await import("../../src/lib/auth");
  const auth = await getAuth();
  await auth.api.signUpEmail({
    body: { name: "Beta Owner", email: ownerEmail, password: ownerPassword },
    headers: new Headers({ origin: process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000" }),
  });
  const owner = await prisma.user.findUniqueOrThrow({ where: { email: ownerEmail } });

  const workspace = await prisma.workspace.create({
    data: {
      name: "Beta Workspace",
      memberships: { create: { userId: owner.id, role: "ADMIN" } },
    },
  });

  const product = await prisma.product.create({
    data: {
      workspaceId: workspace.id,
      name: "Beta Tool",
      primaryColor: "#7c3aed",
      widgetPublicKey: `pk_${crypto.randomBytes(24).toString("base64url")}`,
      inboundEmail: "support@beta.test",
      inboundEmailVerified: new Date(),
      domains: { create: [{ domain: "beta.test" }] },
    },
  });

  const gammaOwnerEmail = "gamma-owner@e2e.test";
  const gammaOwnerPassword = "correct-horse-gamma";
  await auth.api.signUpEmail({
    body: { name: "Gamma Owner", email: gammaOwnerEmail, password: gammaOwnerPassword },
    headers: new Headers({ origin: process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000" }),
  });
  const gammaOwner = await prisma.user.findUniqueOrThrow({ where: { email: gammaOwnerEmail } });
  const gammaWorkspace = await prisma.workspace.create({
    data: {
      name: "Gamma Workspace",
      memberships: { create: { userId: gammaOwner.id, role: "ADMIN" } },
    },
  });
  const gammaProduct = await prisma.product.create({
    data: {
      workspaceId: gammaWorkspace.id,
      name: "Gamma Tool",
      widgetPublicKey: `pk_${crypto.randomBytes(24).toString("base64url")}`,
    },
  });
  const gammaContact = await prisma.contact.create({
    data: { workspaceId: gammaWorkspace.id, email: "gamma-stale@e2e.test", name: "Gaia Stale" },
  });
  const { allocateTicketNumber, formatTicketRef } = await import("../../src/lib/ticket");
  const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60_000);
  const gammaSubject = "Invoice export still stuck";
  const gammaConversation = await prisma.conversation.create({
    data: {
      workspaceId: gammaWorkspace.id,
      ticketNumber: await allocateTicketNumber(prisma, gammaWorkspace.id),
      productId: gammaProduct.id,
      contactId: gammaContact.id,
      channel: "CHAT",
      subject: gammaSubject,
      status: "PENDING",
      createdAt: daysAgo(7),
      lastMessageAt: daysAgo(6),
      firstAgentReplyAt: daysAgo(6),
      messages: {
        create: [
          {
            kind: "CUSTOMER",
            body: "The invoice export has been spinning since yesterday.",
            createdAt: daysAgo(7),
            channel: "CHAT",
          },
          {
            kind: "AGENT",
            body: "We shipped a fix — could you retry the export?",
            createdAt: daysAgo(6),
            agentUserId: gammaOwner.id,
          },
        ],
      },
    },
  });

  const fixtures = {
    beta: {
      workspace: { id: workspace.id, name: workspace.name },
      product: { id: product.id, key: product.widgetPublicKey, inboundEmail: "support@beta.test" },
      owner: { email: ownerEmail, password: ownerPassword },
    },
    gamma: {
      workspace: { id: gammaWorkspace.id, name: gammaWorkspace.name },
      product: { id: gammaProduct.id, key: gammaProduct.widgetPublicKey },
      owner: { email: gammaOwnerEmail, password: gammaOwnerPassword },
      conversation: {
        id: gammaConversation.id,
        subject: gammaSubject,
        ticketRef: formatTicketRef(gammaConversation.ticketNumber),
      },
    },
  };

  const fixturesFile = process.env.E2E_FIXTURES_FILE;
  if (!fixturesFile) throw new Error("E2E_FIXTURES_FILE is required");
  await fs.writeFile(fixturesFile, JSON.stringify(fixtures, null, 2));
  await prisma.$disconnect();
  console.log(`[e2e-seed] Beta workspace ready (${workspace.id})`);
  console.log(
    `[e2e-seed] Gamma stale-PENDING conversation ready (${gammaConversation.id}, last activity 6 days ago)`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
