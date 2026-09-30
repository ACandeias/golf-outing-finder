import { describe, expect, it } from "vitest";
import { dollarsToCents, formatUsd } from "./money.ts";

describe("dollarsToCents", () => {
  it("rounds to the nearest cent", () => {
    expect(dollarsToCents(150)).toBe(15000);
    expect(dollarsToCents(150.005)).toBe(15001);
  });
});

describe("formatUsd", () => {
  it("formats with a thousands separator", () => {
    expect(formatUsd(15000)).toBe("$150.00");
    expect(formatUsd(1234567)).toBe("$12,345.67");
  });
  it("returns empty for null", () => {
    expect(formatUsd(null)).toBe("");
    expect(formatUsd(undefined)).toBe("");
  });
});
