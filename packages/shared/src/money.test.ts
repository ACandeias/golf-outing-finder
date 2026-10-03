import { describe, expect, it } from "vitest";
import { dollarsToCents, formatUsd, isPlausiblePrice, parseUsd } from "./money.ts";

describe("dollarsToCents", () => {
  it("converts to integer cents", () => {
    expect(dollarsToCents(150)).toBe(15000);
    expect(dollarsToCents(119.22)).toBe(11922);
    expect(dollarsToCents(1875)).toBe(187500);
  });
  it("rounds half-cents up despite float drift", () => {
    expect(dollarsToCents(150.005)).toBe(15001);
    expect(dollarsToCents(0.1 + 0.2)).toBe(30);
  });
  it("rejects non-finite input", () => {
    expect(() => dollarsToCents(Number.NaN)).toThrow();
  });
});

describe("formatUsd", () => {
  it("drops cents on whole dollars and keeps them otherwise", () => {
    expect(formatUsd(15000)).toBe("$150");
    expect(formatUsd(150000)).toBe("$1,500");
    expect(formatUsd(11922)).toBe("$119.22");
    expect(formatUsd(1234567)).toBe("$12,345.67");
    expect(formatUsd(5)).toBe("$0.05");
  });
  it("returns empty for null", () => {
    expect(formatUsd(null)).toBe("");
    expect(formatUsd(undefined)).toBe("");
  });
});

describe("parseUsd", () => {
  it("parses common price strings", () => {
    expect(parseUsd("$1,500")).toBe(150000);
    expect(parseUsd("125")).toBe(12500);
    expect(parseUsd("$119.22")).toBe(11922);
    expect(parseUsd("USD 220.5")).toBe(22050);
  });
  it("returns null for non-prices", () => {
    expect(parseUsd("free")).toBeNull();
    expect(parseUsd("$1,50")).toBeNull();
    expect(parseUsd("")).toBeNull();
  });
});

describe("isPlausiblePrice", () => {
  it("allows 0 to $25,000 in integer cents", () => {
    expect(isPlausiblePrice(0)).toBe(true);
    expect(isPlausiblePrice(2_500_000)).toBe(true);
    expect(isPlausiblePrice(2_500_001)).toBe(false);
    expect(isPlausiblePrice(-1)).toBe(false);
    expect(isPlausiblePrice(1.5)).toBe(false);
  });
});
