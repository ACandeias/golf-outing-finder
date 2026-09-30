const DIACRITICS = /[̀-ͯ]/g;
const NON_ALNUM = /[^a-z0-9]+/g;
const EDGE_HYPHENS = /^-+|-+$/g;

export function kebab(input: string): string {
  return input
    .normalize("NFKD")
    .replace(DIACRITICS, "")
    .toLowerCase()
    .replace(NON_ALNUM, "-")
    .replace(EDGE_HYPHENS, "");
}

export function courseSlug(state: string, name: string, city?: string | null): string {
  const base = `${state.toLowerCase()}/${kebab(name)}`;
  return city ? `${base}-${kebab(city)}` : base;
}

export function outingSlug(year: number, title: string, courseShortSlug: string): string {
  const titleNoYear = title.replace(new RegExp(`\\b${year}\\b`, "g"), "").trim();
  return `${year}/${kebab(titleNoYear)}-${courseShortSlug}`;
}

export function shortCourseSlug(courseSlug: string): string {
  const slash = courseSlug.indexOf("/");
  return slash === -1 ? courseSlug : courseSlug.slice(slash + 1);
}
