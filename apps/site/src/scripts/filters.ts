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
  DEFAULT_SORT,
  listParams,
  matchesFilters,
  SORT_ORDERS,
  type CourseTypeFilter,
  type DistanceMiles,
  type FilterableOuting,
  type FormatFilter,
  type ListingFilters,
  type SortOrder,
} from "@gof/shared/filters";
import { visibleListAds } from "../lib/ads.ts";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The "Include municipal courses" switch (MunicipalToggle.astro), outside the form. */
function muniToggle(): HTMLElement | null {
  return document.querySelector<HTMLElement>("[data-muni-toggle]");
}

/** The page's order, from the sort switch (SortToggle.astro). */
function currentSort(): SortOrder {
  const v = document.querySelector<HTMLElement>("[data-sort-toggle]")?.dataset.sort ?? "";
  return (SORT_ORDERS as readonly string[]).includes(v) ? (v as SortOrder) : DEFAULT_SORT;
}

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
    includeMunicipal: muniToggle()?.getAttribute("aria-checked") === "true",
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
  // Only the list the form belongs to: other sheets on the page (the nearby
  // outings under an empty city, the home page's near-you rows) are not part of
  // the count and keep their rows whatever the filters say.
  const cards = Array.from(document.querySelectorAll<HTMLElement>("[data-filter-group] [data-outing]"));
  let shown = 0;
  for (const card of cards) {
    const ok = matchesFilters(cardData(card), filters);
    card.hidden = !ok;
    if (ok) shown++;
  }
  // A list ad unit stays only between two shown results: never above the first or
  // after the last (SPEC.md 9.5). Positions don't move as filters change.
  const items = Array.from(
    document.querySelectorAll<HTMLElement>("[data-filter-group] [data-outing], [data-filter-group] [data-ad-row]"),
  );
  const adRows = items.filter((el) => el.hasAttribute("data-ad-row"));
  const keep = visibleListAds(
    items.map((el) => (el.hasAttribute("data-ad-row") ? { kind: "ad" as const } : { kind: "row" as const, shown: !el.hidden })),
  );
  adRows.forEach((el, i) => {
    el.hidden = !keep[i];
  });
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
  const sort = currentSort();
  const at = (qs: string) => (qs ? `${location.pathname}?${qs}` : location.pathname);
  history.replaceState(null, "", at(listParams(filters, sort).toString()));
  // The sort links reload the page, so they carry the filters as they are now.
  for (const link of Array.from(document.querySelectorAll<HTMLAnchorElement>("[data-sort-link]"))) {
    const order = (SORT_ORDERS as readonly string[]).includes(link.dataset.sortLink ?? "") ? (link.dataset.sortLink as SortOrder) : DEFAULT_SORT;
    link.setAttribute("href", at(listParams(filters, order).toString()));
  }
  // A picked course type replaces the municipal default, so the switch steps aside.
  const toggle = muniToggle();
  const wrap = document.querySelector<HTMLElement>("[data-muni-wrap]");
  if (wrap) wrap.hidden = filters.courseTypes.length > 0;
  if (toggle) {
    toggle.setAttribute("href", at(listParams({ ...filters, includeMunicipal: !filters.includeMunicipal }, sort).toString()));
  }
}

export function initFilters(): void {
  const form = document.querySelector<HTMLFormElement>("[data-filter-form]");
  if (!form) return;
  form.addEventListener("change", () => apply(form));
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    apply(form);
  });
  const toggle = muniToggle();
  toggle?.addEventListener("click", (e) => {
    e.preventDefault();
    toggle.setAttribute("aria-checked", toggle.getAttribute("aria-checked") === "true" ? "false" : "true");
    apply(form);
  });
}
