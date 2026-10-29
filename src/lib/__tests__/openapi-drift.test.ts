import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { API_ERROR_STATUS } from "@/lib/api-errors";
import { API_SCOPES, type ApiScope } from "@/lib/api-scopes";
import { createBody, MAX_BODY_BYTES, MAX_DOMAINS_PER_LIST, parseCreateBody, parsePatchBody, patchBody, serializeProduct } from "@/lib/product-api";
import { MAX_API_PRODUCTS_PER_WORKSPACE, type ProductWithDomains } from "@/lib/products";
import { WIDGET_RATE_LIMITS } from "@/lib/widget-rate-limit";

/**
 * Drift guard for docs/openapi.json and docs/api-quickstart.md. The spec is
 * hand-written, so these tests are what keep it true: every failure message
 * names the file to update.
 */

const DOCS = path.join(process.cwd(), "docs");
const SPEC_FIX = "Update docs/openapi.json in the same change as the route or schema.";
const HTTP_METHODS = ["GET", "PUT", "POST", "DELETE", "OPTIONS", "HEAD", "PATCH"] as const;

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any -- walking untyped OpenAPI JSON
const spec: Json = JSON.parse(readFileSync(path.join(DOCS, "openapi.json"), "utf8"));
const quickstart = readFileSync(path.join(DOCS, "api-quickstart.md"), "utf8");

