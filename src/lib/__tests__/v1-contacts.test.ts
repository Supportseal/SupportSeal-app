import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GET as listContactsRoute } from "@/app/api/v1/contacts/route";
import { GET as getContactRoute } from "@/app/api/v1/contacts/[contactId]/route";
import { signCursor } from "@/lib/api/cursor";
import { NOT_FOUND_MESSAGE } from "@/lib/api/v1-route";
import { CONTACT_EMAIL_REGEX } from "@/lib/contact-email";
import { startTestDb, stopTestDb, type TestDb } from "@/test/integration-db";
import { seedTenant, type TenantRows } from "@/test/tenant-fixtures";
import { freshIp, mintToken, snapshot, v1Request } from "@/test/v1-harness";

let db: TestDb;
let alpha: TenantRows;
let beta: TenantRows;
let alphaReader: string;
let alphaWithoutScope: string;
let betaReader: string;

const list = (token: string, query = "") =>
  listContactsRoute(v1Request("GET", `/api/v1/contacts${query}`, { token, ip: freshIp() }), { params: Promise.resolve({}) });
const one = (token: string, id: string) =>
  getContactRoute(v1Request("GET", `/api/v1/contacts/${id}`, { token, ip: freshIp() }), { params: Promise.resolve({ contactId: id }) });

beforeAll(async () => {
  db = await startTestDb();
  alpha = await seedTenant(db.prisma, "alpha");
  beta = await seedTenant(db.prisma, "beta");
  alphaReader = (await mintToken(db.prisma, alpha.workspaceId, ["contacts:read"])).token;
  alphaWithoutScope = (await mintToken(db.prisma, alpha.workspaceId, ["conversations:read"])).token;
  betaReader = (await mintToken(db.prisma, beta.workspaceId, ["contacts:read"])).token;
});

afterAll(async () => {
  await stopTestDb(db);
});

