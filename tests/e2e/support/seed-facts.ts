/**
 * What the seed loader writes into D1 from seed/outings.json and
 * tests/fixtures/courses.json, as the pages should show it with the clock pinned
 * to 2026-09-28. Slugs follow SPEC.md 8.1 and 8.7; they were read back from a
 * seeded local D1 and must not change once published (8.7).
 */

/** SPEC.md 6, 9.4, 11: e2e pins the site clock. */
export const SITE_NOW = "2026-09-28";

export interface SeedOuting {
  seedId: string;
  slug: string;
  title: string;
  courseSlug: string;
  courseName: string;
  city: string;
  citySlug: string;
  state: string;
  courseType: "municipal" | "public" | "semi_private" | "private" | "resort";
  /** SPEC.md 8.5 label table; every seeded organizer is `unverified`. */
  label: string;
  organizerSlug: string | null;
  status: "open" | "expected";
  startDate: string | null;
  expectedMonth: string | null;
  registrationUrl: string | null;
  sourceUrl: string;
}

const o = (x: SeedOuting): SeedOuting => x;

export const NKF_WINGED_FOOT = o({
  seedId: "s06-nkf-winged-foot",
  slug: "2026/nkf-golf-classic-at-winged-foot-golf-club-winged-foot",
  title: "NKF Golf Classic at Winged Foot Golf Club",
  courseSlug: "ny/winged-foot-golf-club",
  courseName: "Winged Foot Golf Club",
  city: "Mamaroneck",
  citySlug: "mamaroneck",
  state: "NY",
  courseType: "private",
  label: "Fundraiser, charity status unverified",
  organizerSlug: "national-kidney-foundation",
  status: "open",
  startDate: "2026-10-19",
  expectedMonth: null,
  registrationUrl: "https://support.kidney.org/event/2026-nkf-golf-classic-at-winged-foot-golf-club/e766893",
  sourceUrl: "https://support.kidney.org/event/2026-nkf-golf-classic-at-winged-foot-golf-club/e766893",
});

export const FORDHAM_WINGED_FOOT = o({
  seedId: "s04-fordham-winged-foot",
  slug: "2026/fordham-golf-classic-winged-foot",
  title: "Fordham Golf Classic",
  courseSlug: "ny/winged-foot-golf-club",
  courseName: "Winged Foot Golf Club",
  city: "Mamaroneck",
  citySlug: "mamaroneck",
  state: "NY",
  courseType: "private",
  label: "School fundraiser",
  organizerSlug: "fordham-university",
  status: "open",
  startDate: "2026-10-13",
  expectedMonth: null,
  registrationUrl: "https://now.fordham.edu/event/fordham-golf-classic-2026/",
  sourceUrl: "https://now.fordham.edu/event/fordham-golf-classic-2026/",
});

export const BUILDERS_METROPOLIS = o({
  seedId: "s02-builders-institute-metropolis",
  slug: "2026/builders-institute-annual-golf-outing-metropolis",
  title: "Builders Institute Annual Golf Outing",
  courseSlug: "ny/metropolis-country-club",
  courseName: "Metropolis Country Club",
  city: "White Plains",
  citySlug: "white-plains",
  state: "NY",
  courseType: "private",
  label: "Trade group outing",
  organizerSlug: "builders-institute",
  status: "open",
  startDate: "2026-10-07",
  expectedMonth: null,
  registrationUrl: "https://web.buildersinstitute.org/events/Annual-Golf-Outing-1120/details",
  sourceUrl: "https://www.buildersinstitute.org/annual-golf-outing",
});

export const ENCANTO = o({
  seedId: "s01-encanto-pejatc",
  slug: "2026/scramble-benefiting-pejatc-apprentice-tuition-encanto",
  title: "Scramble benefiting PEJATC apprentice tuition",
  courseSlug: "az/encanto-golf-course",
  courseName: "Encanto Golf Course",
  city: "Phoenix",
  citySlug: "phoenix",
  state: "AZ",
  courseType: "municipal",
  label: "Fundraiser, charity status unverified",
  organizerSlug: null,
  status: "open",
  startDate: "2026-10-03",
  expectedMonth: null,
  registrationUrl: "https://azgolf.org/hubfs/%5BAGA%5D/Charity_Invitational_Sanctioned%20Events/IMG_6395.jpeg",
  sourceUrl: "https://azgolf.org/charity-club-sanctioned-events",
});

