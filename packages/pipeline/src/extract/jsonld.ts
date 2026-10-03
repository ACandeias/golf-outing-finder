/** schema.org Event blocks from a page's JSON-LD, for the extraction request. */

const DROP_KEYS = new Set(["image", "logo", "sameAs", "potentialAction", "@context"]);

function isEventType(t: unknown): boolean {
  const types = Array.isArray(t) ? t : [t];
  return types.some((x) => typeof x === "string" && /Event$/.test(x));
}

function prune(value: unknown, depth: number): unknown {
  if (depth > 6) return null;
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => prune(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) if (!DROP_KEYS.has(k)) out[k] = prune(v, depth + 1);
    return out;
  }
  return value;
}

/** Every object whose @type ends in "Event" (Event, SportsEvent, ...), at any depth, pruned. */
export function eventJsonLd(blocks: readonly unknown[]): unknown[] {
  const found: unknown[] = [];
  const walk = (v: unknown, depth: number): void => {
    if (depth > 8 || found.length >= 10) return;
    if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1);
      return;
    }
    if (!v || typeof v !== "object") return;
    const o = v as Record<string, unknown>;
    if (isEventType(o["@type"])) {
      found.push(prune(o, 0));
      return;
    }
    for (const x of Object.values(o)) walk(x, depth + 1);
  };
  walk(blocks, 0);
  return found;
}
