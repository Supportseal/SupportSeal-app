import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

import { RegisterForm } from "@/app/(auth)/register/register-form";
import { LEGAL_DOCUMENTS, legalConfig, legalUrl, publicLegalLinks } from "@/config/legal";

describe("hosted legal policy links (issue #14)", () => {
  afterEach(() => {
    legalConfig.operative = true;
  });

  it("is operative, in step with the marketing site's policies", () => {
    expect(legalConfig.operative).toBe(true);
  });

  it("points at the policies published on the marketing site", () => {
    expect(LEGAL_DOCUMENTS.map((doc) => doc.slug)).toEqual([
      "terms",
      "privacy",
      "acceptable-use",
      "subprocessors",
      "data-responsibility",
    ]);
    expect(legalUrl("privacy")).toBe("https://supportseal.app/legal/privacy");
  });

  it("keeps inactive policies out of the signup form", () => {
    legalConfig.operative = false;
    expect(publicLegalLinks()).toEqual([]);
    expect(renderToStaticMarkup(<RegisterForm legalLinks={publicLegalLinks()} />)).not.toContain(
      "data-signup-legal-notice",
    );
  });

  it("links the signup notice to the marketing site once the policies are operative", () => {
    const signup = renderToStaticMarkup(<RegisterForm legalLinks={publicLegalLinks()} />);
    expect(signup).toContain("data-signup-legal-notice");
    expect(signup).toContain('href="https://supportseal.app/legal/terms"');
    expect(signup).toContain('href="https://supportseal.app/legal/acceptable-use"');
    expect(signup).toContain('href="https://supportseal.app/legal/privacy"');
  });
});