const resolve = (node: Json): Json => {
  if (node && typeof node === "object" && typeof node.$ref === "string") {
    return node.$ref
      .replace(/^#\//u, "")
      .split("/")
      .reduce((acc: Json, key: string) => acc[key], spec);
  }
  return node;
};

type Operation = { method: string; path: string; op: Json };
const operations: Operation[] = Object.entries<Json>(spec.paths).flatMap(([route, item]) =>
  Object.entries<Json>(item)
    .filter(([key]) => (HTTP_METHODS as readonly string[]).includes(key.toUpperCase()))
    .map(([method, op]) => ({ method: method.toUpperCase(), path: route, op })),
);

describe("openapi.json vs the route files", () => {
  const routeModules = import.meta.glob(["../../app/api/products/**/route.ts", "../../app/api/v1/**/route.ts"]);

  it("documents exactly the methods each route file exports, and every documented path has a route", async () => {
    const exported = new Map<string, string[]>();
    for (const [file, load] of Object.entries(routeModules)) {
      const mod = (await load()) as Record<string, unknown>;
      const route = "/api/" + file.replace(/^.*\/app\/api\//u, "").replace(/\/route\.ts$/u, "").replace(/\[(\w+)\]/gu, "{$1}");
      exported.set(
        route,
        HTTP_METHODS.filter((m) => typeof mod[m] === "function").sort(),
      );
    }
    const documented = new Map<string, string[]>();
    for (const { method, path: route } of operations) {
      documented.set(route, [...(documented.get(route) ?? []), method].sort());
    }
    expect(
      Object.fromEntries([...documented].sort()),
      `docs/openapi.json documents different paths/methods than the route files under src/app/api/products and src/app/api/v1 export. ${SPEC_FIX}`,
    ).toEqual(Object.fromEntries([...exported].sort()));
  });
});

describe("openapi.json error codes", () => {
  it("lists exactly the codes and statuses of API_ERROR_STATUS", () => {
    const schema = spec.components.schemas.ErrorCode;
    expect(
      schema["x-error-status"],
      `ErrorCode.x-error-status differs from API_ERROR_STATUS in src/lib/api-errors.ts. ${SPEC_FIX}`,
    ).toEqual(API_ERROR_STATUS);
    expect([...schema.enum].sort(), `ErrorCode.enum differs from API_ERROR_STATUS. ${SPEC_FIX}`).toEqual(
      Object.keys(API_ERROR_STATUS).sort(),
    );
  });

  it("documents every code at its real status, with the headers clients rely on", () => {
    const seen = new Set<string>();
    for (const { method, path: route, op } of operations) {
      for (const [status, rawResponse] of Object.entries<Json>(op.responses)) {
        if (Number(status) < 400) continue;
        const response = resolve(rawResponse);
        const where = `${method} ${route} ${status}`;
        const example = response.content?.["application/json"]?.example;
        const code = example?.error?.code as keyof typeof API_ERROR_STATUS;
        expect(code in API_ERROR_STATUS, `${where}: example error code "${code}" is not in API_ERROR_STATUS. ${SPEC_FIX}`).toBe(true);
        expect(API_ERROR_STATUS[code], `${where}: example code "${code}" has a different status in API_ERROR_STATUS. ${SPEC_FIX}`).toBe(Number(status));
        seen.add(code);
        const headers = Object.keys(response.headers ?? {}).map((h) => h.toLowerCase());
        if (status === "401") expect(headers, `${where}: 401 must document WWW-Authenticate. ${SPEC_FIX}`).toContain("www-authenticate");
        if (status === "429") expect(headers, `${where}: 429 must document Retry-After. ${SPEC_FIX}`).toContain("retry-after");
      }
    }
    expect(
      [...seen].sort(),
      `Some API_ERROR_STATUS codes have no documented response (or vice versa). ${SPEC_FIX}`,
    ).toEqual(Object.keys(API_ERROR_STATUS).sort());
  });
});

describe("openapi.json success contract", () => {
  it("documents Cache-Control on every response and Location on the 201", () => {
    for (const { method, path: route, op } of operations) {
      for (const [status, rawResponse] of Object.entries<Json>(op.responses)) {
        const headers = Object.keys(resolve(rawResponse).headers ?? {}).map((h) => h.toLowerCase());
        expect(headers, `${method} ${route} ${status} must document Cache-Control (productResponse/apiError always send it). ${SPEC_FIX}`).toContain("cache-control");
        if (status === "201") expect(headers, `${method} ${route} 201 must document Location. ${SPEC_FIX}`).toContain("location");
      }
    }
    const statuses = Object.fromEntries(operations.map(({ method, path: route, op }) => [`${method} ${route}`, Object.keys(op.responses).filter((s) => Number(s) < 300)]));
    expect(statuses, `Success statuses differ from the routes (POST creates 201; the rest answer 200). ${SPEC_FIX}`).toEqual({
      "GET /api/products": ["200"],
      "POST /api/products": ["201"],
      "GET /api/products/{id}": ["200"],
      "PATCH /api/products/{id}": ["200"],
      "GET /api/v1/whoami": ["200"],
    });
  });
});

describe("openapi.json status codes per operation", () => {
  // The truth table, read from the routes and admin-api.ts. Adding or dropping a status in a route
  // means changing this table and docs/openapi.json together.
  const EXPECTED_STATUSES: Record<string, string[]> = {
    "GET /api/products": ["200", "401", "403", "429", "500"],
    "POST /api/products": ["201", "400", "401", "403", "409", "429", "500"],
    "GET /api/products/{id}": ["200", "401", "403", "404", "429", "500"],
    "PATCH /api/products/{id}": ["200", "400", "401", "403", "404", "409", "429", "500"],
    "GET /api/v1/whoami": ["200", "401", "429", "500"],
  };

  it("documents exactly the statuses each operation can return", () => {
    const documented = Object.fromEntries(
      operations.map(({ method, path: route, op }) => [`${method} ${route}`, Object.keys(op.responses).sort()]),
    );
    expect(
      documented,
      "A status was added to or dropped from an operation in docs/openapi.json. Update EXPECTED_STATUSES in openapi-drift.test.ts and the spec to match the routes.",
    ).toEqual(EXPECTED_STATUSES);
  });
});

describe("numbers quoted in the docs", () => {
  const sources = {
    "docs/openapi.json": JSON.stringify(spec),
    "docs/api-quickstart.md": quickstart,
    "docs/api-tokens.md": readFileSync(path.join(DOCS, "api-tokens.md"), "utf8"),
  };
  const facts = [
    { name: "writes per minute per token", re: /(\d+) writes?\b/gu, actual: WIDGET_RATE_LIMITS.apiTokenWrite, source: "WIDGET_RATE_LIMITS.apiTokenWrite" },
    { name: "reads per minute per token", re: /(\d+) reads?\b/gu, actual: WIDGET_RATE_LIMITS.apiTokenRead, source: "WIDGET_RATE_LIMITS.apiTokenRead" },
    { name: "/api/v1 requests per minute per IP", re: /(\d+) `\/api\/v1` requests\b/gu, actual: WIDGET_RATE_LIMITS.apiIp, source: "WIDGET_RATE_LIMITS.apiIp" },
    { name: "failed token attempts per minute per IP", re: /(\d+) (?:failed|failures)\b/gu, actual: WIDGET_RATE_LIMITS.apiTokenFailure, source: "WIDGET_RATE_LIMITS.apiTokenFailure" },
    { name: "domains per list", re: /(\d+) (?:domains per list|domains\b|entries)/gu, actual: MAX_DOMAINS_PER_LIST, source: "MAX_DOMAINS_PER_LIST" },
    { name: "Products per Workspace through the API", re: /(\d+) Products\b/gu, actual: MAX_API_PRODUCTS_PER_WORKSPACE, source: "MAX_API_PRODUCTS_PER_WORKSPACE" },
    { name: "body size limit in KiB", re: /(\d+) KiB/gu, actual: MAX_BODY_BYTES / 1024, source: "MAX_BODY_BYTES" },
  ];

  it.each(facts)("$name matches $source everywhere it is quoted", ({ re, actual, source, name }) => {
    let total = 0;
    for (const [file, text] of Object.entries(sources)) {
      for (const m of text.matchAll(re)) {
        total += 1;
        expect(Number(m[1]), `${file} says ${m[1]} for the ${name}, but ${source} is ${actual}. Update the docs.`).toBe(actual);
      }
    }
    expect(total, `No doc quotes the ${name} any more; the drift guard would pass vacuously.`).toBeGreaterThan(0);
  });
});

describe("openapi.json schemas vs the real zod schemas", () => {
  const input = (schema: z.ZodType) =>
    z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as { properties: Record<string, unknown>; required?: string[] };

  it("CreateProductRequest has the fields and required list of createBody", () => {
    const real = input(createBody);
    const doc = spec.components.schemas.CreateProductRequest;
    expect(Object.keys(doc.properties).sort(), `CreateProductRequest fields differ from createBody in src/lib/product-api.ts. ${SPEC_FIX}`).toEqual(
      Object.keys(real.properties).sort(),
    );
    expect([...doc.required].sort(), `CreateProductRequest.required differs from createBody. ${SPEC_FIX}`).toEqual([...(real.required ?? [])].sort());
  });

  it("PatchProductRequest has the fields of patchBody", () => {
    const real = input(patchBody);
    const doc = spec.components.schemas.PatchProductRequest;
    expect(Object.keys(doc.properties).sort(), `PatchProductRequest fields differ from patchBody in src/lib/product-api.ts. ${SPEC_FIX}`).toEqual(
      Object.keys(real.properties).sort(),
    );
    expect(real.required ?? [], "patchBody has required fields; mirror them in PatchProductRequest.required.").toEqual(doc.required ?? []);
  });

  it("domain lists carry the real maxItems", () => {
    const lists: [string, unknown, string][] = [
      ["CreateProductRequest", createBody, "domains"],
      ["PatchProductRequest", patchBody, "addDomains"],
      ["PatchProductRequest", patchBody, "removeDomains"],
    ];
    for (const [name, schema, field] of lists) {
      const real = input(schema as z.ZodType).properties[field] as { maxItems?: number };
      expect(real.maxItems, `${name}.${field} lost its limit in src/lib/product-api.ts; MAX_DOMAINS_PER_LIST is ${MAX_DOMAINS_PER_LIST}.`).toBe(MAX_DOMAINS_PER_LIST);
      expect(spec.components.schemas[name].properties[field].maxItems, `${name}.${field}.maxItems in docs/openapi.json differs from MAX_DOMAINS_PER_LIST (${MAX_DOMAINS_PER_LIST}). ${SPEC_FIX}`).toBe(MAX_DOMAINS_PER_LIST);
    }
  });

  it("Product has exactly the fields serializeProduct returns", () => {
    const product: ProductWithDomains = {
      id: "p",
      workspaceId: "w",
      name: "n",
      primaryColor: "#000000",
      widgetPublicKey: "pk_x",
      formPublicKey: "fk_x",
      inboundEmail: "e@x",
      inboundEmailVerified: null,
      supportEmail: null,
      archivedAt: null,
      diagnosticsEnabledAt: null,
      escalationEnabled: false,
      escalationAfterMinutes: 5,
      createdAt: new Date(0),
      domains: [{ id: "d", domain: "x.example" }],
    } as ProductWithDomains;
    const real = Object.keys(serializeProduct(product)).sort();
    const doc = spec.components.schemas.Product;
    expect(Object.keys(doc.properties).sort(), `Product fields differ from serializeProduct in src/lib/product-api.ts. ${SPEC_FIX}`).toEqual(real);
    expect([...doc.required].sort(), `Product.required differs from serializeProduct. ${SPEC_FIX}`).toEqual(real);
  });
});

/** Every request/response example in the spec and the quickstart, tagged with what it must satisfy. */
type Example = { where: string; kind: "create" | "patch" | "product" | "list" | "whoami" | "error"; value: unknown };

function specExamples(): Example[] {
  const out: Example[] = [];
  for (const { method, path: route, op } of operations) {
    const body = op.requestBody?.content?.["application/json"];
    for (const [name, ex] of Object.entries<Json>(body?.examples ?? {})) {
      out.push({ where: `openapi ${method} ${route} request "${name}"`, kind: method === "POST" ? "create" : "patch", value: ex.value });
    }
    for (const [status, rawResponse] of Object.entries<Json>(op.responses)) {
      const example = resolve(rawResponse).content?.["application/json"]?.example;
      if (example === undefined) continue;
      const kind = Number(status) >= 400 ? "error" : bodyKind(example);
      out.push({ where: `openapi ${method} ${route} ${status} response`, kind, value: example });
    }
  }
  return out;
}

const fences = (language: string): string[] =>
  [...quickstart.matchAll(new RegExp("```" + language + "\\n([\\s\\S]*?)```", "gu"))].map((m) => m[1]);

/** Every ```sh chunk starting at a `curl` line; later shell lines in the same fence ride along on the previous chunk. */
const curlCommands = (): string[] => fences("sh").flatMap((block) => block.split(/\n(?=curl )/u));

function quickstartExamples(): Example[] {
  const out: Example[] = [];
  for (const [i, command] of curlCommands().entries()) {
    const body = /-d '([^']*)'/u.exec(command)?.[1];
    if (body === undefined || command.includes("$SUPPORTSEAL_URL/api/widget/")) continue; // /api/widget/* (config probe, form post) predates this API and has its own error shape
    const method = /-X (\w+)/u.exec(command)?.[1];
    expect(method, `api-quickstart.md curl #${i + 1} sends a body without an explicit -X; add -X POST or -X PATCH so the drift guard picks the right parser.`).toBeDefined();
    out.push({
      where: `quickstart curl #${i + 1} (${method})`,
      kind: method === "POST" ? "create" : "patch",
      value: JSON.parse(body),
    });
  }
  for (const [i, block] of fences("json").entries()) {
    const value = JSON.parse(block) as Record<string, unknown>;
    if ("availability" in value) continue; // GET /api/widget/config: the public widget endpoint, not this API
    out.push({
      where: `quickstart json block #${i + 1}`,
      kind: "error" in value ? "error" : bodyKind(value),
      value,
    });
  }
  return out;
}

