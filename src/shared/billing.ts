import type { ModelPricing } from './types';
export interface BillingQuote { required:boolean; minimumBudgetMicros?:number; estimatedMicros:number; budgetMicros:number; priced:boolean; missingProfiles:string[] }
export interface BillingSummary { spentMicros:number; reservedMicros:number; budgetMicros:number; unknown:boolean; nextMicros?:number }
/** Prices are yuan / million tokens, hence price * tokens is micro-yuan. */
export function costMicros(price:ModelPricing, input:number, output:number, cached=0) {
  cached=Math.min(input,Math.max(0,cached));
  return Math.ceil(Math.max(0,input-cached)*price.input + cached*(price.cachedInput ?? price.input) + output*price.output);
}
export function billable(type:string) { return /^(conversation\.(send|retry)|writing\.(start|resume)|revision\.(start|resume)|ai\..+|model\.test|voice\.(extract|resume)|scene\.(plan|resume|revise)|structure\.revise|story\.job\.(start|resume)|authoring\.(sync|retrySync|resolveSync)|task\.resume)$/.test(type); }
export const money=(micros:number)=>`¥${(micros/1e6).toFixed(micros > 0 && micros < 10000 ? 4 : 2)}`;
