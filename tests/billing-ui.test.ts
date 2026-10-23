import { expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { budgetInput, parseBudget, money, CostApproval } from "../src/renderer/billing";

it("rounds the suggested budget upward to cents without dropping tiny charges", () => {
  expect(budgetInput(1)).toBe("0.01");
  expect(budgetInput(10001)).toBe("0.02");
  expect(budgetInput(10000)).toBe("0.01");
  expect(budgetInput(0)).toBe("0.00");
  expect(money(1)).toBe("¥0.000001");
});
it("accepts explicit zero and exact cent budgets, rejects invalid money input", () => {
  expect(parseBudget("0")).toBe(0);
  expect(parseBudget("0.03")).toBe(30000);
  expect(parseBudget("123.45")).toBe(123450000);
  for (const value of ["", "-1", "NaN", "Infinity", "0.001", "1e3", "9007199254740992"]) expect(parseBudget(value)).toBeUndefined();
});
it("keeps a missing model price blocked and explains explicit free pricing", () => {
  const html = renderToStaticMarkup(createElement(CostApproval, { quote: { required: true, estimatedMicros: 0, budgetMicros: 0, priced: false, missingProfiles: ["写作模型"] }, onClose() {} }));
  expect(html).toContain("写作模型");
  expect(html).toContain("免费模型请明确填写 0");
  expect(html).toMatch(/disabled=""[^>]*>按此预算开始/);
});
it("shows the approved currency budget and service bill qualification before calling AI", () => {
  const html = renderToStaticMarkup(createElement(CostApproval, { quote: { required: true, estimatedMicros: 12345, budgetMicros: 12345, priced: true, missingProfiles: [] }, onClose() {} }));
  expect(html).toContain('value="0.02"');
  expect(html).toContain("服务商最终账单可能不同");
  expect(html).not.toContain("Token");
});
