/**
 * JSON-LD builders for the site (SPEC.md v1.1 section 9.4): Event markup on outing
 * pages, BreadcrumbList on every page, ItemList on list pages. Pure functions over
 * plain inputs so they test offline; the zod models are what CI validates against.
 */
import { z } from "zod";
import { eventStartDate } from "./dates.ts";
import type { OutingStatus } from "./schemas.ts";

/** Statuses that carry Event markup; expected and past outings never do. */
export const EVENT_MARKUP_STATUSES = ["open", "waitlist", "sold_out", "cancelled"] as const satisfies readonly OutingStatus[];
export type EventMarkupStatus = (typeof EVENT_MARKUP_STATUSES)[number];

export interface EventJsonLdInput {
  /** Absolute canonical URL of the outing page. */
  url: string;
  title: string;
  summary: string | null;
  status: OutingStatus;
  startDate: string | null;
  endDate: string | null;
  shotgunTime: string | null;
  singlePriceCents: number | null;
  foursomePriceCents: number | null;
  registrationUrl: string | null;
  canonicalSourceUrl: string;
  course: {
    name: string;
    street: string | null;
    city: string | null;
    state: string;
    zip: string | null;
    lat: number;
    lng: number;
    timeZone: string;
  };
  organizer: { name: string; website: string | null } | null;
}

const EVENT_STATUS: Record<EventMarkupStatus, "https://schema.org/EventScheduled" | "https://schema.org/EventCancelled"> = {
  open: "https://schema.org/EventScheduled",
  waitlist: "https://schema.org/EventScheduled",
  sold_out: "https://schema.org/EventScheduled",
  cancelled: "https://schema.org/EventCancelled",
};

const AVAILABILITY: Record<
  EventMarkupStatus,
  | "https://schema.org/InStock"
  | "https://schema.org/LimitedAvailability"
  | "https://schema.org/SoldOut"
  | "https://schema.org/Discontinued"
> = {
  open: "https://schema.org/InStock",
  waitlist: "https://schema.org/LimitedAvailability",
  sold_out: "https://schema.org/SoldOut",
  cancelled: "https://schema.org/Discontinued",
};

function isMarkupStatus(s: OutingStatus): s is EventMarkupStatus {
  return (EVENT_MARKUP_STATUSES as readonly string[]).includes(s);
}

/** Cents to a schema.org price string ("125.00"). */
export function centsToPrice(cents: number): string {
  return (cents / 100).toFixed(2);
}

const isoDateRe = /^\d{4}-\d{2}-\d{2}$/;
const isoOffsetRe = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/;
const schemaUrl = (path: string) => z.literal(`https://schema.org/${path}`);

export const postalAddressSchema = z
  .object({
    "@type": z.literal("PostalAddress"),
    streetAddress: z.string().min(1).optional(),
    addressLocality: z.string().min(1).optional(),
    addressRegion: z.string().length(2),
    postalCode: z.string().min(1).optional(),
    addressCountry: z.literal("US"),
  })
  .strict();

export const offerSchema = z
  .object({
    "@type": z.literal("Offer"),
    name: z.string().min(1),
    price: z.string().regex(/^\d+\.\d{2}$/),
    priceCurrency: z.literal("USD"),
    url: z.string().url(),
    availability: z.union([
      schemaUrl("InStock"),
      schemaUrl("LimitedAvailability"),
      schemaUrl("SoldOut"),
      schemaUrl("Discontinued"),
    ]),
  })
  .strict();

/** The Event shape CI validates against (SPEC.md G3, section 11). */
export const eventJsonLdSchema = z
  .object({
    "@context": z.literal("https://schema.org"),
    "@type": z.literal("Event"),
    name: z.string().min(1),
    url: z.string().url(),
    startDate: z.string().refine((v) => isoDateRe.test(v) || isoOffsetRe.test(v), {
      message: "startDate must be YYYY-MM-DD or a timestamp with a UTC offset",
    }),
    endDate: z.string().regex(isoDateRe).optional(),
    eventStatus: z.union([schemaUrl("EventScheduled"), schemaUrl("EventCancelled")]),
    eventAttendanceMode: schemaUrl("OfflineEventAttendanceMode"),
    location: z
      .object({
        "@type": z.literal("Place"),
        name: z.string().min(1),
        address: postalAddressSchema,
        geo: z
          .object({ "@type": z.literal("GeoCoordinates"), latitude: z.number(), longitude: z.number() })
          .strict(),
      })
      .strict(),
    organizer: z
      .object({ "@type": z.literal("Organization"), name: z.string().min(1), url: z.string().url().optional() })
      .strict()
      .optional(),
    offers: z.array(offerSchema).min(1).optional(),
    description: z.string().min(1).max(300).optional(),
  })
  .strict();