export const THRIVERS = o({
  seedId: "s05-thrivers-survivors-harding-park",
  slug: "2026/thrivers-and-survivors-charity-golf-tournament-tpc-harding-park",
  title: "Thrivers & Survivors Charity Golf Tournament",
  courseSlug: "ca/tpc-harding-park",
  courseName: "TPC Harding Park",
  city: "San Francisco",
  citySlug: "san-francisco",
  state: "CA",
  courseType: "municipal",
  label: "Fundraiser, charity status unverified",
  organizerSlug: "thesecondopinion",
  status: "open",
  startDate: "2026-10-14",
  expectedMonth: null,
  registrationUrl:
    "https://thesecondopinion.networkforgood.com/events/101944-thrivers-survivors-charity-golf-tournament-2026",
  sourceUrl: "https://thesecondopinion.networkforgood.com/events/101944-thrivers-survivors-charity-golf-tournament",
});

export const GRADY = o({
  seedId: "s12-grady-rocky-point",
  slug: "2026/grady-charity-golf-scramble-rocky-point",
  title: "Grady Charity Golf Scramble",
  courseSlug: "fl/rocky-point-golf-course",
  courseName: "Rocky Point Golf Course",
  city: "Tampa",
  citySlug: "tampa",
  state: "FL",
  courseType: "municipal",
  label: "School fundraiser",
  organizerSlug: "grady-dads-club",
  status: "open",
  startDate: "2026-11-07",
  expectedMonth: null,
  // Directory source; no registration_url kept (seed has none).
  registrationUrl: null,
  sourceUrl: "https://scramblehunter.com/event/grady-charity-golf-scramble-2026/",
});

export const TORREY_TWO_MAN = o({
  seedId: "s13-two-man-links-torrey-pines",
  slug: "2026/amateurgolf-com-two-man-links-and-father-and-son-at-torrey-pines-torrey-pines-south",
  title: "AmateurGolf.com Two Man Links and Father & Son at Torrey Pines",
  courseSlug: "ca/torrey-pines-south-course",
  courseName: "Torrey Pines South Course",
  city: "La Jolla",
  citySlug: "la-jolla",
  state: "CA",
  courseType: "municipal",
  label: "Open tournament",
  organizerSlug: "amateurgolf-com",
  status: "open",
  startDate: "2026-12-15",
  expectedMonth: null,
  registrationUrl:
    "https://www.amateurgolf.com/amateur-golf-tournaments/12721/amateurgolf-com-2026-two-man-links-and-father-son-at-torrey-pines/register",
  sourceUrl:
    "https://www.amateurgolf.com/amateur-golf-tournaments/12721/amateurgolf-com-2026-two-man-links-and-father-son-at-torrey-pines",
});

export const AUTISM_SPEAKS_EXPECTED = o({
  seedId: "e08-autism-speaks-winged-foot",
  slug: "2027/autism-speaks-golf-classic-winged-foot",
  title: "Autism Speaks Golf Classic",
  courseSlug: "ny/winged-foot-golf-club",
  courseName: "Winged Foot Golf Club",
  city: "Mamaroneck",
  citySlug: "mamaroneck",
  state: "NY",
  courseType: "private",
  label: "Fundraiser, charity status unverified",
  organizerSlug: "autism-speaks",
  status: "expected",
  startDate: null,
  expectedMonth: "2027-06",
  registrationUrl: null,
  sourceUrl: "https://join.autismspeaks.org/golfclassic",
});

export const GWA_QUAKER_RIDGE_EXPECTED = o({
  seedId: "e10-gwa-quaker-ridge",
  slug: "2027/golf-with-access-day-at-quaker-ridge-quaker-ridge",
  title: "Golf With Access day at Quaker Ridge",
  courseSlug: "ny/quaker-ridge-golf-club",
  courseName: "Quaker Ridge Golf Club",
  city: "Mamaroneck",
  citySlug: "mamaroneck",
  state: "NY",
  courseType: "private",
  label: "Access day",
  organizerSlug: "golf-with-access",
  status: "expected",
  startDate: null,
  expectedMonth: "2027-07",
  registrationUrl: null,
  sourceUrl: "https://golfwithaccess.com/events",
});

