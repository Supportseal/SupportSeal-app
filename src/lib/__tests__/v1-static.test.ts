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
  {
    pattern: /\b(?:from|import|require)\s*\(?\s*["'][^"']*prisma/iu,
    what: "a Prisma import",
  },
  { pattern: /\bimport\s*\(/u, what: "a dynamic import" },
  { pattern: /\$(queryRaw|executeRaw|queryRawUnsafe|executeRawUnsafe)\b/u, what: "raw SQL" },
];

const files = ROOTS.flatMap((root) =>
  readdirSync(path.join(process.cwd(), root), { recursive: true, encoding: "utf8" })
    .filter((file) => /\.tsx?$/u.test(file))
    .map((file) => path.posix.join(root, file.split(path.sep).join("/"))),
);

describe("Workspace API data access", () => {
  it("finds the API source files", () => {
    expect(files).toContain("src/lib/api/v1-route.ts");
    expect(files.some((file) => file.endsWith("route.ts") && file.startsWith("src/app/api/v1"))).toBe(true);
  });

  it("never imports Prisma or runs raw SQL", () => {
    const offences = files.flatMap((file) => {
      const source = readFileSync(file, "utf8");
      return FORBIDDEN.filter(({ pattern }) => pattern.test(source)).map(({ what }) => `${file}: ${what}`);
    });
    expect(offences, "use scopedDb from @/lib/workspace-scope").toEqual([]);
  });

  it("recognises every spelling of a Prisma import", () => {
    const spellings = [
      'import { prisma } from "@/lib/prisma";',
      'import { prisma } from "@/lib/prisma.js";',
      'import type { Prisma } from "@/generated/prisma/client.js";',
      'import { PrismaClient } from "@PRISMA/client";',
      'export { prisma } from "../../lib/prisma";',
      "const { prisma } = require('@/lib/prisma');",
    ];
    for (const line of spellings) expect(FORBIDDEN[0].pattern.test(line), line).toBe(true);
    expect(FORBIDDEN[0].pattern.test('import { scopedDb } from "@/lib/workspace-scope";')).toBe(false);
  });

  it("exports every route handler through v1Route", () => {
    const offences = files
      .filter((file) => file.endsWith("route.ts") && file.startsWith("src/app/api/v1"))
      .flatMap((file) => {
        const source = readFileSync(file, "utf8");
        const methods = [...source.matchAll(/export\s+(?:async\s+)?(?:const|function|let|var)\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b(.*)/gu)];
        const reexports =
          /export\s*\{[^}]*\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/u.test(source) || /export\s*\*/u.test(source);
        return [
          ...methods.filter(([, , rest]) => !/^\s*=\s*v1Route\(/u.test(rest)).map(([, method]) => `${file}: ${method}`),
          ...(reexports ? [`${file}: re-exported handler`] : []),
        ];
      });
    expect(offences, "export const GET = v1Route({ operationId, scope }, handler)").toEqual([]);
  });

  it("names every operation as docs/openapi.json does, for the route's own method and path", () => {
    const operations = new Map<string, string>();
    for (const spec of ["openapi.json", "openapi-draft.json"]) {
      const { paths } = JSON.parse(readFileSync(path.join(process.cwd(), "docs", spec), "utf8")) as {
        paths: Record<string, Record<string, { operationId?: string }>>;
      };
      for (const [route, item] of Object.entries(paths)) {
        for (const [method, operation] of Object.entries(item)) {
          if (operation?.operationId) operations.set(operation.operationId, `${method.toUpperCase()} ${route.replace(/\{[^}]+\}/gu, "{}")}`);
        }
      }
    }
    const offences = files
      .filter((file) => file.endsWith("route.ts") && file.startsWith("src/app/api/v1"))
      .flatMap((file) => {
        const route = `/${path.posix.dirname(file).slice("src/app/".length)}`.replace(/\[[^\]]+\]/gu, "{}");
        const source = readFileSync(file, "utf8");
        return [...source.matchAll(/export\s+const\s+(GET|POST|PUT|PATCH|DELETE)\s*=\s*v1Route(?:<[^>]*>)?\(\s*\{([^}]*)\}/gu)].flatMap(
          ([, method, access]) => {
            const operationId = /\boperationId:\s*"([^"]+)"/u.exec(access)?.[1];
            if (!operationId) return [`${file}: ${method} has no literal operationId`];
            return operations.get(operationId) === `${method} ${route}`
              ? []
              : [`${file}: ${method} ${operationId} is not ${method} ${route} in the OpenAPI documents`];
          },
        );
      });
    expect(offences).toEqual([]);
  });

  it("is enforced by the lint config", async () => {
    const eslint = new ESLint({ cwd: process.cwd() });
    const [result] = await eslint.lintText(
      [
        'import { prisma } from "@/lib/prisma";',
        'import type { Prisma } from "@/generated/prisma/client";',
        'import { prisma as relative } from "../../../../lib/prisma";',
        'import { prisma as suffixed } from "@/lib/prisma.js";',
        'import { PrismaClient } from "@PRISMA/client.mjs";',
        'export * from "./impl";',
        "export type Probe = Prisma.ModelName;",
        "export const probe = () => prisma.$queryRawUnsafe('select 1');",
        "export const lazy = () => import('@/lib/prisma').then(() => [relative, suffixed, PrismaClient]);",
      ].join("\n"),
      { filePath: path.join(process.cwd(), "src/app/api/v1/probe/route.ts") },
    );
    expect(result.messages.map((message) => message.ruleId).sort()).toEqual([
      "no-restricted-imports",
      "no-restricted-imports",
      "no-restricted-imports",
      "no-restricted-imports",
      "no-restricted-imports",
      "no-restricted-syntax",
      "no-restricted-syntax",
      "no-restricted-syntax",
    ]);
  }, 60_000);
});