describe("GET /api/v1/contacts", () => {
  // 11 extra rows in Alpha next to the seeded one (12 total: 9 with an email,
  // 2 anonymous chat visitors), staggered by the minute so pages, the email
  // filter and cursor positions are all deterministic.
  const PAGE_BASE = new Date("2026-01-01T00:00:00.000Z").getTime();
  const ALPHA_EMAILS = 9;

  beforeAll(async () => {
    const data = Array.from({ length: ALPHA_EMAILS + 2 }, (_, i) => ({
      workspaceId: alpha.workspaceId,
      // The last two are anonymous chat visitors (FR-CHAT-04): no email, and
      // the email filter never matches them, but the list still shows them.
      email: i < ALPHA_EMAILS ? `reader-${i + 1}@example.test` : null,
      name: i < ALPHA_EMAILS && i % 2 === 0 ? `Reader ${i + 1}` : null,
      createdAt: new Date(PAGE_BASE + i * 60_000),
    }));
    await db.prisma.contact.createMany({ data });
  });

  const alphaRows = () =>
    db.prisma.contact.findMany({
      where: { workspaceId: alpha.workspaceId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true, name: true, email: true, createdAt: true },
    });
  const byEmail = async (email: string) => {
    const row = (await alphaRows()).find((candidate) => candidate.email === email);
    if (row === undefined) throw new Error(`fixture contact ${email} is missing`);
    return row;
  };

  it("lists the Workspace's Contacts oldest first, in the published shape", async () => {
    const response = await list(alphaReader);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const body = await response.json();
    const rows = await alphaRows();
    expect(body).toEqual({
      items: rows.map((row) => ({ id: row.id, name: row.name, email: row.email, createdAt: row.createdAt.toISOString() })),
      nextCursor: null,
    });
  });

  it("pages with limit and cursor, walking every page and ending on a null cursor", async () => {
    const rows = await alphaRows();
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await (await list(alphaReader, `?limit=5${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`)).json();
      expect(page.items.length).toBeLessThanOrEqual(5);
      seen.push(...page.items.map((item: { id: string }) => item.id));
      cursor = page.nextCursor;
    } while (cursor !== null);
    expect(seen).toEqual(rows.map((row) => row.id));
  });

  it("narrows to the one Contact an email identifies, whatever the case spelling", async () => {
    const expected = await byEmail("reader-3@example.test");
    // The filter lower-cases the way upsertContact stores.
    const page = await (await list(alphaReader, "?email=Reader-3@Example.TEST")).json();
    expect(page).toEqual({
      items: [{ id: expected.id, name: expected.name, email: "reader-3@example.test", createdAt: expected.createdAt.toISOString() }],
      nextCursor: null,
    });
  });

  it("finds an address the Workspace's permissive acceptance stored (a@b..com)", async () => {
    // Regression (PR 104 review): the form accepts a@b..com
    // (CONTACT_EMAIL_REGEX), so the filter must accept it too and the
    // response must carry the stored value as-is.
    await db.prisma.contact.create({
      data: { workspaceId: alpha.workspaceId, email: "a@b..com", createdAt: new Date(PAGE_BASE + 20 * 60_000) },
    });
    const filtered = await list(alphaReader, `?email=${encodeURIComponent("a@b..com")}`);
    expect(filtered.status).toBe(200);
    expect((await filtered.json()).items.map((item: { email: string | null }) => item.email)).toEqual(["a@b..com"]);
    const all = await (await list(alphaReader, "?limit=100")).json();
    expect(all.items.some((item: { email: string | null }) => item.email === "a@b..com")).toBe(true);
  });

  it("answers an email no Contact carries with an empty page, not an error", async () => {
    const page = await list(alphaReader, "?email=nobody-here@example.test");
    expect(page.status).toBe(200);
    expect(await page.json()).toEqual({ items: [], nextCursor: null });
  });

  it("finds a stored sender longer than the widget's 254-character bound", async () => {
    // Regression (PR 104 review): inbound mail stores parsed senders as-is,
    // unbounded, while the widget/form entry points cap input at 254
    // characters (normalizeContactEmail). The filter follows the store, not
    // the entry points: a longer stored sender stays searchable, and a
    // well-shaped value nobody carries is an empty page, never a 400.
    const long = `${"l".repeat(140)}@${"d".repeat(120)}.example.test`;
    expect(long.length).toBeGreaterThan(254);
    expect(CONTACT_EMAIL_REGEX.test(long)).toBe(true);
    await db.prisma.contact.create({
      data: { workspaceId: alpha.workspaceId, email: long, createdAt: new Date(PAGE_BASE + 21 * 60_000) },
    });
    const stored = await list(alphaReader, `?email=${encodeURIComponent(long)}`);
    expect(stored.status).toBe(200);
    expect((await stored.json()).items.map((item: { email: string | null }) => item.email)).toEqual([long]);
    const unknown = `${"x".repeat(140)}@${"y".repeat(120)}.example.test`;
    const empty = await list(alphaReader, `?email=${encodeURIComponent(unknown)}`);
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ items: [], nextCursor: null });
  });

  it("answers every wrong cursor the same way, and never with the row it names", async () => {
    const cursor = (await (await list(alphaReader, "?limit=5")).json()).nextCursor as string;
    expect(cursor).toBeDefined();
    const probes: [string, Promise<Response>][] = [
      ["garbage", list(alphaReader, "?cursor=garbage")],
      ["truncated", list(alphaReader, `?cursor=${encodeURIComponent(cursor.slice(0, -2))}`)],
      ["tampered", list(alphaReader, `?cursor=${encodeURIComponent(`${cursor.slice(0, -3)}aaa${cursor.slice(-2)}`)}`)],
      ["another Workspace's", list(betaReader, `?cursor=${encodeURIComponent(cursor)}`)],
      ["another route's", list(alphaReader, `?cursor=${encodeURIComponent(signCursor({ workspaceId: alpha.workspaceId, route: "/api/v1/conversations" }, { id: "x" }))}`)],
      ["another filter set's", list(alphaReader, `?email=reader-3@example.test&cursor=${encodeURIComponent(cursor)}`)],
      ["oversized", list(alphaReader, `?cursor=${"x".repeat(513)}`)],
    ];
    const answers = [];
    for (const [name, promise] of probes) {
      const response = await promise;
      expect(response.status, name).toBe(400);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      answers.push(await snapshot(response));
    }
    for (const answer of answers) expect(answer).toEqual(answers[0]);
    expect(JSON.parse(answers[0].text)).toEqual({
      error: {
        code: "invalid_cursor",
        message:
          "This cursor is not valid here. Send back the nextCursor of the previous response, unchanged, to the same endpoint with the same filters.",
      },
    });
  });

  it("binds the cursor to the lower-cased email, so any case spelling verifies", async () => {
    const reader1 = await byEmail("reader-1@example.test");
    const binding = (email: string) => ({
      workspaceId: alpha.workspaceId,
      route: "/api/v1/contacts",
      filters: { email },
    });
    const payload = { id: reader1.id, createdAt: reader1.createdAt.toISOString() };
    // Minted for the stored (lower-case) spelling: resumes under any spelling,
    // and the position after the only match is the end of the list.
    const lower = signCursor(binding("reader-1@example.test"), payload);
    const resumes = await list(alphaReader, `?email=Reader-1@Example.TEST&cursor=${encodeURIComponent(lower)}`);
    expect(resumes.status).toBe(200);
    expect(await resumes.json()).toEqual({ items: [], nextCursor: null });
    // Minted for an upper-case spelling: the route binds the normalized form,
    // so a cursor that claims otherwise is just a wrong cursor.
    const upper = signCursor(binding("READER-1@EXAMPLE.TEST"), payload);
    const refused = await list(alphaReader, `?email=READER-1@EXAMPLE.TEST&cursor=${encodeURIComponent(upper)}`);
    expect(refused.status).toBe(400);
    expect((await refused.json()).error.code).toBe("invalid_cursor");
  });

  it("treats an empty cursor as no cursor, so the first page always works", async () => {
    const absent = await (await list(alphaReader, "?limit=5")).json();
    const forwarded = await list(alphaReader, "?limit=5&cursor=");
    expect(forwarded.status).toBe(200);
    expect(await forwarded.json()).toEqual(absent);
  });

  it("refuses an unknown or malformed parameter, naming it", async () => {
    const response = await list(alphaReader, "?emial=x@example.test");
    expect(response.status).toBe(400);
    expect((await response.json()).error.details).toEqual([{ field: "emial", message: "Unknown query parameter." }]);
    for (const bad of ["?email=not-an-email", "?email=reader-2@example.test extra", "?email=reader-2@example.test' OR 1=1--", "?limit=0", "?limit=101", "?limit=abc"]) {
      const refused = await list(alphaReader, bad);
      expect(refused.status, bad).toBe(400);
      expect((await refused.json()).error.code).toBe("invalid_request");
    }
    expect((await (await list(alphaReader, "?email=not-an-email")).json()).error.details).toEqual([
      { field: "email", message: expect.any(String) },
    ]);
  });

  it("answers a seeded fuzz of guessed emails and cursors like its class baseline, never 5xx", async () => {
    // docs/agent-api-plan.md, "Required tests per phase" #4: a deterministic
    // seeded loop, not a property-testing dependency, so a CI failure replays
    // exactly. Baselines: the reader-1 page for any spelling of that address,
    // an empty page for a well-formed address nobody carries, 400
    // invalid_request for a malformed value, one invalid_cursor for every
    // wrong cursor.
    let seed = 0x5eed_c0de;
    const step = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed;
    };
    const pick = (max: number) => step() % max;

    const matching = await snapshot(await list(alphaReader, "?email=reader-1@example.test"));
    const emptyPage = await snapshot(await list(alphaReader, "?email=nope-42@example.test"));
    const malformed = await snapshot(await list(alphaReader, "?email=not-an-email"));
    const wrongCursor = await snapshot(await list(alphaReader, "?cursor=garbage"));
    expect(matching.status).toBe(200);
    expect(emptyPage.status).toBe(200);
    expect(malformed.status).toBe(400);
    expect(wrongCursor.status).toBe(400);

    // Guessed emails: spellings of the known address (all normalize to it),
    // well-formed addresses nobody carries, and malformed values.
    const spellings = ["READER-1@EXAMPLE.TEST", "Reader-1@Example.test", "reader-1@EXAMPLE.test"];
    const unknowns = ["reader-99@example.test", "nope-42@example.test", "x@y.example.test"];
    const malformeds = ["not-an-email", "reader-2@example.test extra", "reader-2@example.test' OR 1=1--", "@example.test", "reader-2@"];
    const emailProbes: [string, typeof matching][] = [];
    for (let i = 0; i < 18; i += 1) {
      const flavor = pick(3);
      const address =
        flavor === 0 ? spellings[pick(spellings.length)] : flavor === 1 ? unknowns[pick(unknowns.length)] : malformeds[pick(malformeds.length)];
      emailProbes.push([address, flavor === 0 ? matching : flavor === 1 ? emptyPage : malformed]);
    }

    const cursor = (await (await list(alphaReader, "?limit=5")).json()).nextCursor as string;
    const cursorValues = [
      Buffer.from(randomUUID()).toString("base64url").slice(0, 20 + pick(30)),
      cursor.slice(0, pick(cursor.length - 1)),
      `${cursor.slice(0, -4)}${String.fromCharCode(cursor.charCodeAt(cursor.length - 4) ^ (1 << pick(7)))}${cursor.slice(-3)}`,
      signCursor({ workspaceId: alpha.workspaceId, route: "/api/v1/conversations" }, { id: "x" }),
      signCursor({ workspaceId: beta.workspaceId, route: "/api/v1/contacts" }, { id: "x" }),
      "x".repeat(513),
    ];

    for (const [address, baseline] of emailProbes) {
      const answer = await snapshot(await list(alphaReader, `?email=${encodeURIComponent(address)}`));
      expect(answer, address).toEqual(baseline);
    }
    for (const value of cursorValues) {
      const answer = await snapshot(await list(alphaReader, `?cursor=${encodeURIComponent(value)}`));
      expect(answer, value.slice(0, 24)).toEqual(wrongCursor);
    }
  });

  it("never leaks another Workspace's Contacts, in either direction", async () => {
    const betaContact = await db.prisma.contact.findFirstOrThrow({
      where: { workspaceId: beta.workspaceId },
      select: { email: true },
    });
    const asBeta = await (await list(betaReader, "?limit=100")).json();
    expect(asBeta.items.map((item: { email: string | null }) => item.email)).toEqual([betaContact.email]);
    const text = JSON.stringify(asBeta);
    for (const leak of ["reader-1@example.test", "customer-alpha", alpha.workspaceId]) expect(text).not.toContain(leak);
    // And Alpha's email filter does not find Beta's address.
    const filtered = await (await list(alphaReader, `?email=${encodeURIComponent(betaContact.email ?? "none@example.test")}`)).json();
    expect(filtered).toEqual({ items: [], nextCursor: null });
  });
});

