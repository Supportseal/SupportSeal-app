"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/cn";

const BASE_TABS = [
  { href: "/settings/team", label: "Team" },
  { href: "/settings/products", label: "Products" },
] as const;

export function SettingsNav({ hosted = false, isAdmin = false }: { hosted?: boolean; isAdmin?: boolean }) {
  const pathname = usePathname();
  const tabs = [
    ...BASE_TABS,
    ...(isAdmin
      ? [
          { href: "/settings/setup", label: "Setup checklist" } as const,
          { href: "/settings/api-tokens", label: "API tokens" } as const,
        ]
      : []),
    ...(hosted ? [{ href: "/settings/billing", label: "Billing" } as const] : []),
  ];

  return (
    <nav className="flex gap-1 overflow-x-auto border-b border-border" aria-label="Settings">
      {tabs.map((tab) => {
        const active = pathname === tab.href || pathname.startsWith(`${tab.href}/`);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            className={cn(
              "-mb-px shrink-0 border-b-2 px-4 py-2.5 text-sm font-medium transition-colors",
              active
                ? "border-primary text-heading"
                : "border-transparent text-body hover:text-heading",
            )}
            aria-current={active ? "page" : undefined}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
