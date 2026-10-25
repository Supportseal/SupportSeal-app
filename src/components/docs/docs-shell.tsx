import Link from "next/link";
import type { ReactNode } from "react";

import { Logo } from "@/components/layout/logo";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { cn } from "@/lib/cn";
import { DOC_PAGES, docHref, docMarkdownHref } from "@/lib/docs/pages";

function Nav({ current }: { current: string }) {
  return (
    <nav aria-label="Docs" className="flex flex-col gap-0.5">
      {DOC_PAGES.map((page) => {
        const active = page.slug === current;
        return (
          <Link
            key={page.slug}
            href={docHref(page.slug)}
            aria-current={active ? "page" : undefined}
            className={cn(
              "rounded-md px-3 py-2 text-[0.9375rem] transition-colors",
              active ? "bg-primary-label font-semibold text-primary" : "text-body hover:bg-hover hover:text-heading",
            )}
          >
            {page.title}
          </Link>
        );
      })}
    </nav>
  );
}

/** Public docs frame: top bar, sidebar (a disclosure menu on phones), prev/next. */
export function DocsShell({ current, children }: { current: string; children: ReactNode }) {
  const index = DOC_PAGES.findIndex((p) => p.slug === current);
  const prev = DOC_PAGES[index - 1];
  const next = DOC_PAGES[index + 1];
  return (
    <div className="min-h-screen bg-body-bg">
      <header className="sticky top-0 z-30 border-b border-border bg-surface">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-3 px-4 sm:px-6">
          <Logo href="/docs" className="min-w-0" />
          <span className="hidden text-sm font-medium text-muted sm:inline">Docs</span>
          <div className="ms-auto flex items-center gap-2">
            <Link href="/inbox" prefetch={false} className="rounded-md px-3 py-2 text-sm font-medium text-primary hover:bg-hover">
              Open app
            </Link>
            <ThemeToggle />
          </div>
        </div>
      </header>
      <div className="mx-auto flex max-w-6xl gap-10 px-4 py-6 sm:px-6 lg:py-10">
        <aside className="hidden w-56 shrink-0 lg:block">
          <div className="sticky top-24">
            <Nav current={current} />
          </div>
        </aside>
        <div className="min-w-0 flex-1">
          <details className="group mb-6 rounded-lg border border-border bg-surface lg:hidden">
            <summary className="cursor-pointer list-none px-4 py-3 text-sm font-semibold text-heading">
              Docs menu
              <span className="ms-2 text-muted group-open:hidden">▾</span>
              <span className="ms-2 hidden text-muted group-open:inline">▴</span>
            </summary>
            <div className="border-t border-border p-2">
              <Nav current={current} />
            </div>
          </details>
          <main className="max-w-3xl space-y-4 text-[0.9375rem] leading-7 text-body">
            {children}
            <p className="pt-4 text-sm text-muted">
              <a href={docMarkdownHref(current)} className="underline underline-offset-2">
                View as markdown
              </a>
            </p>
            <div className="flex flex-wrap justify-between gap-3 border-t border-border pt-6">
              {prev ? <Link href={docHref(prev.slug)} className="text-primary hover:underline">← {prev.title}</Link> : <span />}
              {next ? <Link href={docHref(next.slug)} className="text-primary hover:underline">{next.title} →</Link> : null}
            </div>
          </main>
        </div>
      </div>
    </div>
  );
}
