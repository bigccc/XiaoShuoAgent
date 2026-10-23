import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Store } from "../src/main/store";
import { DomainService } from "../src/main/domain";
import { validateModelPricing } from "../src/shared/validation";
let store: Store;
let domain: DomainService;
beforeEach(() => { store = new Store(":memory:"); domain = new DomainService(store); });
afterEach(() => store.close());
const connection = { type: "profile.save" as const, name: "创作模型", baseUrl: "https://example.com", model: "model", purpose: "writing" as const };
describe("model price configuration", () => {
  it("retains explicit free prices, decimal prices, and optional cache prices", () => {
    const pricing = { currency: "CNY" as const, input: 0, output: 0.012345, cachedInput: 0 };
    const result = domain.execute({ ...connection, pricing });
    expect(result.ok).toBe(true);
    expect(domain.snapshot().profiles[0].pricing).toEqual(pricing);
  });
  it("allows legacy connections to be saved without inventing zero prices", () => {
    expect(domain.execute(connection).ok).toBe(true);
    expect(domain.snapshot().profiles[0].pricing).toBeUndefined();
  });
  it("preserves existing prices when an older client saves connection fields", () => {
    const pricing = { currency: "CNY" as const, input: 1.2, output: 5 };
    domain.execute({ ...connection, pricing });
    const profile = domain.snapshot().profiles[0];
    expect(domain.execute({ ...connection, id: profile.id, revision: profile.revision, name: "改名" }).ok).toBe(true);
    expect(domain.snapshot().profiles[0].pricing).toEqual(pricing);
  });
  it.each([
    { currency: "USD", input: 1, output: 2 },
    { currency: "CNY", output: 2 },
    { currency: "CNY", input: "", output: 2 },
    { currency: "CNY", input: -1, output: 2 },
    { currency: "CNY", input: 1, output: Infinity },
    { currency: "CNY", input: 1, output: NaN },
    { currency: "CNY", input: 1, output: 1000001 },
    { currency: "CNY", input: 1, output: 2, cachedInput: -0.1 },
    { currency: "CNY", input: 1, output: 2, secret: "ignored" },
  ])("rejects malformed or unsupported prices: %j", (pricing) => {
    expect(() => validateModelPricing(pricing)).toThrow();
    expect(domain.execute({ ...connection, pricing } as never).ok).toBe(false);
    expect(domain.snapshot().profiles).toEqual([]);
  });
});
