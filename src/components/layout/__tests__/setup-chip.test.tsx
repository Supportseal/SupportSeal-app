import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { SetupChip, type SetupChecklist } from "@/components/layout/setup-chip";

const noop = () => undefined;

function checklist(done: string[]): SetupChecklist {
  const items = [
    { id: "install", title: "Install the widget", required: true },
    { id: "test-message", title: "Send a test message", required: true },
    { id: "reply", title: "Reply from your inbox", required: false },
    { id: "invite", title: "Invite a teammate", required: false },
  ].map((item) => ({ ...item, done: done.includes(item.id) }));
  return { items, doneCount: items.filter((i) => i.done).length, total: items.length };
}

describe("SetupChip", () => {
  it("opens the checklist view, not the first-run wizard", () => {
    const html = renderToStaticMarkup(<SetupChip checklist={checklist([])} collapsed={false} onNavigate={noop} />);
    expect(html).toContain('href="/settings/setup"');
    expect(html).not.toContain("/onboarding");
    expect(html).toContain("Setup 0/4");
  });

  it("names the next outstanding step in the tooltip and aria-label", () => {
    const html = renderToStaticMarkup(
      <SetupChip checklist={checklist(["install"])} collapsed={false} onNavigate={noop} />,
    );
    expect(html).toContain('aria-label="Setup 1 of 4 complete. Next: Send a test message"');
    expect(html).toContain('title="Next: Send a test message"');
  });

  it("stays visible while a required step is open", () => {
    const html = renderToStaticMarkup(
      <SetupChip checklist={checklist(["test-message"])} collapsed={false} onNavigate={noop} />,
    );
    expect(html).toContain("Setup 1/4");
    expect(html).toContain("Next: Install the widget");
  });

  it("hides once the required steps are done, even with optional steps open", () => {
    const html = renderToStaticMarkup(
      <SetupChip checklist={checklist(["install", "test-message"])} collapsed={false} onNavigate={noop} />,
    );
    expect(html).toBe("");
  });
});
