/**
 * Browser-side filtering for city and state pages (SPEC.md 9.2). The server
 * renders every outing and hides the ones the URL's filters exclude; this script
 * re-applies the same predicate as the form changes and keeps the URL in step.
 * It reads only the form's own controls, never raw query text.
 */
import {
  COURSE_TYPE_FILTERS,
  DISTANCE_MILES,
  FORMAT_FILTERS,
  filtersToParams,
  matchesFilters,
  type CourseTypeFilter,
  type DistanceMiles,
  type FilterableOuting,
  type FormatFilter,
  type ListingFilters,
} from "@gof/shared/filters";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function readForm(form: HTMLFormElement): ListingFilters {
  const data = new FormData(form);
  const str = (name: string): string => {
    const v = data.get(name);
    return typeof v === "string" ? v.trim() : "";
  };
  const courseTypes = data
    .getAll("course_type")
    .filter((v): v is CourseTypeFilter => typeof v === "string" && (COURSE_TYPE_FILTERS as readonly string[]).includes(v));
  const price = Number.parseInt(str("max_price"), 10);
  const distance = Number.parseInt(str("distance"), 10);
  const format = str("format");
  let from = DATE.test(str("from")) ? str("from") : null;
  let to = DATE.test(str("to")) ? str("to") : null;
  if (from && to && from > to) [from, to] = [to, from];
  return {
    courseTypes,
    charityOnly: data.has("charity"),
    maxPriceCents: Number.isFinite(price) && price >= 0 && price <= 25_000 ? price * 100 : null,
    from,
    to,
    distanceMiles: (DISTANCE_MILES as readonly number[]).includes(distance) ? (distance as DistanceMiles) : null,
    format: (FORMAT_FILTERS as readonly string[]).includes(format) ? (format as FormatFilter) : null,
    singlesWelcome: data.has("singles"),
  };
}

function numOrNull(v: string | undefined): number | null {
  if (v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function cardData(el: HTMLElement): FilterableOuting {
  const d = el.dataset;
  return {
    courseType: d.courseType ?? "unknown",
    outingType: d.outingType ?? "other",
    singlePriceCents: numOrNull(d.single),
    startDate: d.date ? d.date : null,
    format: d.format ? d.format : null,
    distanceMiles: numOrNull(d.distance),
  };
}

function apply(form: HTMLFormElement): void {
  const filters = readForm(form);
  const cards = Array.from(document.querySelectorAll<HTMLElement>("[data-outing]"));
  let shown = 0;
  for (const card of cards) {
    const ok = matchesFilters(cardData(card), filters);
    card.hidden = !ok;
    if (ok) shown++;
  }
  for (const group of Array.from(document.querySelectorAll<HTMLElement>("[data-filter-group]"))) {
    group.hidden = group.querySelector("[data-outing]:not([hidden])") === null;
  }
  const count = document.querySelector<HTMLElement>("[data-filter-count]");
  if (count) {
    count.textContent =
      shown === cards.length
        ? `${cards.length} ${cards.length === 1 ? "outing" : "outings"}`
        : `Showing ${shown} of ${cards.length} outings`;
  }
  const empty = document.querySelector<HTMLElement>("[data-filter-empty]");
  if (empty) empty.hidden = shown > 0 || cards.length === 0;
  const qs = filtersToParams(filters).toString();
  history.replaceState(null, "", qs ? `${location.pathname}?${qs}` : location.pathname);
}

export function initFilters(): void {
  const form = document.querySelector<HTMLFormElement>("[data-filter-form]");
  if (!form) return;
  form.addEventListener("change", () => apply(form));
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    apply(form);
  });
}
