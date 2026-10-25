import Link from "next/link";

import { cn } from "@/lib/cn";
import { listProducts } from "@/lib/products";
import { listSavedReplies, savedReplyProductNames } from "@/lib/saved-replies";
import { requireWorkspace } from "@/lib/workspace";
import { SavedReplyForm } from "./saved-reply-form";
import { SavedRepliesTable } from "./saved-replies-table";

export const metadata = { title: "Saved replies" };

export default async function SavedRepliesPage({
  searchParams,
}: {
  searchParams: Promise<{ scope?: string }>;
}) {
  const [ctx, { scope }] = await Promise.all([
    requireWorkspace("/saved-replies"),
    searchParams,
  ]);
  const [replies, products] = await Promise.all([
    listSavedReplies(ctx.workspace.id),
    listProducts(ctx.workspace.id),
  ]);

  // `scope` is "workspace", a Product id of this Workspace, or anything else = all.
  const activeScope =
    scope === "workspace" || products.some((product) => product.id === scope) ? scope! : "all";
  const visible = replies.filter((reply) =>
    activeScope === "all"
      ? true
      : activeScope === "workspace"
        ? reply.products.length === 0
        : reply.products.some((entry) => entry.productId === activeScope),
  );

  const filters = [
    { id: "all", label: "All", href: "/saved-replies" },
    { id: "workspace", label: "Workspace-wide", href: "/saved-replies?scope=workspace" },
    ...products.map((product) => ({
      id: product.id,
      label: product.name,
      href: `/saved-replies?scope=${product.id}`,
    })),
  ];

  return (
    <div className="mx-auto w-full max-w-4xl space-y-8">
      <header>
        <h1 className="text-2xl font-semibold text-heading">Saved replies</h1>
        <p className="mt-1 text-muted">
          Reusable answers the whole team inserts while replying — everywhere, or in specific
          Products&apos; conversations. Admins manage them here.
        </p>
      </header>

      {replies.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-8 text-center">
          <p className="font-medium text-heading">No saved replies yet</p>
          <p className="mt-1 text-sm text-muted">
            Add your first one below — good candidates: refund policy, billing cycle, API status.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {products.length > 0 ? (
            <nav aria-label="Filter by scope" className="flex flex-wrap gap-1.5">
              {filters.map((filter) => (
                <Link
                  key={filter.id}
                  href={filter.href}
                  aria-current={filter.id === activeScope ? "page" : undefined}
                  className={cn(
                    "rounded-full border px-3 py-1 text-sm",
                    filter.id === activeScope
                      ? "border-primary bg-primary-label font-medium text-primary"
                      : "border-border text-body hover:bg-hover",
                  )}
                >
                  {filter.label}
                </Link>
              ))}
            </nav>
          ) : null}
          {visible.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted">
              No saved replies in this scope yet.
            </p>
          ) : (
            <SavedRepliesTable
              replies={visible.map((reply) => ({
                id: reply.id,
                name: reply.name,
                body: reply.body,
                productNames: savedReplyProductNames(reply),
              }))}
              isAdmin={ctx.role === "ADMIN"}
            />
          )}
        </div>
      )}

      {ctx.role === "ADMIN" ? (
        <SavedReplyForm
          products={products
            .filter((product) => product.archivedAt === null)
            .map((product) => ({ id: product.id, name: product.name }))}
        />
      ) : null}
    </div>
  );
}
