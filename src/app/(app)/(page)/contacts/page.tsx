import Link from "next/link";
import { format } from "date-fns";

import { Button } from "@/components/ui/button";
import { listContactsPage, MAX_CONTACT_SEARCH_LENGTH } from "@/lib/contacts";
import { requireWorkspace } from "@/lib/workspace";

export const metadata = { title: "Contacts" };

function pageHref(q: string, page: number) {
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (page > 1) params.set("page", String(page));
  const query = params.toString();
  return query ? `/contacts?${query}` : "/contacts";
}

export default async function ContactsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; page?: string }>;
}) {
  const [ctx, params] = await Promise.all([requireWorkspace("/contacts"), searchParams]);
  const q = (typeof params.q === "string" ? params.q : "").trim().slice(0, MAX_CONTACT_SEARCH_LENGTH);
  const requestedPage = Number.parseInt(typeof params.page === "string" ? params.page : "1", 10);
  const { items, page, hasMore } = await listContactsPage({
    workspaceId: ctx.workspace.id,
    q,
    page: Number.isFinite(requestedPage) ? requestedPage : 1,
  });

  return (
    <div className="mx-auto w-full max-w-4xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold text-heading">Contacts</h1>
        <p className="mt-1 text-muted">
          Everyone who has reached you by chat, email or contact form, newest first. Open a contact to
          see all of their conversations across your Products.
        </p>
      </header>

      <form action="/contacts" role="search" className="flex gap-2">
        <input
          type="search"
          name="q"
          defaultValue={q}
          maxLength={MAX_CONTACT_SEARCH_LENGTH}
          placeholder="Search by name or email"
          aria-label="Search contacts"
          className="h-9 min-w-0 flex-1 rounded-md border border-border-strong bg-surface px-3 text-sm"
        />
        <Button type="submit" size="sm" variant="label" color="secondary" className="h-9">
          Search
        </Button>
      </form>

      {items.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-8 text-center">
          <p className="font-medium text-heading">{q ? "No contacts match" : "No contacts yet"}</p>
          <p className="mt-1 text-sm text-muted">
            {q
              ? "Try part of a name or an email address."
              : "A contact appears here once a customer leaves a name or email in chat, sends an email or uses your contact form."}
          </p>
        </div>
      ) : (
        <div className="rounded-lg border border-border">
          <table className="w-full text-sm max-sm:block">
            <thead className="max-sm:hidden">
              <tr className="border-b border-border text-left text-muted">
                <th className="px-4 py-3 font-medium">Name</th>
                <th className="px-4 py-3 font-medium">Email</th>
                <th className="px-4 py-3 text-right font-medium">Conversations</th>
                <th className="px-4 py-3 text-right font-medium">Last activity</th>
              </tr>
            </thead>
            <tbody className="max-sm:block">
              {items.map((contact) => (
                <tr
                  key={contact.id}
                  className="relative border-b border-border last:border-0 hover:bg-hover max-sm:block max-sm:space-y-0.5 max-sm:px-4 max-sm:py-3"
                >
                  <td className="px-4 py-3 font-medium text-heading max-sm:block max-sm:p-0">
                    {/* The stretched link makes the whole row the target. */}
                    <Link
                      href={`/contacts/${contact.id}`}
                      className="after:absolute after:inset-0 [overflow-wrap:anywhere]"
                    >
                      {contact.name ?? <span className="font-normal text-muted">No name</span>}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-body max-sm:block max-sm:p-0 [overflow-wrap:anywhere]">
                    {contact.email ?? <span className="text-muted">No email</span>}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-body max-sm:inline max-sm:p-0 max-sm:text-xs max-sm:text-muted">
                    <span className="sm:hidden">Conversations: </span>
                    {contact.conversationCount}
                  </td>
                  <td className="px-4 py-3 text-right text-body max-sm:inline max-sm:p-0 max-sm:text-xs max-sm:text-muted">
                    <span className="sm:hidden"> · Last activity: </span>
                    {contact.lastMessageAt ? format(new Date(contact.lastMessageAt), "d MMM yyyy") : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {page > 1 || hasMore ? (
        <nav aria-label="Pagination" className="flex items-center justify-between text-sm">
          {page > 1 ? (
            <Link href={pageHref(q, page - 1)} className="text-primary hover:underline">
              ← Newer
            </Link>
          ) : (
            <span />
          )}
          <span className="text-muted">Page {page}</span>
          {hasMore ? (
            <Link href={pageHref(q, page + 1)} className="text-primary hover:underline">
              Older →
            </Link>
          ) : (
            <span />
          )}
        </nav>
      ) : null}
    </div>
  );
}
