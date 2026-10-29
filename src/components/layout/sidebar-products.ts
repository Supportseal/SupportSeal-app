export type SidebarProduct = {
  id: string;
  name: string;
  primaryColor: string;
  openCount: number;
};

/** The filter input appears once the list is longer than this. */
export const PRODUCT_FILTER_THRESHOLD = 8;

/**
 * Products with open conversations first, then A–Z within each group.
 * Runs on the server (shell-data) so the order is fixed before hydration;
 * `localeCompare` with the default locale can differ between Node and a browser.
 */
export function sortSidebarProducts(products: SidebarProduct[]): SidebarProduct[] {
  return [...products].sort((a, b) => {
    const aHasOpen = a.openCount > 0;
    const bHasOpen = b.openCount > 0;
    if (aHasOpen !== bHasOpen) return aHasOpen ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
}

/** Case-insensitive substring match on the product name; blank query keeps all. */
export function filterSidebarProducts(products: SidebarProduct[], query: string): SidebarProduct[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return products;
  return products.filter((product) => product.name.toLowerCase().includes(needle));
}