const bodyKind = (value: object): Example["kind"] => ("products" in value ? "list" : "workspace" in value ? "whoami" : "product");

const json = (value: unknown, method: string) =>
  new Request("http://localhost/api/products", { method, body: JSON.stringify(value), headers: { "content-type": "application/json" } });

const productShape = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1).max(60),
  archived: z.boolean(),
  primaryColor: z.string().regex(/^#[0-9a-f]{6}$/u),
  domains: z.array(z.string()),
  widgetKey: z.string().regex(/^pk_[A-Za-z0-9_-]+$/u),
  formKey: z.string().regex(/^fk_[A-Za-z0-9_-]+$/u).nullable(),
});
const whoamiShape = z.strictObject({
  workspace: z.strictObject({ id: z.uuid(), name: z.string().min(1) }),
  token: z.strictObject({ id: z.uuid(), name: z.string().min(1), scopes: z.array(z.enum(Object.keys(API_SCOPES) as [ApiScope])), expiresAt: z.iso.datetime().nullable() }),
});
const errorShape = z.strictObject({
  error: z.strictObject({
    code: z.enum(Object.keys(API_ERROR_STATUS) as [keyof typeof API_ERROR_STATUS]),
    message: z.string(),
    details: z.array(z.strictObject({ field: z.string(), message: z.string() })).optional(),
  }),
});

