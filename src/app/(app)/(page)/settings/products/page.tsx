import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { listProducts, type ProductWithDomains } from "@/lib/products";
import { requireWorkspace } from "@/lib/workspace";
import { CreateProductForm } from "./create-product-form";

export const metadata = { title: "Products" };

export default async function ProductsPage() {
  const ctx = await requireWorkspace("/settings/products");
  const products = await listProducts(ctx.workspace.id);

  return (
    <div className="space-y-8">
      <header>
        <h2 className="text-lg font-medium text-heading">Products</h2>
        <p className="mt-1 text-muted">
          Each Product keeps its own identity, domains, widget and support email — all flowing into
          one inbox.
        </p>
      </header>

      <section className="space-y-4">
        {products.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border p-8 text-center">
            <p className="text-heading font-medium">No Products yet</p>
            <p className="mt-1 text-sm text-muted">
              Add your first product below to get its chat widget and support email.
            </p>
          </div>
        ) : (
          <div className="rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-muted">
                  <th className="px-4 py-3 font-medium">Product</th>
                  <th className="hidden px-4 py-3 font-medium sm:table-cell">Domains</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {products.map((product) => (
                  <ProductRow key={product.id} product={product} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {ctx.role === "ADMIN" ? <CreateProductForm /> : null}
    </div>
  );
}

function ProductRow({ product }: { product: ProductWithDomains }) {
  return (
    <tr className="border-b border-border last:border-0">
      <td className="px-4 py-3">
        <Link href={`/settings/products/${product.id}`} className="flex items-center gap-2.5">
          <span
            className="inline-block size-3.5 rounded-full"
            style={{ backgroundColor: product.primaryColor }}
            aria-hidden
          />
          <span className="font-medium text-heading hover:text-primary">{product.name}</span>
        </Link>
      </td>
      <td className="hidden px-4 py-3 text-body sm:table-cell">
        {product.domains.length === 0 ? (
          <span className="text-muted">—</span>
        ) : (
          product.domains.map((d) => d.domain).join(", ")
        )}
      </td>
      <td className="px-4 py-3">
        {product.archivedAt ? (
          <Badge variant="light" color="secondary">
            Archived
          </Badge>
        ) : (
          <Badge variant="light" color="success">
            Active
          </Badge>
        )}
      </td>
    </tr>
  );
}
