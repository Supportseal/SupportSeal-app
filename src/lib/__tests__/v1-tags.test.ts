import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GET as listTagsRoute } from "@/app/api/v1/tags/route";
import { signCursor } from "@/lib/api/cursor";
import { updateConversation } from "@/lib/conversations";
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
  listTagsRoute(v1Request("GET", `/api/v1/tags${query}`, { token, ip: freshIp() }), { params: Promise.resolve({}) });

beforeAll(async () => {
  db = await startTestDb();
  alpha = await seedTenant(db.prisma, "alpha");
  beta = await seedTenant(db.prisma, "beta");
  alphaReader = (await mintToken(db.prisma, alpha.workspaceId, ["conversations:read"])).token;
  alphaWithoutScope = (await mintToken(db.prisma, alpha.workspaceId, ["contacts:read"])).token;
  betaReader = (await mintToken(db.prisma, beta.workspaceId, ["conversations:read"])).token;
});

afterAll(async () => {
  await stopTestDb(db);
});

describe("GET /api/v1/tags", () => {
  // 11 extra tags in Alpha next to the seeded one (12 total), so pages and
  // cursor positions are deterministic. Every stored name is unique within
  // the Workspace (the schema's @@unique([workspaceId, name])), which is
  // what lets name alone order the list.
  beforeAll(async () => {
    await db.prisma.tag.createMany({
      data: Array.from({ length: 11 }, (_, i) => ({
        workspaceId: alpha.workspaceId,
        name: `lookup-${String(i + 1).padStart(2, "0")}`,
      })),
    });
  });

  const alphaRows = () =>
    db.prisma.tag.findMany({ where: { workspaceId: alpha.workspaceId }, orderBy: [{ name: "asc" }], select: { id: true, name: true } });

  it("lists the Workspace's tags by name, in the published shape", async () => {
    const response = await list(alphaReader);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const body = await response.json();
    const rows = await alphaRows();
    expect(body).toEqual({
      items: rows.map((row) => ({ id: row.id, name: row.name })),
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

  it("resumes strictly after the name the cursor names, and past the last name with an empty page", async () => {
    const rows = await alphaRows();
    const after = signCursor({ workspaceId: alpha.workspaceId, route: "/api/v1/tags" }, { name: rows[3].name });
    const page = await (await list(alphaReader, `?limit=100&cursor=${encodeURIComponent(after)}`)).json();
    expect(page.items.map((item: { id: string }) => item.id)).toEqual(rows.slice(4).map((row) => row.id));
    // The cursor carries only a sort key, so one naming a value beyond the
    // last row — or a since-deleted tag — is a valid cursor at the end.
    const beyond = signCursor({ workspaceId: alpha.workspaceId, route: "/api/v1/tags" }, { name: "zzzz-no-such-tag" });
    const end = await list(alphaReader, `?cursor=${encodeURIComponent(beyond)}`);
    expect(end.status).toBe(200);
    expect(await end.json()).toEqual({ items: [], nextCursor: null });
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
      ["a filter set's (this route binds none)", list(alphaReader, `?cursor=${encodeURIComponent(signCursor({ workspaceId: alpha.workspaceId, route: "/api/v1/tags", filters: { name: "x" } }, { name: "a" }))}`)],
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

  it("treats an empty cursor as no cursor, so the first page always works", async () => {
    const absent = await (await list(alphaReader, "?limit=5")).json();
    const forwarded = await list(alphaReader, "?limit=5&cursor=");
    expect(forwarded.status).toBe(200);
    expect(await forwarded.json()).toEqual(absent);
  });

  it("refuses an unknown or malformed parameter, naming it", async () => {
    // `name` and `tag` are deliberately absent: tags have no filter (the list
    // is the Workspace's whole vocabulary), and `tag` belongs to the
    // Conversations list.
    const response = await list(alphaReader, "?name=lookup-01");
    expect(response.status).toBe(400);
    expect((await response.json()).error.details).toEqual([{ field: "name", message: "Unknown query parameter." }]);
    for (const bad of ["?tag=lookup-01", "?q=billing", "?limit=0", "?limit=101", "?limit=abc"]) {
      const refused = await list(alphaReader, bad);
      expect(refused.status, bad).toBe(400);
      expect((await refused.json()).error.code).toBe("invalid_request");
    }
  });

  it("answers a seeded fuzz of guessed cursors like its class baseline, never 5xx", async () => {
    // docs/agent-api-plan.md, "Required tests per phase" #4: a deterministic
    // seeded loop, not a property-testing dependency, so a CI failure
    // replays exactly. Baselines: the first page for a good request, one
    // invalid_cursor for every wrong cursor.
    let seed = 0x5eed_7a95;
    const step = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed;
    };
    const pick = (max: number) => step() % max;

    const firstPage = await snapshot(await list(alphaReader, "?limit=5"));
    const wrongCursor = await snapshot(await list(alphaReader, "?cursor=garbage"));
    expect(firstPage.status).toBe(200);
    expect(wrongCursor.status).toBe(400);

    const cursor = (await (await list(alphaReader, "?limit=5")).json()).nextCursor as string;
    const cursorValues = [
      Buffer.from(randomUUID()).toString("base64url").slice(0, 20 + pick(30)),
      cursor.slice(0, pick(cursor.length - 1)),
      `${cursor.slice(0, -4)}${String.fromCharCode(cursor.charCodeAt(cursor.length - 4) ^ (1 << pick(7)))}${cursor.slice(-3)}`,
      signCursor({ workspaceId: alpha.workspaceId, route: "/api/v1/conversations" }, { id: "x" }),
      signCursor({ workspaceId: beta.workspaceId, route: "/api/v1/tags" }, { name: "x" }),
      signCursor({ workspaceId: alpha.workspaceId, route: "/api/v1/tags", filters: { name: "x" } }, { name: "a" }),
      "x".repeat(513),
    ];

    for (const value of cursorValues) {
      const answer = await snapshot(await list(alphaReader, `?cursor=${encodeURIComponent(value)}`));
      expect(answer, value.slice(0, 24)).toEqual(wrongCursor);
    }
    // And a plain re-request of the first page stays the same page.
    expect(await snapshot(await list(alphaReader, "?limit=5"))).toEqual(firstPage);
  });

  it("keeps a tag listed once no Conversation carries it any more", async () => {
    // The docs say a tag exists from its first write and removal from the
    // last Conversation does not delete it. Exercise the real writer both
    // ways and pin the list's side of that contract.
    const conversationId = (alpha.where.Conversation as { id: string }).id;
    const write = (changes: { addTags?: string[]; removeTags?: string[] }) =>
      updateConversation({ workspaceId: alpha.workspaceId, conversationId, changes });
    expect(await write({ addTags: ["once-only"] })).toEqual({ ok: true });
    expect(await write({ removeTags: ["once-only"] })).toEqual({ ok: true });
    expect(
      await db.prisma.conversationTag.count({ where: { conversation: { workspaceId: alpha.workspaceId }, tag: { name: "once-only" } } }),
    ).toBe(0);
    const page = await (await list(alphaReader, "?limit=100")).json();
    expect(page.items.some((item: { name: string }) => item.name === "once-only")).toBe(true);
  });

  it("never leaks another Workspace's tags, in either direction", async () => {
    const betaTags = await db.prisma.tag.findMany({ where: { workspaceId: beta.workspaceId }, orderBy: [{ name: "asc" }] });
    const asBeta = await (await list(betaReader, "?limit=100")).json();
    expect(asBeta.items).toEqual(betaTags.map((row) => ({ id: row.id, name: row.name })));
    const text = JSON.stringify(asBeta);
    for (const leak of ["lookup-01", alpha.canary, alpha.workspaceId]) expect(text).not.toContain(leak);
    // And Alpha's list never carries Beta's tags. Compare parsed values, not
    // formatted JSON: stringify emits "name":"x" without a space, so a
    // `"name": "x"` substring search would pass vacuously.
    const asAlpha = await (await list(alphaReader, "?limit=100")).json();
    const alphaNames = asAlpha.items.map((item: { name: string }) => item.name);
    for (const row of betaTags) expect(alphaNames).not.toContain(row.name);
  });
});

describe("conversations:read scope", () => {
  it("refuses a token without it, naming the scope to add", async () => {
    const refused = await list(alphaWithoutScope);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({
      error: {
        code: "insufficient_scope",
        message: "This API token does not have the conversations:read scope. Create a token that includes conversations:read and retry.",
      },
    });
  });
});
