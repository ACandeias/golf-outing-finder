import { describe, expect, it } from "vitest";
import { findAboutLink, htmlToText } from "./site-text.ts";

describe("htmlToText", () => {
  it("drops scripts, styles and tags, decodes entities and collapses whitespace", () => {
    const html = `<html><head><style>p{}</style><script>alert("x")</script></head>
      <body><nav>Home</nav><p>Open&nbsp;to the   public &amp; friends</p><!-- hidden --><p>Tee&#39;s &#x2014; here</p></body></html>`;
    expect(htmlToText(html)).toBe("Home\nOpen to the public & friends\nTee's — here");
  });

  it("caps the length", () => {
    expect(htmlToText(`<p>${"a".repeat(50)}</p>`, 10)).toBe("a".repeat(10));
  });
});

describe("findAboutLink", () => {
  const base = "https://www.example-golf.com/";
  it("prefers a membership page, then about, on the same site", () => {
    const html = `
      <a href="https://other.com/membership">Other site</a>
      <a href="/about-us">About Us</a>
      <a href='/club/membership-info'>Membership</a>
      <a href="mailto:pro@example-golf.com">Email</a>`;
    expect(findAboutLink(html, base)).toBe("https://www.example-golf.com/club/membership-info");
  });

  it("matches on the path when the label is an image, and ignores PDFs and the homepage", () => {
    const html = `<a href="/"><img alt=""></a><a href="/files/about.pdf">About</a><a href="/our-history"><img></a>`;
    expect(findAboutLink(html, base)).toBe("https://www.example-golf.com/our-history");
  });

  it("accepts the bare host for a www homepage and returns null when nothing fits", () => {
    expect(findAboutLink(`<a href="https://example-golf.com/rates">Rates</a>`, base)).toBe(
      "https://example-golf.com/rates",
    );
    expect(findAboutLink(`<a href="/events">Events</a>`, base)).toBeNull();
    expect(findAboutLink(`<a href="javascript:void(0)">About</a>`, base)).toBeNull();
  });
});
