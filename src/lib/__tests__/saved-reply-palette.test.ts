import { describe, expect, it } from "vitest";

import {
  filterSavedReplies,
  findSlashToken,
  type PaletteReply,
} from "@/app/(app)/(fill)/inbox/[id]/saved-reply-palette";

const reply = (name: string, body = "text"): PaletteReply => ({
  id: name,
  name,
  body,
  productNames: [],
});

describe("findSlashToken", () => {
  it("opens for a slash at the start of the composer or a line", () => {
    expect(findSlashToken("/", 1)).toEqual({ start: 0, query: "" });
    expect(findSlashToken("/refu", 5)).toEqual({ start: 0, query: "refu" });
    expect(findSlashToken("Hi\n/bil", 7)).toEqual({ start: 3, query: "bil" });
  });

  it("ignores slashes mid-line, in URLs and after whitespace in the query", () => {
    expect(findSlashToken("see a/b", 7)).toBeNull();
    expect(findSlashToken("https://x.test", 14)).toBeNull();
    expect(findSlashToken("/refund policy", 14)).toBeNull();
    expect(findSlashToken("", 0)).toBeNull();
  });

  it("only looks at text before the caret", () => {
    expect(findSlashToken("/ref tail", 4)).toEqual({ start: 0, query: "ref" });
  });
});

describe("filterSavedReplies", () => {
  const all = [
    reply("Billing cycle", "renews monthly"),
    reply("Refund policy", "refund within 30 days"),
    reply("Cancel", "to get a refund, cancel first"),
  ];

  it("returns everything for an empty query", () => {
    expect(filterSavedReplies(all, "  ")).toHaveLength(3);
  });

  it("ranks name prefix, then name substring, then body", () => {
    expect(filterSavedReplies(all, "refund").map((r) => r.name)).toEqual([
      "Refund policy",
      "Cancel",
    ]);
    expect(filterSavedReplies(all, "cycle").map((r) => r.name)).toEqual(["Billing cycle"]);
    expect(filterSavedReplies(all, "nothing")).toEqual([]);
  });
});
