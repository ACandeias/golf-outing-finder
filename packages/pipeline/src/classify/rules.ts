import type { OutingType } from "@gof/shared/schemas";
import { hostIn } from "../extract/domain.ts";
import type { CharityStatus } from "../stages/rows.ts";

/** Schools, universities, PTAs and booster clubs (SPEC.md 8.5 rule 4). */
const SCHOOL_ORGANIZER =
  /\b(school|schools|university|college|academy|prep|preparatory|elementary|pta|pto|ptsa|parent[- ]teacher|boosters?|alumni association)\b/i;

export function isSchoolOrganizer(name: string | null): boolean {
  return name !== null && SCHOOL_ORGANIZER.test(name);
}

export interface OutingTypeInput {
  organizerDomain: string;
  organizerName: string | null;
  hint: OutingType;
  irsSubsection: string | null;
  charityStatus: CharityStatus;
  accessOperators: readonly string[];
  tournamentOperators: readonly string[];
}

/** SPEC.md 8.5 outing type, first rule that matches. */
export function outingTypeFor(i: OutingTypeInput): OutingType {
  if (hostIn(i.organizerDomain, i.accessOperators)) return "access_day";
  if (hostIn(i.organizerDomain, i.tournamentOperators) || i.hint === "open_tournament")
    return "open_tournament";
  if (i.hint === "pro_am") return "pro_am";
  if (i.hint === "school_fundraiser" || isSchoolOrganizer(i.organizerName)) return "school_fundraiser";
  if (i.irsSubsection === "06" || i.hint === "business_association") return "business_association";
  if (i.charityStatus === "501c3" || i.hint === "charity") return "charity";
  return "other";
}

export function charityStatusFor(subsection: string | null): CharityStatus {
  if (subsection === null) return "unverified";
  return subsection === "03" ? "501c3" : "other_nonprofit";
}
