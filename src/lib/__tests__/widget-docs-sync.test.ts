import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../../..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");

const guide = read("docs/widget-integration.md");
const docs = read("src/content/docs/widget.md");

/**
 * The integration guide and the public docs page must tell one story
 * (#188/#189/#192/#193): the next/script snippet is the primary Next.js
 * example with the effect version for plain React, "widget key" is the one
 * term (env var NEXT_PUBLIC_SUPPORTSEAL_WIDGET_KEY), and the config endpoint
 * is the documented allowlist probe.
 */
describe("widget docs stay in sync", () => {
  it("documents the next/script snippet as the Next.js primary and the effect version for plain React", () => {
    for (const doc of [guide, docs]) {
      expect(doc).toContain('import Script from "next/script"');
      expect(doc).toContain("document.createElement");
      expect(doc.indexOf("next/script")).toBeLessThan(doc.indexOf("document.createElement"));
    }
  });

  it("forwards userHash in every React identify example (FR-CTX-03)", () => {
    for (const doc of [guide, docs]) {
      const examples = [...doc.matchAll(/```jsx\n([\s\S]*?)```/g)]
        .map((m) => m[1])
        .filter((block) => block.includes('"identify"'));
      expect(examples).toHaveLength(2);
      for (const example of examples) {
        expect(example).toMatch(/\{ id, email, name, userHash \}/);
        expect(example).toContain("}, [id, email, name, userHash]);");
      }
    }
  });

  it("keeps the Astro, Vue 3 and Svelte sections after the React ones and forwards userHash in each identify example (FR-CTX-03)", () => {
    const section = (heading: string) => {
      const start = guide.indexOf(`\n## ${heading}\n`);
      expect(start, `missing "## ${heading}" section`).toBeGreaterThan(-1);
      const next = guide.indexOf("\n## ", start + 1);
      return guide.slice(start, next === -1 ? undefined : next);
    };
    // Prose is hard-wrapped in the guide; compare it with whitespace collapsed.
    const prose = (heading: string) => section(heading).replace(/\s+/g, " ");
    const order = ["Plain React (no Next.js)", "Astro", "Vue 3", "Svelte", "One codebase, many sites"];
    const positions = order.map((heading) => guide.indexOf(`\n## ${heading}\n`));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));

    const frameworks = [
      { heading: "Astro", fence: "astro", reactive: "define:vars={{ identity }}" },
      { heading: "Vue 3", fence: "vue", reactive: "watchEffect(() => {" },
      { heading: "Svelte", fence: "svelte", reactive: "$effect(() => {" },
    ];
    for (const { heading, fence, reactive } of frameworks) {
      const body = section(heading);
      const examples = [...body.matchAll(new RegExp("```" + fence + "\\n([\\s\\S]*?)```", "g"))].map(
        (m) => m[1],
      );
      expect(examples, heading).toHaveLength(1);
      const [example] = examples;
      // userHash is read from the user object, forwarded in the identify
      // payload, and tracked by the reactivity mechanism.
      expect(example, heading).toMatch(/const \{ id, email, name, userHash \} = /);
      // The destructuring pattern is followed by " =", the payload is not.
      expect(example, heading).toMatch(/\{ id, email, name, userHash \}(?! =)/);
      expect(example, heading).toContain('"identify"');
      expect(example, heading).toContain(reactive);
      // Same placeholders as the other sections: install values are
      // referenced from the dashboard, never duplicated.
      expect(example, heading).toContain("WIDGET_SERVER_URL/widget.js");
      expect(example, heading).toContain("WIDGET_KEY");
      expect(body, heading).not.toMatch(/\bpk_[A-Za-z0-9]/);
      expect(body, heading).toContain("#sign-out-reset-the-widget-session");
    }

    // Script-tag placement guidance points at the dashboard snippet once, in
    // the Astro section, and the others reuse its placeholders.
    expect(prose("Astro")).toContain("Settings → Products → your Product → Widget");
    expect(section("Astro")).toContain("is:inline");
    for (const heading of ["Vue 3", "Svelte"]) {
      expect(prose(heading)).toContain("same placeholders as above");
      expect(prose(heading)).toMatch(/once in your (app shell|root layout)/);
    }
  });

  it("documents the per-site env-var pattern", () => {
    for (const doc of [guide, docs]) {
      expect(doc).toContain("NEXT_PUBLIC_SUPPORTSEAL_WIDGET_KEY");
      expect(doc).toContain("One codebase, many sites");
    }
    expect(guide).toContain("import.meta.env.VITE_SUPPORTSEAL_WIDGET_KEY");
  });

  it("documents the config endpoint as the allowlist probe", () => {
    for (const doc of [guide, docs]) {
      expect(doc).toContain("/api/widget/config?key");
      expect(doc).toContain("origin_not_allowed");
    }
    expect(guide).toContain("## Widget abuse model");
    expect(guide).toContain("Rotate widget key");
    expect(guide).toContain("/widget-key/rotate");
    expect(docs).toContain("rotate the widget key");
  });

  it("uses the widget key term only", () => {
    for (const doc of [guide, docs]) {
      expect(doc).not.toMatch(/\bpublic key\b/i);
      expect(doc).not.toMatch(/\bsite key\b/i);
      expect(doc).not.toContain("PUBLIC_WIDGET_KEY");
    }
  });
});
