import { describe, expect, it } from "vitest";
import { internalLink } from "./links.ts";

describe("internalLink", () => {
  it("keeps paths of the app and drops everything that leaves it", () => {
    expect(internalLink("/buchungen?id=3")).toBe("/buchungen?id=3");
    for (const link of ["//evil.example", "/\\evil.example", "/\\/evil.example", "https://evil.example", "javascript:alert(1)", "", null]) {
      expect(internalLink(link)).toBeNull();
    }
  });
});
