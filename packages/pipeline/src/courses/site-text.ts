/**
 * Plain text and the "about or membership" link from a course homepage
 * (SPEC.md 8.1 step 4.3). Deliberately small: course sites only need enough
 * text for a type decision, and none of it is ever rendered as HTML. The text is
 * untrusted and only goes to the classifier inside a <page> element.
 */

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  rsquo: "'",
  lsquo: "'",
  ldquo: '"',
  rdquo: '"',
  ndash: "-",
  mdash: "-",
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code =
        e[1]?.toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000
        ? String.fromCodePoint(code)
        : " ";
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Visible-ish text: drops script, style, noscript, svg, template and comments; collapses whitespace. */
export function htmlToText(html: string, max = 20_000): string {
  const text = html
    .slice(0, 2_000_000)
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template|iframe)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<\/?(p|div|br|li|h[1-6]|tr|section|article|header|footer|nav)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  return decodeEntities(text)
    .replace(/[ \t\f\v\r]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim()
    .slice(0, max);
}

/** Link words in priority order: membership says the most about access, then about, then rates. */
const LINK_RULES: readonly RegExp[] = [
  /\bmembership\b|\bmember(s|ship)?[-_ ]?(info|information|benefits)?\b|\bjoin\b/i,
  /\babout\b|\bour[-_ ]?(club|course|history)\b|\bhistory\b|\bthe[-_ ]club\b/i,
  /\brates?\b|\bgreen[-_ ]?fees?\b|\btee[-_ ]?times?\b|\bpublic\b/i,
];

function registrable(host: string): string {
  return host.toLowerCase().replace(/^www\./, "");
}

/**
 * The best same-site link to an about or membership page, or null. Only http(s)
 * links on the homepage's own host (www. ignored) are considered.
 */
export function findAboutLink(html: string, baseUrl: string): string | null {
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return null;
  }
  const home = registrable(base.hostname);
  const candidates: { url: string; rank: number; order: number }[] = [];
  const re = /<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a\s*>/gi;
  let m: RegExpExecArray | null;
  let order = 0;
  while ((m = re.exec(html)) !== null && order < 2000) {
    order++;
    const href = decodeEntities((m[1] ?? m[2] ?? m[3] ?? "").trim());
    const label = htmlToText(m[4] ?? "", 200);
    let u: URL;
    try {
      u = new URL(href, base);
    } catch {
      continue;
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") continue;
    if (registrable(u.hostname) !== home) continue;
    u.hash = "";
    if (u.toString() === new URL(base.toString().split("#")[0]!).toString()) continue;
    if (/\.(pdf|jpe?g|png|gif|zip|docx?)$/i.test(u.pathname)) continue;
    const hay = `${label} ${decodeURIComponent(u.pathname).replace(/[/_-]+/g, " ")}`;
    const rank = LINK_RULES.findIndex((r) => r.test(hay));
    if (rank >= 0) candidates.push({ url: u.toString(), rank, order });
  }
  candidates.sort((a, b) => a.rank - b.rank || a.order - b.order);
  return candidates[0]?.url ?? null;
}
