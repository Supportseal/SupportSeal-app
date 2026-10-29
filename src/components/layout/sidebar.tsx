"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { IconCircle, IconPlus } from "@tabler/icons-react";

import { cn } from "@/lib/cn";
import { menuSections } from "@/config/menu";
import { useLayout } from "@/components/layout/layout-provider";
import { Logo } from "@/components/layout/logo";
import { ProductMark } from "@/components/product-identity";
import { SetupChip, type SetupChecklist } from "@/components/layout/setup-chip";
import { Input } from "@/components/ui/input";
import {
  filterSidebarProducts,
  PRODUCT_FILTER_THRESHOLD,
  type SidebarProduct,
} from "@/components/layout/sidebar-products";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

function isActive(pathname: string, href?: string) {
  if (!href) return false;
  return pathname === href || pathname.startsWith(`${href}/`);
}

function NavLink({
  href,
  label,
  icon: Icon,
  collapsed,
  onNavigate,
}: {
  href: string;
  label: string;
  icon?: typeof IconCircle;
  collapsed: boolean;
  onNavigate: () => void;
}) {
  const pathname = usePathname();
  const active = isActive(pathname, href);

  const content = (
    <Link
      href={href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex items-center gap-2.5 rounded-md px-3 py-2 text-[0.9375rem] transition-colors",
        active
          ? "bg-primary-label text-primary"
          : "text-body hover:bg-hover hover:text-heading",
        collapsed && "lg:justify-center lg:px-0",
      )}
    >
      {Icon ? <Icon className="size-[22px] shrink-0" stroke={1.6} /> : null}
      <span className={cn("truncate", collapsed && "lg:hidden")}>{label}</span>
    </Link>
  );

  if (collapsed) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{content}</TooltipTrigger>
        <TooltipContent side="right">{label}</TooltipContent>
      </Tooltip>
    );
  }
  return content;
}

function ProductList({
  products,
  collapsed,
  isAdmin,
  onNavigate,
}: {
  products: SidebarProduct[];
  collapsed: boolean;
  isAdmin: boolean;
  onNavigate: () => void;
}) {
  const [query, setQuery] = useState("");
  const showFilter = products.length > PRODUCT_FILTER_THRESHOLD;
  // Drop a stale query when the input that controls it goes away, so the list
  // never stays filtered with no way to clear it.
  const filterKey = `${showFilter}:${collapsed}`;
  const [seenFilterKey, setSeenFilterKey] = useState(filterKey);
  if (seenFilterKey !== filterKey) {
    setSeenFilterKey(filterKey);
    setQuery("");
  }
  const activeQuery = showFilter ? query : "";
  const visible = useMemo(() => filterSidebarProducts(products, activeQuery), [products, activeQuery]);

  return (
    <nav aria-label="Products" className="flex min-h-0 shrink flex-col">
      {showFilter ? (
        <div className={cn("px-1 pb-1.5", collapsed && "lg:hidden")}>
          <Input
            type="search"
            size="sm"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter products"
            aria-label="Filter products"
          />
        </div>
      ) : null}
      <ul
        className={cn(
          "space-y-0.5 overflow-y-auto overscroll-contain [scrollbar-gutter:stable]",
          // Long lists may shrink to a 96px scroll window; short ones keep their content height as the
          // floor (never squeezed to zero on a short viewport, no dead space; an empty list collapses).
          visible.length > 3 ? "min-h-24" : "min-h-fit",
        )}
      >
        {visible.map((product) => (
          <li key={product.id}>
            <Link
              href={`/inbox?product=${product.id}`}
              onClick={onNavigate}
              aria-label={`${product.name}${product.openCount > 0 ? `, ${product.openCount} open` : ""}`}
              className="flex items-center gap-2.5 rounded-md px-3 py-2 text-[0.9375rem] text-body transition-colors hover:bg-hover hover:text-heading"
            >
              <ProductMark name={product.name} color={product.primaryColor} size="sm" />
              <span className={cn("min-w-0 truncate", collapsed && "lg:hidden")}>{product.name}</span>
              {product.openCount > 0 ? (
                <span
                  className={cn("ms-auto shrink-0 ps-1 text-sm font-semibold text-muted", collapsed && "lg:hidden")}
                >
                  {product.openCount}
                </span>
              ) : null}
            </Link>
          </li>
        ))}
        {visible.length === 0 && activeQuery.trim() ? (
          <li className={cn("px-3 py-2 text-sm text-muted", collapsed && "lg:hidden")}>No matching products</li>
        ) : null}
      </ul>
      {isAdmin ? (
        <Link
          href="/settings/products"
          onClick={onNavigate}
          className="mt-0.5 flex items-center gap-2.5 rounded-md px-3 py-2 text-[0.9375rem] text-body transition-colors hover:bg-hover hover:text-heading"
        >
          <span className="flex size-5 items-center justify-center text-primary">
            <IconPlus className="size-4" />
          </span>
          <span className={cn("truncate", collapsed && "lg:hidden")}>Add Product</span>
        </Link>
      ) : null}
    </nav>
  );
}

export function Sidebar({
  products,
  role,
  mobileOpen,
  onClose,
  checklist,
}: {
  products: SidebarProduct[];
  role: "ADMIN" | "AGENT";
  mobileOpen: boolean;
  onClose: () => void;
  checklist?: SetupChecklist | null;
}) {
  const { collapsed } = useLayout();
  const pathname = usePathname();
  const sections = menuSections(role, { hasProducts: products.length > 0 });

  useEffect(() => {
    onClose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  return (
    <>
      {mobileOpen ? (
        <div className="fixed inset-0 z-40 bg-black/40 lg:hidden" onClick={onClose} aria-hidden />
      ) : null}
      <aside
        className={cn(
          "fixed inset-y-0 start-0 z-40 flex w-sidebar flex-col border-e border-border bg-surface transition-[margin] duration-200",
          collapsed && "lg:w-sidebar-collapsed",
          mobileOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0",
        )}
      >
        <div className={cn("flex h-header items-center px-4", collapsed && "lg:justify-center lg:px-0")}>
          <Logo collapsed={collapsed} />
        </div>
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          {checklist && role === "ADMIN" ? (
            <SetupChip checklist={checklist} collapsed={collapsed} onNavigate={onClose} />
          ) : null}
          <div className={cn("flex min-h-0 shrink flex-col px-2 pb-2", collapsed && "lg:px-1.5")}>
            <ProductList
              products={products}
              collapsed={collapsed}
              isAdmin={role === "ADMIN"}
              onNavigate={onClose}
            />
          </div>
          {sections.map((section) => (
            <div key={section.id} className="shrink-0 px-2 pb-2">
              {section.label ? (
                <p
                  className={cn(
                    "px-3 pt-3 pb-1 text-[0.6875rem] font-medium uppercase tracking-[0.08em] text-muted",
                    collapsed && "lg:hidden",
                  )}
                >
                  {section.label}
                </p>
              ) : null}
              <ul className="space-y-0.5">
                {section.items.map((item) => (
                  <li key={item.id}>
                    <NavLink
                      href={item.href ?? "#"}
                      label={item.label}
                      icon={item.icon}
                      collapsed={collapsed}
                      onNavigate={onClose}
                    />
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </aside>
    </>
  );
}