describe("GET /api/v1/contacts/{contactId}", () => {
  it("reads one Contact in exactly the list item's shape", async () => {
    const contact = await db.prisma.contact.findFirstOrThrow({
      where: { workspaceId: alpha.workspaceId, email: "reader-1@example.test" },
      select: { id: true, name: true, email: true, createdAt: true },
    });
    const response = await one(alphaReader, contact.id);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({
      id: contact.id,
      name: contact.name,
      email: contact.email,
      createdAt: contact.createdAt.toISOString(),
    });
  });

  it("answers an unknown or foreign id with the same 404, and a malformed id too", async () => {
    const foreignId = (beta.where.Contact as { id: string }).id;
    const unknown = await snapshot(await one(alphaReader, randomUUID()));
    const foreign = await snapshot(await one(alphaReader, foreignId));
    const asBeta = await snapshot(await one(betaReader, (alpha.where.Contact as { id: string }).id));
    const malformed = await snapshot(await one(alphaReader, "not-a-uuid"));
    for (const answer of [foreign, asBeta, malformed]) expect(answer).toEqual(unknown);
    expect(unknown.status).toBe(404);
    expect(JSON.parse(unknown.text)).toEqual({ error: { code: "not_found", message: NOT_FOUND_MESSAGE } });
  });
});

describe("contacts:read scope", () => {
  it("refuses a token without it, naming the scope to add", async () => {
    const refused = await list(alphaWithoutScope);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({
      error: {
        code: "insufficient_scope",
        message: "This API token does not have the contacts:read scope. Create a token that includes contacts:read and retry.",
      },
    });
    const byId = await one(alphaWithoutScope, (alpha.where.Contact as { id: string }).id);
    expect(byId.status).toBe(403);
  });
});
