import { describe, expect, it } from "vitest";
// @ts-expect-error standalone Node audit intentionally has no build dependency
import { contrast, composite, parseColor, audit, readThemes, validateTextUsage } from "../scripts/audit-contrast.mjs";
describe("contrast audit", () => {
  it("matches known WCAG pass and fail fixtures", () => {
    expect(contrast("#000", "#fff")).toBe(21);
    expect(contrast("#777", "#fff")).toBeLessThan(4.5);
    expect(contrast("#767676", "#fff")).toBeGreaterThan(4.5);
  });
  it("composites transparent colors before calculating", () => {
    expect(composite(parseColor("#0008"), parseColor("#fff"))[0]).toBeCloseTo(119);
    expect(contrast("rgba(0, 0, 0, 0.5)", "#fff")).toBeCloseTo(3.977, 2);
    expect(() => parseColor("currentColor")).toThrow();
  });
  it("rejects unclassified auditable text colors", () => {
    expect(() => validateTextUsage("p { color: var(--new-text); }")).toThrow(/Unclassified/);
    expect(() => validateTextUsage("p { color: #aaaaaa; }")).toThrow(/Unclassified/);
  });
  it("reports theme, pair, actual ratio and threshold for a failed theme", () => {
    const themes = readThemes();
    themes.light["--focus-ring"] = themes.light["--bg-app"];
    const failure = audit(themes).find((row: { name: string; theme: string }) => row.theme === "light" && row.name === "necessary focus / --bg-app");
    expect(failure).toMatchObject({ theme: "light", ratio: 1, min: 3, pass: false });
  });
  it("passes the real token manifest in both themes", () => {
    expect(audit(readThemes()).filter((row: { pass: boolean }) => !row.pass)).toEqual([]);
  });
});
