import { describe, expect, it } from "vitest";
import { offersRegistration } from "./outing-view.ts";

describe("offersRegistration", () => {
  it("is true only while an outing takes entries", () => {
    expect(offersRegistration("open")).toBe(true);
    expect(offersRegistration("waitlist")).toBe(true);
    for (const s of ["sold_out", "cancelled", "past", "expected"] as const) expect(offersRegistration(s)).toBe(false);
  });
});
