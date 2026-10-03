import { describe, expect, it } from "vitest";
import {
  breadcrumbJsonLdSchema,
  buildBreadcrumbJsonLd,
  buildEventJsonLd,
  buildItemListJsonLd,
  eventJsonLdSchema,
  itemListJsonLdSchema,
  serializeJsonLd,
  type EventJsonLdInput,
} from "./jsonld.ts";

/** gc8: the NKF Golf Classic at Winged Foot as the seed loader stores it. */
const nkf: EventJsonLdInput = {
  url: "https://golfoutingfinder.com/outings/2026/nkf-golf-classic-at-winged-foot-golf-club-winged-foot",
  title: "NKF Golf Classic at Winged Foot Golf Club",
  summary: null,
  status: "open",
  startDate: "2026-10-19",
  endDate: null,
  shotgunTime: "12:00",
  singlePriceCents: null,
  foursomePriceCents: null,
  registrationUrl: "https://support.kidney.org/event/2026-nkf-golf-classic-at-winged-foot-golf-club/e766893",
  canonicalSourceUrl: "https://support.kidney.org/event/2026-nkf-golf-classic-at-winged-foot-golf-club/e766893",
  course: {
    name: "Winged Foot Golf Club",
    street: "851 Fenimore Road",
    city: "Mamaroneck",
    state: "NY",
    zip: "10543",
    lat: 40.95,
    lng: -73.75,
    timeZone: "America/New_York",
  },
  organizer: { name: "National Kidney Foundation", website: null },
};

describe("buildEventJsonLd", () => {
  it("gives the NKF Winged Foot outing a startDate with the course's -04:00 offset", () => {
    const e = buildEventJsonLd(nkf);
    expect(e?.startDate).toBe("2026-10-19T12:00:00-04:00");
    expect(eventJsonLdSchema.safeParse(e).success).toBe(true);
  });

  it("uses a date-only startDate when the shotgun time is unknown", () => {
    expect(buildEventJsonLd({ ...nkf, shotgunTime: null })?.startDate).toBe("2026-10-19");
  });

  it("uses the winter offset in December", () => {
    const e = buildEventJsonLd({ ...nkf, startDate: "2026-12-15", shotgunTime: "08:30" });
    expect(e?.startDate).toBe("2026-12-15T08:30:00-05:00");
  });

  it("uses Arizona's fixed offset", () => {
    const e = buildEventJsonLd({
      ...nkf,
      startDate: "2026-10-03",
      shotgunTime: "07:00",
      course: { ...nkf.course, timeZone: "America/Phoenix", state: "AZ" },
    });
    expect(e?.startDate).toBe("2026-10-03T07:00:00-07:00");
  });

  it("sets endDate only when end_date exists", () => {
    expect(buildEventJsonLd(nkf)).not.toHaveProperty("endDate");
    const e = buildEventJsonLd({ ...nkf, startDate: "2026-12-15", endDate: "2026-12-18", shotgunTime: null });
    expect(e?.endDate).toBe("2026-12-18");
    expect(eventJsonLdSchema.safeParse(e).success).toBe(true);
  });

  it("adds offers only when a price exists", () => {
    expect(buildEventJsonLd(nkf)).not.toHaveProperty("offers");
    const e = buildEventJsonLd({ ...nkf, singlePriceCents: 15000, foursomePriceCents: 60000 });
    expect(e?.offers).toEqual([
      {
        "@type": "Offer",
        name: "Single player",
        price: "150.00",
        priceCurrency: "USD",
        url: nkf.registrationUrl,
        availability: "https://schema.org/InStock",
      },
      {
        "@type": "Offer",
        name: "Foursome",
        price: "600.00",
        priceCurrency: "USD",
        url: nkf.registrationUrl,
        availability: "https://schema.org/InStock",
      },
    ]);
    expect(eventJsonLdSchema.safeParse(e).success).toBe(true);
  });

  it("falls back to the source URL for the offer when there is no registration URL", () => {
    const e = buildEventJsonLd({ ...nkf, registrationUrl: null, singlePriceCents: 12500 });
    expect(e?.offers?.[0]?.url).toBe(nkf.canonicalSourceUrl);
  });

  it.each([
    ["open", "https://schema.org/EventScheduled", "https://schema.org/InStock"],
    ["waitlist", "https://schema.org/EventScheduled", "https://schema.org/LimitedAvailability"],
    ["sold_out", "https://schema.org/EventScheduled", "https://schema.org/SoldOut"],
    ["cancelled", "https://schema.org/EventCancelled", "https://schema.org/Discontinued"],
  ] as const)("maps status %s", (status, eventStatus, availability) => {
    const e = buildEventJsonLd({ ...nkf, status, singlePriceCents: 10000 });
    expect(e?.eventStatus).toBe(eventStatus);
    expect(e?.offers?.[0]?.availability).toBe(availability);
    expect(e?.eventAttendanceMode).toBe("https://schema.org/OfflineEventAttendanceMode");
  });

  it("gives expected outings no markup, even with an announced date (A2)", () => {
    expect(buildEventJsonLd({ ...nkf, status: "expected" })).toBeNull();
    expect(buildEventJsonLd({ ...nkf, status: "expected", startDate: null })).toBeNull();
  });

  it("gives past outings no markup", () => {
    expect(buildEventJsonLd({ ...nkf, status: "past" })).toBeNull();
  });

  it("builds a Place with a PostalAddress and omits unknown address parts", () => {
    const e = buildEventJsonLd({ ...nkf, course: { ...nkf.course, street: null, zip: null } });
    expect(e?.location.address).toEqual({
      "@type": "PostalAddress",
      addressLocality: "Mamaroneck",
      addressRegion: "NY",
      addressCountry: "US",
    });
  });

  it("uses the summary as description and the organizer as an Organization", () => {
    const e = buildEventJsonLd({
      ...nkf,
      summary: "A shotgun scramble that raises money for kidney patients.",
      organizer: { name: "National Kidney Foundation", website: "https://www.kidney.org" },
    });
    expect(e?.description).toBe("A shotgun scramble that raises money for kidney patients.");
    expect(e?.organizer).toEqual({ "@type": "Organization", name: "National Kidney Foundation", url: "https://www.kidney.org" });
    expect(eventJsonLdSchema.safeParse(e).success).toBe(true);
  });
});

describe("breadcrumbs and item lists", () => {
  it("numbers breadcrumb positions from 1", () => {
    const b = buildBreadcrumbJsonLd([
      { name: "Home", url: "https://x.test/" },
      { name: "New York", url: "https://x.test/golf-outings/ny" },
    ]);
    expect(b.itemListElement.map((i) => i.position)).toEqual([1, 2]);
    expect(breadcrumbJsonLdSchema.safeParse(b).success).toBe(true);
  });

  it("lists outing URLs", () => {
    const l = buildItemListJsonLd(["https://x.test/outings/2026/a", "https://x.test/outings/2026/b"]);
    expect(l.itemListElement[1]).toEqual({ "@type": "ListItem", position: 2, url: "https://x.test/outings/2026/b" });
    expect(itemListJsonLdSchema.safeParse(l).success).toBe(true);
  });
});

describe("serializeJsonLd", () => {
  it("cannot close the script element", () => {
    const s = serializeJsonLd({ name: "</script><script>alert(1)</script> &  " });
    expect(s).not.toContain("<");
    expect(s).not.toContain(">");
    expect(s).not.toContain("&");
    expect(JSON.parse(s)).toEqual({ name: "</script><script>alert(1)</script> &  " });
  });
});
