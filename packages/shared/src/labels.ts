import type { OutingType } from "./schemas.ts";

export type CharityStatus = "501c3" | "other_nonprofit" | "not_nonprofit" | "unverified";

/**
 * Display label table (SPEC.md v1.1 section 8.5), computed at render time from the
 * outing type and the organizer's charity status. `null` means no organizer row.
 */
export function outingLabel(outingType: OutingType, charityStatus: CharityStatus | null): string {
  switch (outingType) {
    case "charity":
      return charityStatus === "501c3" ? "Charity" : "Fundraiser, charity status unverified";
    case "school_fundraiser":
      return "School fundraiser";
    case "business_association":
      return "Trade group outing";
    case "access_day":
      return "Access day";
    case "open_tournament":
      return "Open tournament";
    case "pro_am":
      return "Pro-am";
    case "other":
      return "Golf outing";
  }
}

/** "Charity only" (SPEC.md 8.5): these outing types count as charity. */
export const CHARITY_OUTING_TYPES: readonly OutingType[] = Object.freeze([
  "charity",
  "school_fundraiser",
]);

/** organizers.org_type from the classified outing type (SPEC.md 8.5). */
export function orgTypeForOutingType(
  outingType: OutingType,
): "charity" | "school" | "business_association" | "access_operator" | "tournament_operator" | "other" {
  switch (outingType) {
    case "charity":
      return "charity";
    case "school_fundraiser":
      return "school";
    case "business_association":
      return "business_association";
    case "access_day":
      return "access_operator";
    case "open_tournament":
    case "pro_am":
      return "tournament_operator";
    case "other":
      return "other";
  }
}
