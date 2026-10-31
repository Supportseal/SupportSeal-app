import { NextResponse } from "next/server";
import { z } from "zod";

import { apiError, PRIVATE_NO_STORE, type ApiErrorDetail } from "@/lib/api-errors";
import { normalizeDomain, wwwSibling } from "@/lib/domain";
import { expandHexColor } from "@/lib/hex-color";
import type { ProductFailure, ProductWithDomains } from "@/lib/products";

/** The Product JSON the Workspace API returns from every endpoint. */
export function serializeProduct(product: ProductWithDomains) {
  return {
    id: product.id,
    name: product.name,
    archived: product.archivedAt !== null,
    primaryColor: product.primaryColor,
    supportEmail: product.supportEmail,
    domains: product.domains.map((d) => d.domain),
    widgetKey: product.widgetPublicKey,
    formKey: product.formPublicKey,
  };
}

export function productResponse(
  product: ProductWithDomains,
  status = 200,
  headers: Record<string, string> = {},
) {
  return NextResponse.json(serializeProduct(product), {
    status,
    headers: { ...PRIVATE_NO_STORE, ...headers },
  });
}

/** Request bodies are tiny; refuse anything larger before parsing. */
export const MAX_BODY_BYTES = 64 * 1024;

// Same #RGB shorthand the dashboard's create form accepts; anything else is validated by the core.
const colour = z.string().transform((value) => expandHexColor(value) ?? value);
export const MAX_DOMAINS_PER_LIST = 100;
const domainList = z
  .array(z.string())
  .max(MAX_DOMAINS_PER_LIST, { message: `At most ${MAX_DOMAINS_PER_LIST} domains per list.` });

// Format and own-address rules are the dashboard's (`normalizeSupportEmail`, run by the core); blank or null means none.
const supportEmail = z.string().nullable();

export const createBody = z.strictObject({
  name: z.string(),
  primaryColor: colour.optional(),
  supportEmail: supportEmail.optional(),
  domains: domainList.optional(),
  includeSiblings: z.boolean().optional(),
});

export const patchBody = z
  .strictObject({
    name: z.string().optional(),
    primaryColor: colour.optional(),
    supportEmail: supportEmail.optional(),
    addDomains: domainList.optional(),
    removeDomains: domainList.optional(),
    includeSiblings: z.boolean().optional(),
  })
  .refine(
    (body) =>
      body.name !== undefined ||
      body.primaryColor !== undefined ||
      body.supportEmail !== undefined ||
      Boolean(body.addDomains?.length) ||
      Boolean(body.removeDomains?.length),
    { message: "Send at least one of: name, primaryColor, supportEmail, addDomains (non-empty), removeDomains (non-empty)." },
  );

export type ParsedBody<T> = { ok: true; body: T } | { ok: false; response: NextResponse };

const bodyTooLarge = () =>
  apiError("invalid_request", `Request body must be at most ${MAX_BODY_BYTES} bytes.`);

/** Read the body without buffering past the cap, whether or not Content-Length was sent. */
export async function readBodyText(request: Request): Promise<string | null> {
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (let next = await reader.read(); !next.done; next = await reader.read()) {
    size += next.value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(next.value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readJson(request: Request): Promise<ParsedBody<unknown>> {
  const text = await readBodyText(request);
  if (text === null) return { ok: false, response: bodyTooLarge() };
  try {
    return { ok: true, body: JSON.parse(text) };
  } catch {
    return { ok: false, response: apiError("invalid_request", "Request body must be valid JSON.") };
  }
}

export async function parseBody<S extends z.ZodType>(request: Request, schema: S): Promise<ParsedBody<z.output<S>>> {
  const json = await readJson(request);
  if (!json.ok) return json;
  const parsed = schema.safeParse(json.body);
  if (parsed.success) return { ok: true, body: parsed.data };
  const details: ApiErrorDetail[] = parsed.error.issues.flatMap((issue) =>
    issue.code === "unrecognized_keys"
      ? issue.keys.map((key) => ({ field: key, message: "Unknown field." }))
      : [{ field: issue.path.join(".") || "body", message: issue.message }],
  );
  return { ok: false, response: apiError("invalid_request", "The request body is invalid.", { details }) };
}

export const parseCreateBody = (request: Request) => parseBody(request, createBody);
export const parsePatchBody = (request: Request) => parseBody(request, patchBody);

/** The apex/`www.` counterparts of the submitted domains: the dashboard form's per-domain opt-ins, all ticked. */
export function siblingsOf(domains: readonly string[]): string[] {
  return domains.flatMap((raw) => {
    const domain = normalizeDomain(raw);
    const sibling = domain ? wwwSibling(domain) : null;
    return sibling ? [sibling] : [];
  });
}

const FAILURE_CODE = {
  invalid: "invalid_request",
  not_found: "not_found",
  conflict: "conflict",
  forbidden: "forbidden",
  limit_reached: "product_limit_reached",
  internal: "internal_error",
} as const;

/** Map a Product-core failure onto the envelope. Messages are the dashboard's own. */
export function productFailure(failure: ProductFailure): NextResponse {
  const details = failure.field ? [{ field: failure.field, message: failure.error }] : undefined;
  return apiError(FAILURE_CODE[failure.kind], failure.error, { details });
}
