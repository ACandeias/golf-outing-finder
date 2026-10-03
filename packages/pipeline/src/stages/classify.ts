import { orgTypeForOutingType } from "@gof/shared/labels";
import { matchIrs } from "../classify/irs-match.ts";
import { charityStatusFor, outingTypeFor } from "../classify/rules.ts";
import { organizerDomainFor } from "../extract/canonical.ts";
import {
  classifiedOutingSchema,
  emptyResult,
  type ClassifiedOuting,
  type ClassifyStage,
  type ExtractedEvent,
} from "./types.ts";

type ExcludeReason = ClassifiedOuting["exclude_reason"];

/** SPEC.md 8.5: is_outing false, a reject_reason, or lodging required. */
function exclusion(e: ExtractedEvent): ExcludeReason {
  if (e.reject_reason !== null) return e.reject_reason;
  if (!e.is_outing) return "not_outing";
  if (e.lodging_required) return "lodging_required";
  return null;
}

/**
 * SPEC.md 8.5 as amended, workstream C. Excludes non-outings; verifies the
 * organizer against the IRS data (EIN, then name in the venue state at 0.92,
 * then nationwide at 0.95; subsection 03 is 501c3, any other other_nonprofit,
 * no match unverified); sets the outing type by the first matching rule
 * (access operator domain, tournament operator domain or hint, pro-am, school,
 * IRS 06 or trade-group hint, 501c3 or charity hint, other) and org_type from
 * it. The organizer domain is the registrable domain of the canonical source URL.
 */
export const classify: ClassifyStage = (ctx, input) => {
  const result = emptyResult();
  let excluded = 0;
  const outings = input.events.map((e): ClassifiedOuting => {
    const reason = exclusion(e);
    if (reason) excluded++;
    const irs = matchIrs(input.irs, {
      name: e.organizer_name,
      ein: e.organizer_ein,
      state: e.venue_state,
    });
    const charityStatus = charityStatusFor(irs.record?.subsection ?? null);
    const organizerDomain = organizerDomainFor(e);
    const outingType = outingTypeFor({
      organizerDomain,
      organizerName: e.organizer_name,
      hint: e.outing_type_hint,
      irsSubsection: irs.record?.subsection ?? null,
      charityStatus,
      accessOperators: ctx.overrides.accessOperators,
      tournamentOperators: ctx.overrides.tournamentOperators,
    });
    return classifiedOutingSchema.parse({
      ...e,
      excluded: reason !== null,
      exclude_reason: reason,
      outing_type: outingType,
      org_type: orgTypeForOutingType(outingType),
      charity_status: charityStatus,
      irs: irs.record,
      irs_match: irs.kind,
      organizer_domain: organizerDomain,
    });
  });
  if (excluded > 0) result.counters.events_excluded = excluded;
  return { output: { outings }, result };
};
