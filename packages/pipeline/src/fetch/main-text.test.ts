import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../lib/paths.ts";
import { extractJsonLd, jsonLdEvents, mainText, pdfMainText } from "./main-text.ts";

const RAW = join(REPO_ROOT, "tests/fixtures/raw");
const PAGES = join(REPO_ROOT, "tests/fixtures/pages");

describe("golden: tests/fixtures/raw/*.html normalize to tests/fixtures/pages/*.json", () => {
  const ids = readdirSync(RAW)
    .filter((f) => f.endsWith(".html"))
    .map((f) => f.replace(/\.html$/, ""));

  it("has a raw page for every recorded (non-synthetic) page", () => {
    expect(ids.length).toBeGreaterThanOrEqual(14);
  });

  for (const id of ids) {
    it(id, () => {
      const html = readFileSync(join(RAW, `${id}.html`), "utf8");
      const page = JSON.parse(readFileSync(join(PAGES, `${id}.json`), "utf8")) as {
        text: string;
        jsonld: unknown[];
      };
      expect(mainText(html)).toBe(page.text);
      expect(extractJsonLd(html)).toEqual(page.jsonld);
    });
  }
});

describe("mainText", () => {
  it("unhides accordion panels and keeps their text", () => {
    const html = `<html><body><h1>Events</h1>${"<p>intro text that is long enough. </p>".repeat(3)}
      <div aria-hidden="true"><p>Date: Saturday, October 3rd, 2026. Location: Encanto 18.</p></div>
      <div hidden><p>Hidden panel two</p></div></body></html>`;
    const t = mainText(html);
    expect(t).toContain("Encanto 18");
    expect(t).toContain("Hidden panel two");
  });

  it("drops scripts, styles, nav and forms in the body fallback", () => {
    const t = mainText(
      "<html><body><nav>Menu</nav><script>var x=1</script><style>p{}</style><p>Golf outing</p><form>Email</form></body></html>",
    );
    expect(t).toBe("Golf outing");
  });

  it("truncates at 12,000 characters", () => {
    const html = `<html><body>${"<p>Scramble with lunch and contests included. </p>".repeat(600)}</body></html>`;
    expect(mainText(html).length).toBe(12_000);
  });
});

describe("pdfMainText", () => {
  it("tidies whitespace and truncates", () => {
    expect(pdfMainText("  A   flyer \n\n\n\n line  ")).toBe("A flyer\n\nline");
    expect(pdfMainText("x".repeat(20_000))).toHaveLength(12_000);
  });
});

describe("jsonLdEvents", () => {
  it("reads name, local date and time, and location from an Event", () => {
    expect(
      jsonLdEvents([
        {
          "@context": "https://schema.org",
          "@type": "SportsEvent",
          name: "NKF Golf Classic",
          startDate: "2026-10-19T10:00:00-04:00",
          location: {
            "@type": "Place",
            name: "Winged Foot Golf Club",
            address: {
              "@type": "PostalAddress",
              streetAddress: "851 Fenimore Rd",
              addressLocality: "Mamaroneck",
              addressRegion: "NY",
              postalCode: "10543",
            },
          },
        },
      ]),
    ).toEqual([
      {
        name: "NKF Golf Classic",
        start_date: "2026-10-19",
        start_time: "10:00",
        location_name: "Winged Foot Golf Club",
        location_address: "851 Fenimore Rd, Mamaroneck, NY 10543",
      },
    ]);
  });

  it("finds events in @graph, arrays and ItemLists, and ignores other types", () => {
    const ev = (name: string) => ({ "@type": "Event", name, startDate: "2026-11-07" });
    const out = jsonLdEvents([
      { "@graph": [{ "@type": "Organization", name: "Org" }, ev("A")] },
      [ev("B")],
      { "@type": "ItemList", itemListElement: [{ "@type": "ListItem", item: ev("C") }] },
      { "@type": "WebPage", name: "Not an event" },
    ]);
    expect(out.map((e) => e.name)).toEqual(["A", "B", "C"]);
    expect(out[0]).toMatchObject({ start_date: "2026-11-07", start_time: null, location_name: null });
  });

  it("treats a midnight UTC timestamp as a date only and skips virtual locations", () => {
    const [e] = jsonLdEvents([
      {
        "@type": "Event",
        name: "X",
        startDate: "2026-10-13T00:00:00Z",
        location: [{ "@type": "VirtualLocation", url: "https://x" }, "Fordham Golf"],
      },
    ]);
    expect(e).toMatchObject({ start_date: "2026-10-13", start_time: null, location_name: "Fordham Golf" });
  });

  it("returns nothing for junk", () => {
    expect(jsonLdEvents([null, 3, "x", { "@type": "Event", startDate: "soon" }])).toEqual([
      { name: null, start_date: null, start_time: null, location_name: null, location_address: null },
    ]);
  });
});
