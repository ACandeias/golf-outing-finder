import { hostOf, registrableDomain, registrableDomainOf } from "./domain.ts";

interface CanonicalInput {
  source_url: string;
  registration_url: string | null;
  directory_host: string | null;
}

/**
 * The URL an outing found on one page is canonically about (SPEC.md 8.2 item 6,
 * 8.7): a directory event page whose registration link leaves the directory
 * points at the registration page; any other page is its own source.
 */
export function canonicalUrlFor(e: CanonicalInput): string {
  if (e.directory_host && e.registration_url) {
    const reg = hostOf(e.registration_url);
    if (reg && registrableDomain(reg) !== registrableDomain(e.directory_host)) return e.registration_url;
  }
  return e.source_url;
}

/** "Organizer domain" (SPEC.md 8.5): the registrable domain of the canonical source URL. */
export function organizerDomainFor(e: CanonicalInput): string {
  return registrableDomainOf(canonicalUrlFor(e)) ?? "";
}
