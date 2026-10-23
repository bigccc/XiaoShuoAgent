import { expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { money, CostDetails } from "../src/renderer/billing";
it("does not round tiny charges down to free",()=>{expect(money(1)).toBe("¥0.000001");});
it("shows unknown costs without presenting a false free total",()=>{
 const html=renderToStaticMarkup(createElement(CostDetails,{summary:{spentMicros:0,reservedMicros:0,budgetMicros:0,unknown:true}}));
 expect(html).toContain("费用未知");expect(html).not.toContain("¥0");
});
it("labels partial estimates and omits obsolete spending allowances",()=>{
 const html=renderToStaticMarkup(createElement(CostDetails,{summary:{spentMicros:1000,reservedMicros:2000,budgetMicros:1,unknown:true}}));
 expect(html).toContain("已知部分估算");expect(html).toContain("¥0.003");expect(html).not.toContain("剩余预算");
});