export type EventJsonLd = z.infer<typeof eventJsonLdSchema>;

/**
 * Event markup for an outing page, or null when the outing gets none: expected and
 * past outings, and any outing without a known start date (SPEC.md 9.4, A2).
 */
export function buildEventJsonLd(o: EventJsonLdInput): EventJsonLd | null {
  if (!isMarkupStatus(o.status) || !o.startDate) return null;
  const status = o.status;
  const offerUrl = o.registrationUrl ?? o.canonicalSourceUrl;
  const offers: EventJsonLd["offers"] = [];
  if (o.singlePriceCents !== null) {
    offers.push({
      "@type": "Offer",
      name: "Single player",
      price: centsToPrice(o.singlePriceCents),
      priceCurrency: "USD",
      url: offerUrl,
      availability: AVAILABILITY[status],
    });
  }
  if (o.foursomePriceCents !== null) {
    offers.push({
      "@type": "Offer",
      name: "Foursome",
      price: centsToPrice(o.foursomePriceCents),
      priceCurrency: "USD",
      url: offerUrl,
      availability: AVAILABILITY[status],
    });
  }
  const address: z.infer<typeof postalAddressSchema> = {
    "@type": "PostalAddress",
    addressRegion: o.course.state,
    addressCountry: "US",
  };
  if (o.course.street) address.streetAddress = o.course.street;
  if (o.course.city) address.addressLocality = o.course.city;
  if (o.course.zip) address.postalCode = o.course.zip;

  const event: EventJsonLd = {
    "@context": "https://schema.org",
    "@type": "Event",
    name: o.title,
    url: o.url,
    startDate: eventStartDate(o.startDate, o.shotgunTime, o.course.timeZone),
    eventStatus: EVENT_STATUS[status],
    eventAttendanceMode: "https://schema.org/OfflineEventAttendanceMode",
    location: {
      "@type": "Place",
      name: o.course.name,
      address,
      geo: { "@type": "GeoCoordinates", latitude: o.course.lat, longitude: o.course.lng },
    },
  };
  if (o.endDate) event.endDate = o.endDate;
  if (o.organizer) {
    event.organizer = { "@type": "Organization", name: o.organizer.name };
    if (o.organizer.website) event.organizer.url = o.organizer.website;
  }
  if (offers.length > 0) event.offers = offers;
  if (o.summary) event.description = o.summary;
  return event;
}

export interface Crumb {
  name: string;
  /** Absolute URL. */
  url: string;
}

export const breadcrumbJsonLdSchema = z
  .object({
    "@context": z.literal("https://schema.org"),
    "@type": z.literal("BreadcrumbList"),
    itemListElement: z
      .array(
        z
          .object({
            "@type": z.literal("ListItem"),
            position: z.number().int().min(1),
            name: z.string().min(1),
            item: z.string().url(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();
export type BreadcrumbJsonLd = z.infer<typeof breadcrumbJsonLdSchema>;

export function buildBreadcrumbJsonLd(crumbs: readonly Crumb[]): BreadcrumbJsonLd {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: crumbs.map((c, i) => ({ "@type": "ListItem", position: i + 1, name: c.name, item: c.url })),
  };
}

export const itemListJsonLdSchema = z
  .object({
    "@context": z.literal("https://schema.org"),
    "@type": z.literal("ItemList"),
    itemListElement: z.array(
      z.object({ "@type": z.literal("ListItem"), position: z.number().int().min(1), url: z.string().url() }).strict(),
    ),
  })
  .strict();
export type ItemListJsonLd = z.infer<typeof itemListJsonLdSchema>;

/** ItemList of outing URLs on list pages. */
export function buildItemListJsonLd(urls: readonly string[]): ItemListJsonLd {
  return {
    "@context": "https://schema.org",
    "@type": "ItemList",
    itemListElement: urls.map((url, i) => ({ "@type": "ListItem", position: i + 1, url })),
  };
}

/**
 * Serializes JSON-LD for a `<script type="application/ld+json">` body. Escapes `<`,
 * `>`, `&` and the JS line separators so text from the database can never close the
 * script element or start markup, whatever it contains.
 */
export function serializeJsonLd(data: unknown): string {
  return JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}
