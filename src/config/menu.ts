import type { TablerIcon } from "@tabler/icons-react";
import { IconBook, IconInbox, IconMessage2, IconSettings, IconRocket } from "@tabler/icons-react";

export type MenuItem = {
  id: string;
  label: string;
  href?: string;
  icon?: TablerIcon;
  children?: MenuItem[];
};

export type MenuSection = {
  id: string;
  label?: string;
  items: MenuItem[];
};

export function menuSections(
  role: "ADMIN" | "AGENT",
  options: { hasProducts?: boolean } = {},
): MenuSection[] {
  const sections: MenuSection[] = [
    {
      id: "support",
      items: [
        { id: "inbox", label: "Inbox", href: "/inbox", icon: IconInbox },
        { id: "saved-replies", label: "Saved replies", href: "/saved-replies", icon: IconMessage2 },
      ],
    },
  ];
  if (role === "ADMIN") {
    const settingsItems: MenuItem[] = [
      { id: "products", label: "Products", href: "/settings/products", icon: IconSettings },
      { id: "team", label: "Team", href: "/settings/team", icon: IconSettings },
    ];
    // "Get started" only guides the very first Product; once one exists the
    // wizard has served its purpose and the entry only re-opens a finished
    // flow (docs/design/onboarding.md).
    if (!options.hasProducts) {
      settingsItems.push({ id: "onboarding", label: "Get started", href: "/onboarding", icon: IconRocket });
    }
    sections.push({ id: "settings", label: "Settings", items: settingsItems });
  }
  sections.push({
    id: "help",
    items: [{ id: "docs", label: "Docs", href: "/docs", icon: IconBook }],
  });
  return sections;
}

export const searchablePages = [
  { label: "Inbox", href: "/inbox" },
  { label: "Saved replies", href: "/saved-replies" },
  { label: "Products", href: "/settings/products" },
  { label: "Team", href: "/settings/team" },
  { label: "Docs", href: "/docs" },
];
