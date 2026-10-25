#!/usr/bin/env node
/**
 * Development-only seed: realistic content for the unified inbox so browser
 * verification and screenshots have credible data. Demo seed data is outside
 * V1 scope; this script exists for local development only and is not shipped
 * behaviour. Idempotent: skips when the workspace already has conversations.
 */
import crypto from "node:crypto";
import { allocateTicketNumber } from "../src/lib/ticket";

async function main() {
  process.env.DATABASE_URL = process.env.DATABASE_URL || "";
  const { initDevDb } = await import("../src/lib/dev-pglite");
  const prisma = await initDevDb();

  const existing = await prisma.conversation.findFirst();
  if (existing) {
    console.log("Seed data already present; skipping.");
    await prisma.$disconnect();
    process.exit(0);
  }

  // Bootstrap the founder account through the real auth API when missing, so
  // reseading is one command (dev only; password is a known dev value).
  let founder = await prisma.user.findUnique({ where: { email: "founder@example.com" } });
  if (!founder) {
    const { getAuth } = await import("../src/lib/auth");
    const auth = await getAuth();
    await auth.api.signUpEmail({
      body: {
        name: "Demo Founder",
        email: "founder@example.com",
        password: "correct-horse-battery",
      },
      headers: new Headers({ origin: "http://localhost:3000" }),
    });
    founder = await prisma.user.findUniqueOrThrow({ where: { email: "founder@example.com" } });
    console.log("Created founder@example.com (password: correct-horse-battery)");
  }

  let workspace = await prisma.workspace.findFirst();
  if (!workspace) {
    workspace = await prisma.workspace.create({
      data: {
        name: "Acme Studio",
        memberships: { create: { userId: founder.id, role: "ADMIN" } },
      },
    });
    console.log(`Created workspace "${workspace.name}"`);
  }
  const ws: { id: string; name: string } = workspace;

  let products = await prisma.product.findMany({ where: { workspaceId: ws.id } });
  if (products.length === 0) {
    const created = await Promise.all(
      [
        { name: "Alpha SaaS", color: "#2563eb", domains: ["app.alpha.example.com"] },
        { name: "Beacon Forms", color: "#db2777", domains: ["forms.beacon.example.com"] },
        { name: "PM Toolkit", color: "#ca8a04", domains: ["pm.example.com"] },
      ].map((p) =>
        prisma.product.create({
          data: {
            workspaceId: ws.id,
            name: p.name,
            primaryColor: p.color,
            widgetPublicKey: `pk_${crypto.randomBytes(24).toString("base64url")}`,
            domains: { create: p.domains.map((domain) => ({ domain })) },
          },
        }),
      ),
    );
    products = created;
    console.log(`Created ${created.length} products`);
  }

  async function contact(email: string, name: string | null) {
    return prisma.contact.upsert({
      where: { workspaceId_email: { workspaceId: ws.id, email } },
      create: { workspaceId: ws.id, email, name },
      update: { name },
    });
  }

  async function conversation(
    product: { id: string },
    contactRow: { id: string },
    channel: "CHAT" | "EMAIL",
    subject: string | null,
    messages: Array<["CUSTOMER" | "AGENT" | "NOTE", string]>,
    status: "OPEN" | "PENDING" | "CLOSED" = "OPEN",
  ) {
    const conv = await prisma.conversation.create({
      data: {
        workspaceId: ws.id,
        ticketNumber: await allocateTicketNumber(prisma, ws.id),
        productId: product.id,
        contactId: contactRow.id,
        channel,
        subject,
        status,
      },
    });
    // Backdate so seeded threads sort below fresh real conversations.
    let last = new Date(Date.now() - (45 + messages.length * 7) * 60 * 1000);
    for (const [kind, body] of messages) {
      last = new Date(last.getTime() + 1000 * 60 * 7);
      await prisma.message.create({
        data: { conversationId: conv.id, kind, body, createdAt: last },
      });
    }
    await prisma.conversation.update({
      where: { id: conv.id },
      data: { lastMessageAt: last, closedAt: status === "CLOSED" ? last : null },
    });
  }

  const [alpha, bravo] = products;

  const sam = await contact("sam@example.com", "Sam Rivera");
  const kim = await contact("kim@example.com", "Kim Ito");
  const lee = await contact("lee@example.com", null);

  await conversation(alpha, sam, "CHAT", null, [
    ["CUSTOMER", "Hey — the export button on the invoices page does nothing on Safari. Clicked it five times."],
    ["AGENT", "Hi Sam, thanks for the report. Which Safari version are you on, and does the console show anything?"],
    ["CUSTOMER", "18.2, and yes: TypeError: undefined is not an object (evaluating 'csv.headers')"],
  ]);
  await conversation(alpha, kim, "EMAIL", "Invoice PDF missing tax line", [
    ["CUSTOMER", "Hi, our March invoice PDF is missing the GST line — the total looks right but the breakdown is short one row."],
    ["AGENT", "Hi Kim, thanks for flagging. We regenerated March for your account — the GST row is back. Mind checking?"],
    ["CUSTOMER", "All good now, thanks!"],
  ], "PENDING");
  await conversation(bravo ?? alpha, lee, "CHAT", null, [
    ["CUSTOMER", "Is there a way to embed the widget in a Next.js app with app router?"],
    ["AGENT", "Yes — drop the script tag into your root layout and it survives client-side navigation."],
    ["NOTE", "Lee evaluates everything on Proton; keep privacy wording in mind in replies."],
  ], "CLOSED");

  await prisma.savedReply.createMany({
    data: [
      {
        workspaceId: ws.id,
        name: "Refund policy",
        body: "Happy to help with a refund. Purchases within the last 30 days are refunded in full — could you confirm the account email you paid with?",
        createdById: (await prisma.membership.findFirstOrThrow({ where: { workspaceId: ws.id, role: "ADMIN" } })).userId,
      },
      {
        workspaceId: ws.id,
        name: "Billing cycle",
        body: "Your subscription renews on the same calendar day each month. You can switch to yearly any time from Settings → Billing and we prorate the difference.",
        createdById: (await prisma.membership.findFirstOrThrow({ where: { workspaceId: ws.id, role: "ADMIN" } })).userId,
      },
    ],
    skipDuplicates: true,
  });

  const tag = await prisma.tag.upsert({
    where: { workspaceId_name: { workspaceId: ws.id, name: "billing" } },
    create: { workspaceId: ws.id, name: "billing" },
    update: {},
  });
  const first = await prisma.conversation.findFirst({ orderBy: { createdAt: "asc" } });
  if (first) {
    await prisma.conversationTag
      .create({ data: { conversationId: first.id, tagId: tag.id } })
      .catch(() => {});
  }

  console.log(`Seeded 3 conversations, 2 saved replies, 1 tag for "${ws.name}".`);
  console.log(`(seed nonce ${crypto.randomBytes(2).toString("hex")} — safe to ignore)`);
  await prisma.$disconnect();
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
