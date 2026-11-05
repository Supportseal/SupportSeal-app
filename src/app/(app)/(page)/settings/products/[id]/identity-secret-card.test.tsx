import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../actions", () => ({ rotateIdentitySecretAction: vi.fn() }));

import { IdentitySecretCard } from "./identity-secret-card";

const secret = `is_${"s".repeat(43)}`;
const base = { id: "prod_1", name: "Alpha", hasIdentitySecret: true, archived: false };

describe("IdentitySecretCard (issue #20)", () => {
  it("shows the secret and signing snippet to admins", () => {
    const html = renderToStaticMarkup(
      <IdentitySecretCard product={{ ...base, identitySecret: secret, isAdmin: true }} />,
    );
    expect(html).toContain(secret);
    expect(html).toContain("createHmac");
    expect(html).toContain("Rotate identity secret");
  });

  it("never renders the secret for non-admins, even when one exists (FR-CTX-03)", () => {
    // Defence in depth: even if a secret reached the card, a non-admin must
    // not see it.
    const html = renderToStaticMarkup(
      <IdentitySecretCard product={{ ...base, identitySecret: secret, isAdmin: false }} />,
    );
    expect(html).not.toContain(secret);
    expect(html).toContain("Ask a Workspace admin");
    expect(html).not.toContain("Rotate identity secret");
  });

  it("offers generation to admins when no secret exists yet", () => {
    const html = renderToStaticMarkup(
      <IdentitySecretCard
        product={{ ...base, identitySecret: null, hasIdentitySecret: false, isAdmin: true }}
      />,
    );
    expect(html).toContain("Generate identity secret");
    expect(html).not.toContain(secret);
  });
});
