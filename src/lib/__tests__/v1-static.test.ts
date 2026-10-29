import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

/**
 * The unscoped-Prisma gate (docs/agent-api-plan.md, The choke point): Workspace
 * API code reaches the database only through scopedDb. The lint rule stops it
 * in the editor; this test stops it in CI even if the lint config drifts.
 */

const ROOTS = ["src/app/api/v1", "src/lib/api"];
const FORBIDDEN = [
  { pattern: /from\s+["'](@\/lib\/prisma|@\/generated\/prisma[^"']*|@prisma\/client[^"']*)["']/u, what: "a Prisma import" },
  { pattern: /\$(queryRaw|executeRaw|queryRawUnsafe|executeRawUnsafe)\b/u, what: "raw SQL" },
];

const files = ROOTS.flatMap((root) =>
  readdirSync(path.join(process.cwd(), root), { recursive: true, encoding: "utf8" })
    .filter((file) => /\.tsx?$/u.test(file))
    .map((file) => path.join(root, file)),
);

describe("Workspace API data access", () => {
  it("finds the API source files", () => {
    expect(files).toContain(path.join("src/lib/api", "v1-route.ts"));
    expect(files.some((file) => file.endsWith("route.ts") && file.startsWith("src/app/api/v1"))).toBe(true);
  });

  it("never imports Prisma or runs raw SQL", () => {
    const offences = files.flatMap((file) => {
      const source = readFileSync(file, "utf8");
      return FORBIDDEN.filter(({ pattern }) => pattern.test(source)).map(({ what }) => `${file}: ${what}`);
    });
    expect(offences, "use scopedDb from @/lib/workspace-scope").toEqual([]);
  });

  it("exports every route handler through v1Route", () => {
    const offences = files
      .filter((file) => file.endsWith("route.ts") && file.startsWith("src/app/api/v1"))
      .flatMap((file) => {
        const source = readFileSync(file, "utf8");
        const methods = [...source.matchAll(/export\s+(?:async\s+)?(?:const|function|let|var)\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b(.*)/gu)];
        const reexports = /export\s*\{[^}]*\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/u.test(source);
        return [
          ...methods.filter(([, , rest]) => !/^\s*=\s*v1Route\(/u.test(rest)).map(([, method]) => `${file}: ${method}`),
          ...(reexports ? [`${file}: re-exported handler`] : []),
        ];
      });
    expect(offences, "export const GET = v1Route({ scope }, handler)").toEqual([]);
  });

  it("is enforced by the lint config", async () => {
    const eslint = new ESLint({ cwd: process.cwd() });
    const [result] = await eslint.lintText(
      [
        'import { prisma } from "@/lib/prisma";',
        'import type { Prisma } from "@/generated/prisma/client";',
        "export type Probe = Prisma.ModelName;",
        "export const probe = () => prisma.$queryRawUnsafe('select 1');",
      ].join("\n"),
      { filePath: path.join(process.cwd(), "src/app/api/v1/probe/route.ts") },
    );
    expect(result.messages.map((message) => message.ruleId).sort()).toEqual([
      "no-restricted-imports",
      "no-restricted-imports",
      "no-restricted-syntax",
    ]);
  }, 60_000);
});
