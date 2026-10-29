import type { PGlite } from "@electric-sql/pglite";

import type { PrismaClient } from "@/generated/prisma/client";
import type { ApiScope } from "@/lib/api-scopes";
import { generateApiToken } from "@/lib/api-tokens";

let ipCounter = 0;
/** A client IP no other request used, so in-process rate buckets never bleed across cases. */
export const freshIp = () => `2001:db8::${(ipCounter += 1).toString(16)}`;

export async function mintToken(
  prisma: PrismaClient,
  workspaceId: string,
  scopes: readonly ApiScope[],
  overrides: { expiresAt?: Date | null; revokedAt?: Date | null; name?: string } = {},
) {
  const { token, tokenHash, lastFour } = generateApiToken();
  const row = await prisma.apiToken.create({
    data: {
      workspaceId,
      name: overrides.name ?? "v1 test token",
      tokenHash,
      lastFour,
      scopes: [...scopes],
      expiresAt: overrides.expiresAt ?? null,
      revokedAt: overrides.revokedAt ?? null,
    },
  });
  return { token, row };
}

export type V1RequestOptions = {
  token?: string | null;
  authorization?: string;
  ip?: string;
  body?: unknown;
  headers?: Record<string, string>;
};

export function v1Request(method: string, path: string, options: V1RequestOptions = {}): Request {
  const headers: Record<string, string> = { "x-forwarded-for": options.ip ?? freshIp(), ...options.headers };
  if (options.authorization !== undefined) headers.authorization = options.authorization;
  else if (options.token) headers.authorization = `Bearer ${options.token}`;
  const body = options.body === undefined ? undefined : JSON.stringify(options.body);
  if (body !== undefined) headers["content-type"] = "application/json";
  return new Request(`http://localhost:3000${path}`, { method, headers, body });
}

/** Status, parsed body and header names of a response, for byte-for-byte comparisons. */
export async function snapshot(response: Response) {
  const text = await response.text();
  return { status: response.status, text, headers: [...response.headers.keys()].sort() };
}

type Query = PGlite["query"];

/**
 * Run `fn` and count the SQL statements it sent to PGlite, inside
 * transactions too. The deterministic timing proxy from
 * docs/agent-api-plan.md: a foreign id must cost the same statements as an
 * unknown one.
 */
export async function countStatements<T>(pglite: PGlite, fn: () => Promise<T>): Promise<{ result: T; statements: number }> {
  let statements = 0;
  const count = (query: Query): Query =>
    ((...args: Parameters<Query>) => {
      statements += 1;
      return query(...args);
    }) as Query;
  const query = pglite.query.bind(pglite);
  const transaction = pglite.transaction.bind(pglite);
  pglite.query = count(query);
  pglite.transaction = ((callback) =>
    transaction((tx) => {
      tx.query = count(tx.query.bind(tx));
      return callback(tx);
    })) as PGlite["transaction"];
  try {
    return { result: await fn(), statements };
  } finally {
    pglite.query = query;
    pglite.transaction = transaction;
  }
}

/** Deterministic PRNG (mulberry32), so a fuzz failure reproduces from its seed. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FRAGMENTS = ["' OR '1'='1", "\"; DROP TABLE \"Workspace\";--", "{\"$ne\":null}", "%00", "../", "*", "%", "_", "\\"];

/**
 * Guessed variants of a real value: case changes, whitespace, %-encoding,
 * trailing slashes, unicode look-alikes, injection fragments, single-character
 * flips, truncations, and empty or oversized values.
 */
export function mutations(value: string, seed: number, count = 40): string[] {
  const random = seededRandom(seed);
  const pick = <T>(items: readonly T[]) => items[Math.floor(random() * items.length)];
  const at = () => Math.floor(random() * value.length);
  const fixed = [
    "",
    value.toUpperCase(),
    ` ${value}`,
    `${value} `,
    `${value}/`,
    encodeURIComponent(value).replace(/-/gu, "%2D"),
    value.replace(/a/gu, "а").replace(/e/gu, "е"),
    value.slice(0, -1),
    value.slice(1),
    value.repeat(200),
    ...FRAGMENTS,
    ...FRAGMENTS.map((fragment) => value + fragment),
  ];
  const guesses = Array.from({ length: count }, () => {
    const i = at();
    switch (pick(["flip", "truncate", "insert"] as const)) {
      case "flip":
        return value.slice(0, i) + String.fromCharCode(value.charCodeAt(i) ^ (1 << Math.floor(random() * 5))) + value.slice(i + 1);
      case "truncate":
        return value.slice(0, i);
      case "insert":
        return value.slice(0, i) + pick(FRAGMENTS) + value.slice(i);
    }
  });
  return [...new Set([...fixed, ...guesses])].filter((candidate) => candidate !== value);
}
