/**
 * zod models of the structured data SPEC.md v1.1 section 9.4 requires, written
 * from the spec (not from the site's builder) so the suite checks the site
 * against the spec: Event on outing pages with Event markup, BreadcrumbList on
 * every page, ItemList on list pages. G3: "CI checks the markup against a zod
 * model of the Event shape".
 */
import { z } from "zod";

const SCHEMA_ORG = /^https?:\/\/schema\.org\/?$/;
const schemaEnum = (...names: string[]) =>
  z.string().refine((v) => names.some((n) => v === `https://schema.org/${n}` || v === `http://schema.org/${n}`), {
    message: `must be one of schema.org ${names.join(", ")}`,
  });

export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** 9.4: "startDate with the course's UTC offset when shotgun_time is known". */
export const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?([+-]\d{2}:\d{2})$/;

const absUrl = z.string().url().refine((u) => /^https?:\/\//.test(u), "must be an absolute http(s) URL");

/** 9.4: "location as a Place with a PostalAddress". */
export const PostalAddressModel = z
  .object({
    "@type": z.literal("PostalAddress"),
    streetAddress: z.string().min(1).optional(),
    addressLocality: z.string().min(1).optional(),
    addressRegion: z.string().regex(/^[A-Z]{2}$/),
    postalCode: z.string().min(1).optional(),
    addressCountry: z.union([z.literal("US"), z.object({ "@type": z.literal("Country"), name: z.literal("US") })]).optional(),
  })
  .passthrough();

export const PlaceModel = z
  .object({ "@type": z.literal("Place"), name: z.string().min(1), address: PostalAddressModel })
  .passthrough();

/** 9.4: "offers with price, USD, registration URL and availability". */
export const OfferModel = z
  .object({
    "@type": z.literal("Offer"),
    price: z.union([z.number().nonnegative(), z.string().regex(/^\d+(\.\d+)?$/)]),
    priceCurrency: z.literal("USD"),
    url: absUrl,
    availability: schemaEnum("InStock", "LimitedAvailability", "SoldOut", "Discontinued", "PreOrder", "OutOfStock"),
  })
  .passthrough();

export const OrganizerModel = z
  .object({ "@type": z.enum(["Organization", "Person"]), name: z.string().min(1), url: absUrl.optional() })
  .passthrough();

/** 9.4 Event JSON-LD. */
export const EventModel = z
  .object({
    "@type": z.literal("Event"),
    name: z.string().min(1),
    startDate: z.string().refine((v) => ISO_DATE.test(v) || ISO_WITH_OFFSET.test(v), {
      message: "startDate must be YYYY-MM-DD or a local time with a UTC offset",
    }),
    endDate: z.string().regex(ISO_DATE).optional(),
    eventStatus: schemaEnum("EventScheduled", "EventCancelled", "EventPostponed", "EventRescheduled"),
    eventAttendanceMode: schemaEnum("OfflineEventAttendanceMode"),
    location: PlaceModel,
    organizer: OrganizerModel.optional(),
    offers: z.union([OfferModel, z.array(OfferModel).min(1)]).optional(),
    // "the summary as description"; summaries are at most 300 characters (7.1).
    description: z.string().min(1).max(300),
  })
  .passthrough();
export type EventLd = z.infer<typeof EventModel>;

const ListItemModel = z
  .object({
    "@type": z.literal("ListItem"),
    position: z.number().int().positive(),
    name: z.string().min(1).optional(),
    item: z.union([absUrl, z.object({ "@id": absUrl.optional(), url: absUrl.optional() }).passthrough()]).optional(),
    url: absUrl.optional(),
  })
  .passthrough();

/** 9.4: "BreadcrumbList on every page". */
export const BreadcrumbListModel = z
  .object({
    "@type": z.literal("BreadcrumbList"),
    itemListElement: z.array(ListItemModel.extend({ name: z.string().min(1) })).min(1),
  })
  .passthrough()
  .superRefine((v, ctx) => {
    v.itemListElement.forEach((li, i) => {
      if (li.position !== i + 1) ctx.addIssue({ code: "custom", message: `breadcrumb ${i} has position ${li.position}` });
    });
  });

/** 9.4: "ItemList of outing URLs on list pages". */
export const ItemListModel = z
  .object({ "@type": z.literal("ItemList"), itemListElement: z.array(ListItemModel) })
  .passthrough();

export type JsonLdNode = Record<string, unknown> & { "@type"?: unknown };

/**
 * Parses every JSON-LD block and flattens arrays and `@graph` into one list of
 * typed nodes. Throws on a block that is not valid JSON or has no schema.org
 * `@context`.
 */
export function parseJsonLd(blocks: readonly string[]): JsonLdNode[] {
  const nodes: JsonLdNode[] = [];
  for (const raw of blocks) {
    const parsed: unknown = JSON.parse(raw);
    const roots = Array.isArray(parsed) ? parsed : [parsed];
    for (const root of roots) {
      if (typeof root !== "object" || root === null) throw new Error("JSON-LD root is not an object");
      const r = root as Record<string, unknown>;
      const ctx = r["@context"];
      if (typeof ctx !== "string" || !SCHEMA_ORG.test(ctx)) throw new Error(`JSON-LD @context is ${String(ctx)}`);
      const graph = r["@graph"];
      if (Array.isArray(graph)) {
        for (const g of graph) if (typeof g === "object" && g !== null) nodes.push(g as JsonLdNode);
      } else {
        nodes.push(r as JsonLdNode);
      }
    }
  }
  return nodes;
}

export function nodesOfType(nodes: readonly JsonLdNode[], type: string): JsonLdNode[] {
  return nodes.filter((n) => n["@type"] === type || (Array.isArray(n["@type"]) && n["@type"].includes(type)));
}

/** URLs an ItemList points at, whichever of `url`, `item` or `item.url` it uses. */
export function itemListUrls(list: z.infer<typeof ItemListModel>): string[] {
  return list.itemListElement.flatMap((li) => {
    if (li.url) return [li.url];
    if (typeof li.item === "string") return [li.item];
    if (li.item && typeof li.item === "object") {
      const u = li.item.url ?? li.item["@id"];
      return u ? [u] : [];
    }
    return [];
  });
}

export function offersOf(e: EventLd): z.infer<typeof OfferModel>[] {
  if (!e.offers) return [];
  return Array.isArray(e.offers) ? e.offers : [e.offers];
}
