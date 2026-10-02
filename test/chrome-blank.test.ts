import { describe, expect, it } from "vitest";
import { isBlank } from "../src/browser/chrome.js";

describe("isBlank (tabs that do not count as someone else using the browser)", () => {
  it("blank and Chrome-internal pages are blank", () => {
    for (const u of ["", "about:blank", "chrome://newtab/", "chrome://intro/", "chrome://welcome/", "chrome-search://local-ntp/local-ntp.html"]) expect(isBlank(u)).toBe(true);
  });
  it("real pages are not", () => {
    for (const u of ["https://claude.ai/", "https://example.com/", "data:text/html,<title>x</title>", "file:///C:/x.html"]) expect(isBlank(u)).toBe(false);
  });
});
