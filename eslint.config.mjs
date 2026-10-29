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
    files: ["src/app/api/v1/**/*.ts", "src/lib/api/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            { name: "@/lib/prisma", message: SCOPE_FIX },
            { name: "@prisma/client", message: SCOPE_FIX },
          ],
          patterns: [{ group: ["@/generated/prisma", "@/generated/prisma/*", "@prisma/client/*"], message: SCOPE_FIX }],
        },
      ],
      "no-restricted-syntax": [
        "error",
        ...RAW_SQL.map((name) => ({ selector: `MemberExpression[property.name="${name}"]`, message: `${name} bypasses the Workspace scope. ${SCOPE_FIX}` })),
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
