import { expect, test } from "@playwright/test";

import { loadFixtures, signIn } from "./helpers";

/**
 * Regression (issue #59): the app-shell top bar used to render a permanently
 * disabled "Search conversations…" button (accessible name "Search (not
 * wired yet)") on every authenticated page. Issue #59 option 2 removed the
 * dead control until global search lands (docs/design/app-shell.md) — the
 * inbox list-pane searchbox is the single way to search conversations, so it
 * must stay the only search UI and stay enabled.
 */
test.describe("top-bar search", () => {
  test("header has no placeholder search control; the inbox searchbox is the one enabled search", async ({ page }) => {
    const fixtures = loadFixtures();
    await signIn(page, fixtures.beta.owner.email, fixtures.beta.owner.password);

    // The shell header is the only banner; page titles and the thread
    // header are nested <header> elements inside <main>.
    const header = page.getByRole("banner");

    async function expectNoTopBarSearch() {
      // Guard against vacuous passes: the banner itself must exist first.
      await expect(header).toHaveCount(1);
      await expect(header.getByText("Search conversations…")).toHaveCount(0);
      await expect(header.getByLabel(/search/iu)).toHaveCount(0);
      // No permanently disabled control may ship in the top bar (the original
      // bug); the banner must not carry disabled buttons.
      await expect(header.getByRole("button", { disabled: true })).toHaveCount(0);
    }

    // signIn already lands on /inbox.
    const listSearch = page.getByRole("searchbox", { name: "Search conversations" });
    await expect(listSearch).toBeVisible();
    await expect(listSearch).toBeEnabled();
    await expect(page.getByRole("searchbox")).toHaveCount(1);
    await expectNoTopBarSearch();

    // Away from the inbox the list searchbox is gone and the top bar has none:
    // the inbox searchbox is the only conversation search in the product.
    await page.goto("/saved-replies");
    await expect(page.getByRole("heading", { name: "Saved replies" })).toBeVisible();
    await expect(page.getByRole("searchbox")).toHaveCount(0);
    await expectNoTopBarSearch();
  });
});