describe.each([
  ["openapi.json", specExamples],
  ["api-quickstart.md", quickstartExamples],
])("examples in %s", (file, collect) => {
  const examples = collect();

  it("has examples to check", () => {
    expect(examples.length, `docs/${file} has no extractable examples; the drift guard would pass vacuously.`).toBeGreaterThan(3);
  });

  it("request bodies pass the real parsers and responses match the real shapes", async () => {
    for (const { where, kind, value } of examples) {
      const hint = `${where} is out of date. Update docs/${file} to match the route that serves it (src/lib/product-api.ts, src/app/api/v1).`;
      if (kind === "create") expect((await parseCreateBody(json(value, "POST"))).ok, hint).toBe(true);
      else if (kind === "patch") expect((await parsePatchBody(json(value, "PATCH"))).ok, hint).toBe(true);
      else if (kind === "product") expect(productShape.safeParse(value).error?.message, hint).toBeUndefined();
      else if (kind === "list") {
        const list = z.strictObject({ products: z.array(productShape) }).safeParse(value);
        expect(list.error?.message, hint).toBeUndefined();
      } else if (kind === "whoami") expect(whoamiShape.safeParse(value).error?.message, hint).toBeUndefined();
      else expect(errorShape.safeParse(value).error?.message, hint).toBeUndefined();
    }
  });
});