/** e05: expected, with an announced start_date; still no Event markup (8.8, 9.4). */
export const VALLEY_HOSPITAL_ANNOUNCED = o({
  seedId: "e05-valley-hospital-ridgewood",
  slug: "2027/valley-hospital-auxiliary-golf-outing-ridgewood",
  title: "Valley Hospital Auxiliary Golf Outing",
  courseSlug: "nj/the-ridgewood-country-club",
  courseName: "The Ridgewood Country Club",
  city: "Paramus",
  citySlug: "paramus",
  state: "NJ",
  courseType: "private",
  label: "Fundraiser, charity status unverified",
  organizerSlug: "valley-hospital-auxiliary",
  status: "expected",
  startDate: "2027-06-07",
  expectedMonth: "2027-06",
  registrationUrl: null,
  sourceUrl: "https://www.valleyhealth.com/services/auxiliary/auxiliary-events-meetings/auxiliary-golf-outing",
});

/** e17: expected with no expected_month, held `no_date`, never published (8.8). */
export const HELD_E17_SLUG = "2026/buoniconti-fund-celebrity-golf-invitational-bears";
export const HELD_E17_ORGANIZER = "the-buoniconti-fund-to-cure-paralysis";

/**
 * Courses in tests/fixtures/courses.json that no seed entry uses, so they have
 * outing_count 0 and must 404 (SPEC.md 9.1). The first is the gc7 decoy: Oakmont
 * Country Club near Glendale, CA.
 */
export const EMPTY_COURSE_SLUGS = ["ca/oakmont-country-club", "ny/westchester-country-club"] as const;

/** Published outings (every seed entry but e17, s14, s15): 13 dated, 16 expected. */
export const PUBLISHED_OUTING_SLUGS = [
  "2026/12th-annual-brian-ong-memorial-charity-golf-tournament-mccormick-ranch",
  "2026/amateurgolf-com-two-man-links-and-father-and-son-at-torrey-pines-torrey-pines-south",
  "2026/builders-institute-annual-golf-outing-metropolis",
  "2026/fordham-golf-classic-winged-foot",
  "2026/george-d-yates-golf-outing-maidstone",
  "2026/grady-charity-golf-scramble-rocky-point",
  "2026/hyslop-drive-fore-a-cure-arizona-biltmore",
  "2026/legends-on-the-links-riviera",
  "2026/mercy-care-golf-classic-peachtree",
  "2026/nkf-golf-classic-at-philadelphia-country-club-philadelphia",
  "2026/nkf-golf-classic-at-winged-foot-golf-club-winged-foot",
  "2026/pepperdine-wave-classic-riviera",
  "2026/scramble-benefiting-pejatc-apprentice-tuition-encanto",
  "2026/scramble-for-charity-golf-tournament-whitmoor-north",
  "2026/thrivers-and-survivors-charity-golf-tournament-tpc-harding-park",
  "2027/30th-annual-scholarship-golf-classic-bethpage-state-park-courses",
  "2027/american-cancer-society-chicago-golf-select-medinah",
  "2027/autism-speaks-golf-classic-winged-foot",
  "2027/bcny-golf-outing-deepdale",
  "2027/golf-with-access-day-at-plainfield-plainfield",
  "2027/golf-with-access-day-at-quaker-ridge-quaker-ridge",
  "2027/hope-and-heroes-golf-tournament-baltusrol",
  "2027/jack-martin-fund-golf-outing-deepdale",
  "2027/mariano-rivera-save-653-invitational-metropolis",
  "2027/north-shore-land-alliance-golf-and-tennis-outing-piping-rock",
  "2027/presbyterian-seniorcare-foundation-golf-outing-oakmont",
  "2027/st-anthony-school-programs-golf-outing-oakmont",
  "2027/valley-hospital-auxiliary-golf-outing-ridgewood",
  "2027/wchc-golf-outing-metropolis",
] as const;

