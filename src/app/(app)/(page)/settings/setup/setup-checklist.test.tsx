import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { SetupChecklistView } from "./setup-checklist";

const items = [
  { id: "install", title: "Install the widget", hint: "Copy the snippet.", actionLabel: "Show snippet", actionHref: "/settings/products", required: true, done: true },
  { id: "reply", title: "Reply from your inbox", hint: "Answer the test chat.", actionLabel: "Open inbox", actionHref: "/inbox", required: false, done: false },
  { id: "invite", title: "Invite a teammate", hint: "Bring an agent in.", actionLabel: "Settings → Team", actionHref: "/settings/team", required: false, done: false },
];

describe("SetupChecklistView", () => {
  it("lists each remaining item with its hint and action link", () => {
    const html = renderToStaticMarkup(
      <SetupChecklistView checklist={{ items, doneCount: 1, total: 3 }} />,
    );
    expect(html).toContain("1 of 3 complete");
    expect(html).toContain("Answer the test chat.");
    expect(html).toContain('href="/inbox"');
    expect(html).toContain("Open inbox");
    expect(html).toContain('href="/settings/team"');
  });

  it("collapses completed items to text with no action link", () => {
    const html = renderToStaticMarkup(
      <SetupChecklistView checklist={{ items, doneCount: 1, total: 3 }} />,
    );
    expect(html).toContain("Install the widget");
    expect(html).toContain("completed");
    expect(html).not.toContain("Show snippet");
  });

  it("shows the success state when everything is done", () => {
    const all = items.map((item) => ({ ...item, done: true }));
    const html = renderToStaticMarkup(
      <SetupChecklistView checklist={{ items: all, doneCount: 3, total: 3 }} />,
    );
    expect(html).toContain("You&#x27;re set up");
  });
});
