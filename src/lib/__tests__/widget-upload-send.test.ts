import { runInNewContext } from "node:vm";
import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/widget", () => ({
  loadWidgetProduct: async () => null,
  serviceOriginFrom: () => "http://localhost:3000",
}));
import { GET as panelHtml } from "@/app/api/widget/panel/route";

/** Source of one top-level function of the served panel script. */
async function panelFunction(name: string) {
  const html = await (
    await panelHtml(new NextRequest("http://localhost:3000/widget?key=pk_test&host=http://localhost:3000"))
  ).text();
  const source = new RegExp(`  function ${name}\\([^]*?\\n  \\}`).exec(html)?.[0];
  expect(source).toBeTruthy();
  return source!;
}

/**
 * A visitor who picks a file and sends before the upload finishes used to
 * post the message without it (the file then surfaced as a leftover chip).
 */
describe("widget composer waits for in-flight uploads (#166)", () => {
  it("disables the send button while an upload is in flight", async () => {
    const scope = {
      sendBtn: { disabled: false },
      input: { value: "Question about my invoice." },
      sending: false,
      pendingAttachments: [],
      uploading: [{ name: "invoice.txt" }],
    };
    runInNewContext(`${await panelFunction("updateSendState")}; updateSendState()`, scope);
    expect(scope.sendBtn.disabled).toBe(true);

    scope.uploading = [];
    runInNewContext(`${await panelFunction("updateSendState")}; updateSendState()`, scope);
    expect(scope.sendBtn.disabled).toBe(false);
  });

  it("send() (Enter bypasses the disabled button) posts nothing until the upload settles", async () => {
    const apiFetch = vi.fn();
    const scope = {
      apiFetch,
      resetPending: false,
      previewMode: false,
      sending: false,
      pendingAttachments: [],
      uploading: [{ name: "invoice.txt" }],
      input: { value: "Question about my invoice.", style: {} },
    };
    runInNewContext(`${await panelFunction("send")}; send()`, scope);
    expect(apiFetch).not.toHaveBeenCalled();
    expect(scope.sending).toBe(false);
    expect(scope.input.value).toBe("Question about my invoice.");
  });
});