describe("api-quickstart.md vs the spec", () => {
  it("only calls documented methods on documented paths", () => {
    const documented = new Set(operations.map(({ method, path: route }) => `${method} ${route}`));
    const called = new Set<string>();
    for (const command of curlCommands()) {
      const url = /"\$SUPPORTSEAL_URL(\/api\/[^"?]*)/u.exec(command)?.[1];
      // The widget config and the live spec itself are public endpoints, not operations of this API.
      if (!url || url.startsWith("/api/widget/") || url === "/api/openapi.json") continue;
      const method = /-X (\w+)/u.exec(command)?.[1] ?? "GET";
      called.add(`${method} ${url.replace("$PRODUCT_ID", "{id}")}`);
    }
    expect(called.size, "No curl calls found in api-quickstart.md.").toBeGreaterThan(0);
    for (const call of called) {
      expect(documented.has(call), `api-quickstart.md calls "${call}", which docs/openapi.json does not document. Fix the quickstart or the spec.`).toBe(true);
    }
    expect(called.size, "The quickstart no longer exercises every documented operation.").toBe(documented.size);
  });

  it("hard-codes no server URL outside the variables block (snippets use WIDGET_SERVER_URL / WIDGET_KEY)", () => {
    const [variables] = fences("sh");
    const rest = quickstart.replace(variables, "");
    expect(
      rest,
      "api-quickstart.md contains the literal hosted URL outside the first variables block. Curl blocks must use $SUPPORTSEAL_URL and HTML/JSX snippets the WIDGET_SERVER_URL / WIDGET_KEY placeholders, so a self-hosted copy-paste cannot ship the wrong server.",
    ).not.toContain("dashboard.supportseal.app");
    for (const block of [...fences("html"), ...fences("jsx")]) {
      expect(block, "Embed snippets must use WIDGET_SERVER_URL/widget.js and data-key=\"WIDGET_KEY\" placeholders.").toMatch(/WIDGET_SERVER_URL\/widget\.js[\s\S]*WIDGET_KEY/u);
    }
  });

  it("points readers at the live spec route", () => {
    expect(quickstart, "api-quickstart.md must link the live spec at $SUPPORTSEAL_URL/api/openapi.json (src/app/api/openapi.json/route.ts).").toContain("$SUPPORTSEAL_URL/api/openapi.json");
  });

  it("uses $SUPPORTSEAL_URL everywhere and never a literal host in curl commands", () => {
    for (const command of curlCommands()) {
      if (!command.startsWith("curl")) continue;
      expect(command, "api-quickstart.md curl examples must use $SUPPORTSEAL_URL, not a literal host.").toMatch(/\$SUPPORTSEAL_URL/u);
    }
  });
});
