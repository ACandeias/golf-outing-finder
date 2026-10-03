import { describe, expect, it } from "vitest";
import { jaro, jaroWinkler } from "./jaro-winkler.ts";

describe("jaro", () => {
  it("is 1 for equal strings and 0 for no common characters", () => {
    expect(jaro("abc", "abc")).toBe(1);
    expect(jaro("abc", "xyz")).toBe(0);
    expect(jaro("", "")).toBe(1);
    expect(jaro("", "a")).toBe(0);
  });
  it("matches the textbook MARTHA/MARHTA value", () => {
    expect(jaro("martha", "marhta")).toBeCloseTo(0.9444, 4);
  });
  it("matches the textbook DIXON/DICKSONX value", () => {
    expect(jaro("dixon", "dicksonx")).toBeCloseTo(0.7667, 4);
  });
});

describe("jaroWinkler", () => {
  it("matches the textbook values", () => {
    expect(jaroWinkler("martha", "marhta")).toBeCloseTo(0.9611, 4);
    expect(jaroWinkler("dixon", "dicksonx")).toBeCloseTo(0.8133, 4);
    expect(jaroWinkler("dwayne", "duane")).toBeCloseTo(0.84, 2);
  });
  it("is symmetric", () => {
    expect(jaroWinkler("winged foot", "winged foot west")).toBe(
      jaroWinkler("winged foot west", "winged foot"),
    );
  });
  it("stays at or below 1", () => {
    expect(jaroWinkler("aaaa", "aaaa")).toBe(1);
    expect(jaroWinkler("aaaab", "aaaac")).toBeLessThanOrEqual(1);
  });
});
