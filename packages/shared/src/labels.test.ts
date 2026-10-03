import { describe, expect, it } from "vitest";
import { outingLabel, orgTypeForOutingType } from "./labels.ts";

describe("outingLabel (SPEC 8.5 label table)", () => {
  it.each([
    ["charity", "501c3", "Charity"],
    ["charity", "unverified", "Fundraiser, charity status unverified"],
    ["charity", "other_nonprofit", "Fundraiser, charity status unverified"],
    ["charity", null, "Fundraiser, charity status unverified"],
    ["school_fundraiser", "unverified", "School fundraiser"],
    ["business_association", null, "Trade group outing"],
    ["access_day", null, "Access day"],
    ["open_tournament", null, "Open tournament"],
    ["pro_am", null, "Pro-am"],
    ["other", "501c3", "Golf outing"],
  ] as const)("%s + %s -> %s", (type, status, label) => {
    expect(outingLabel(type, status)).toBe(label);
  });
});

describe("orgTypeForOutingType", () => {
  it("follows SPEC 8.5", () => {
    expect(orgTypeForOutingType("charity")).toBe("charity");
    expect(orgTypeForOutingType("school_fundraiser")).toBe("school");
    expect(orgTypeForOutingType("business_association")).toBe("business_association");
    expect(orgTypeForOutingType("access_day")).toBe("access_operator");
    expect(orgTypeForOutingType("open_tournament")).toBe("tournament_operator");
    expect(orgTypeForOutingType("pro_am")).toBe("tournament_operator");
    expect(orgTypeForOutingType("other")).toBe("other");
  });
});
