import { NextResponse } from "next/server";

import { authorizeAdminApi } from "@/lib/admin-api";
import { guardApi, PRIVATE_NO_STORE } from "@/lib/api-errors";
import { parseCreateBody, productFailure, productResponse, serializeProduct, siblingsOf } from "@/lib/product-api";
import { createProduct, listProducts, MAX_API_PRODUCTS_PER_WORKSPACE } from "@/lib/products";

export const dynamic = "force-dynamic";

/**
 * Workspace admin API (issue #170): list the Workspace's Products with their
 * public widget keys, so installs and integrations need no dashboard login.
 * Scoped through the caller's own membership or API token; see docs/widget-integration.md.
 */
export function GET(request: Request) {
  return guardApi(async () => {
    const auth = await authorizeAdminApi(request, "products:read");
    if (!auth.ok) return auth.response;

    const products = await listProducts(auth.ctx.workspaceId);
    return NextResponse.json({ products: products.map(serializeProduct) }, { headers: PRIVATE_NO_STORE });
  });
}

/**
 * Create a Product in the token's own Workspace (issue #187). Token-only:
 * `authorizeAdminApi` refuses session cookies for `products:write`. The body is
 * `{ name, primaryColor?, supportEmail?, domains?, includeSiblings? }`; the core is the
 * dashboard's `createProduct`, so validation, normalisation and key generation
 * are identical. Unlike the dashboard it refuses a create at
 * MAX_API_PRODUCTS_PER_WORKSPACE (`409 product_limit_reached`). See docs/add-product.md.
 */
export function POST(request: Request) {
  return guardApi(async () => {
    const auth = await authorizeAdminApi(request, "products:write");
    if (!auth.ok) return auth.response;

    const parsed = await parseCreateBody(request);
    if (!parsed.ok) return parsed.response;
    const { name, primaryColor, supportEmail, domains, includeSiblings } = parsed.body;

    const result = await createProduct({
      ctx: { workspace: { id: auth.ctx.workspaceId }, role: "ADMIN" },
      name,
      primaryColor,
      supportEmail,
      domains,
      includeSiblings: includeSiblings ? siblingsOf(domains ?? []) : undefined,
      maxProducts: MAX_API_PRODUCTS_PER_WORKSPACE,
    });
    if (!result.ok) return productFailure(result);
    return productResponse(result.product, 201, { location: `/api/products/${result.product.id}` });
  });
}
