import { defineConfig, globalIgnores } from "eslint/config";
import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypeScript from "eslint-config-next/typescript";

const RAW_SQL = ["$queryRaw", "$executeRaw", "$queryRawUnsafe", "$executeRawUnsafe"];
const SCOPE_FIX = "Workspace API code reads and writes only through scopedDb from @/lib/workspace-scope (docs/agent-api-plan.md, The choke point).";

/** @type {import('eslint').Linter.Config[]} */
const eslintConfig = [
  ...nextCoreWebVitals,
  ...nextTypeScript,
  {
    files: ["src/app/api/v1/**/*.{ts,tsx}", "src/lib/api/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: [{ regex: "prisma", message: SCOPE_FIX }] },
      ],
      "no-restricted-syntax": [
        "error",
        ...RAW_SQL.map((name) => ({ selector: `MemberExpression[property.name="${name}"]`, message: `${name} bypasses the Workspace scope. ${SCOPE_FIX}` })),
        { selector: "ImportExpression", message: `Use a static import so the scope gate can check it. ${SCOPE_FIX}` },
        { selector: "ExportAllDeclaration", message: "Export each handler as `export const GET = v1Route(...)` so it runs behind auth and rate limits." },
      ],
    },
  },
  globalIgnores([
    ".next/**",
    "node_modules/**",
    "src/generated/**",
    "next-env.d.ts",
  ]),
];

export default defineConfig(eslintConfig);
