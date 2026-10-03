import { describe, expect, it } from "vitest";
import { loadFixtureDocs, syntheticHtml } from "./fixture-fetch.ts";

describe("loadFixtureDocs", () => {
  const docs = loadFixtureDocs();

  it("serves the hand-written stand-in where the recording is a 404 or a login wall", () => {
    const gc1 = docs.get("https://golfwithaccess.com/events/2026-access-palm-beach-golf-experience");
    expect(gc1?.status).toBe(200);
    expect(gc1?.body).toMatch(/Palm Beach/);
    const gc5 = docs.get("https://scramblehunter.com/event/grady-charity-golf-scramble-2026/");
    expect(gc5?.body).toMatch(/\$150/);
  });

  it("serves the synthetic gc7 page at its .invalid stand-in URL", () => {
    expect(docs.get("https://fixtures.invalid/s15-synthetic-oakmont-glendale")?.body).toMatch(/Glendale/);
  });

  it("keeps recorded pages and the discovery fixtures", () => {
    expect(docs.get("https://azgolf.org/charity-club-sanctioned-events")?.status).toBe(200);
    expect(docs.has("https://scramblehunter.com/")).toBe(true);
  });
});

describe("syntheticHtml", () => {
  it("escapes the text and keeps JSON-LD inert inside its script tag", () => {
    const html = syntheticHtml("A <b>bold</b> & plain day\nSecond line", [{ name: "</script><x>" }]);
    expect(html).toContain("<p>A &lt;b&gt;bold&lt;/b&gt; &amp; plain day</p>");
    expect(html).toContain("<p>Second line</p>");
    expect(html).not.toContain("</script><x>");
  });
});
