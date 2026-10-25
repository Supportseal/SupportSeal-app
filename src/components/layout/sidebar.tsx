"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect } from "react";
import { IconCircle, IconPlus } from "@tabler/icons-react";

import { cn } from "@/lib/cn";
import { menuSections } from "@/config/menu";
import { useLayout } from "@/components/layout/layout-provider";
import { Logo } from "@/components/layout/logo";
import { ProductMark } from "@/components/product-identity";
import { SetupChip, type SetupChecklist } from "@/components/layout/setup-chip";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export type SidebarProduct = {
  id: string;
  name: string;
  primaryColor: string;
  openCount: number;
};

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
  const pathname = usePathname();
  const currentProduct = pathname.startsWith("/inbox?product=") ? null : null;
  void currentProduct;

  const items = (
    <ul className="space-y-0.5">
      {products.slice(0, 8).map((product) => (
        <li key={product.id}>
          <Link
            href={`/inbox?product=${product.id}`}
            onClick={onNavigate}
            aria-label={`${product.name}${product.openCount > 0 ? `, ${product.openCount} open` : ""}`}
            className="flex items-center gap-2.5 rounded-md px-3 py-2 text-[0.9375rem] text-body transition-colors hover:bg-hover hover:text-heading"
          >
            <ProductMark name={product.name} color={product.primaryColor} size="sm" />
            <span className={cn("truncate", collapsed && "lg:hidden")}>{product.name}</span>
            {product.openCount > 0 ? (
              <span className={cn("ms-auto text-sm font-semibold text-muted", collapsed && "lg:hidden")}>
                {product.openCount}
              </span>
            ) : null}
          </Link>
        </li>
      ))}
      {isAdmin ? (
        <li>
          <Link
            href="/settings/products"
            onClick={onNavigate}
            className="flex items-center gap-2.5 rounded-md px-3 py-2 text-[0.9375rem] text-body transition-colors hover:bg-hover hover:text-heading"
          >
            <span className="flex size-5 items-center justify-center text-primary">
              <IconPlus className="size-4" />
            </span>
            <span className="truncate">Add Product</span>
          </Link>
        </li>
      ) : null}
    </ul>
  );

  if (collapsed) {
    return (
      <nav aria-label="Products" className="hidden lg:block">
        {items}
      </nav>
    );
  }
  return <nav aria-label="Products">{items}</nav>;
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
        <div className="flex-1 overflow-y-auto">
          {checklist && role === "ADMIN" ? (
            <SetupChip checklist={checklist} collapsed={collapsed} onNavigate={onClose} />
          ) : null}
          <div className={cn("px-2 pb-2", collapsed && "lg:px-1.5")}>
            <ProductList
              products={products}
              collapsed={collapsed}
              isAdmin={role === "ADMIN"}
              onNavigate={onClose}
            />
          </div>
          {sections.map((section) => (
            <div key={section.id} className="px-2 pb-2">
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