/** Dated (open) published outings: the only ones with Event markup and in /api/outings. */
export const DATED_OUTING_SLUGS = [
  "2026/scramble-benefiting-pejatc-apprentice-tuition-encanto",
  "2026/builders-institute-annual-golf-outing-metropolis",
  "2026/nkf-golf-classic-at-philadelphia-country-club-philadelphia",
  "2026/fordham-golf-classic-winged-foot",
  "2026/thrivers-and-survivors-charity-golf-tournament-tpc-harding-park",
  "2026/scramble-for-charity-golf-tournament-whitmoor-north",
  "2026/nkf-golf-classic-at-winged-foot-golf-club-winged-foot",
  "2026/george-d-yates-golf-outing-maidstone",
  "2026/hyslop-drive-fore-a-cure-arizona-biltmore",
  "2026/12th-annual-brian-ong-memorial-charity-golf-tournament-mccormick-ranch",
  "2026/legends-on-the-links-riviera",
  "2026/grady-charity-golf-scramble-rocky-point",
  "2026/amateurgolf-com-two-man-links-and-father-and-son-at-torrey-pines-torrey-pines-south",
] as const;

/** Courses with outing_count >= 1 (the only course pages that exist, SPEC.md 9.1). */
export const COURSE_SLUGS_WITH_OUTINGS = [
  "az/arizona-biltmore-links-course",
  "az/encanto-golf-course",
  "az/mccormick-ranch-golf-club",
  "ca/riviera-country-club",
  "ca/torrey-pines-south-course",
  "ca/tpc-harding-park",
  "fl/rocky-point-golf-course",
  "ga/peachtree-golf-club",
  "il/medinah-country-club",
  "mo/whitmoor-country-club-north-course",
  "nj/baltusrol-golf-course",
  "nj/plainfield-country-club",
  "nj/the-ridgewood-country-club",
  "ny/bethpage-state-park-golf-courses",
  "ny/deepdale-golf-club",
  "ny/maidstone-club",
  "ny/metropolis-country-club",
  "ny/piping-rock-club",
  "ny/quaker-ridge-golf-club",
  "ny/winged-foot-golf-club",
  "pa/oakmont-country-club",
  "pa/philadelphia-country-club",
] as const;

/** Organizers with at least one published outing (e17's organizer has none). */
export const PUBLISHED_ORGANIZER_SLUGS = [
  "amateurgolf-com",
  "american-cancer-society",
  "autism-speaks",
  "bcny",
  "builders-institute",
  "fordham-university",
  "golf-with-access",
  "grady-dads-club",
  "guild-hall",
  "hope-and-heroes-childrens-cancer-fund",
  "hyslop-drive-fore-a-cure",
  "jack-martin-fund",
  "mariano-rivera-foundation",
  "mercy-care-foundation",
  "national-kidney-foundation",
  "north-shore-land-alliance",
  "nu-omicron-chapter-and-the-3l-foundation-inc",
  "pepperdine-university",
  "presbyterian-seniorcare-foundation",
  "rod-dedeaux-foundation",
  "ronald-mcdonald-house-charities-st-louis",
  "st-anthony-school-programs",
  "thesecondopinion",
  "valley-hospital-auxiliary",
  "westchester-community-health-center",
] as const;

/** States with a published outing. */
export const STATES_WITH_OUTINGS = ["az", "ca", "fl", "ga", "il", "mo", "nj", "ny", "pa"] as const;

/** Upcoming dated outings per state on 2026-09-28 (national hub counts). */
export const UPCOMING_BY_STATE: Readonly<Record<string, number>> = {
  AZ: 3,
  CA: 3,
  FL: 1,
  MO: 1,
  NY: 4,
  PA: 1,
};

/** Approximate course coordinates used by the /api/outings geometry checks. */
export const COORDS = {
  wingedFoot: { lat: 40.9624585, lng: -73.7538567 },
  metropolis: { lat: 41.0365771, lng: -73.8002207 },
  maidstone: { lat: 40.9523781, lng: -72.1805444 },
} as const;

/** A box around southern Westchester County, NY (west, south, east, north). */
export const WESTCHESTER_BBOX = { west: -73.95, south: 40.85, east: -73.5, north: 41.4 } as const;

/** e06: expected outing whose organizer is "Hope & Heroes Children's Cancer Fund". */
export const HOPE_HEROES_EXPECTED_SLUG = "2027/hope-and-heroes-golf-tournament-baltusrol";
