/**
 * "Near you" on the home page: asks for the browser's location only when the
 * visitor presses the button, then fetches /api/outings. Every value is written
 * with textContent; nothing from the response is parsed as HTML.
 */

interface OutingFeatureProps {
  url: string;
  title: string;
  course: string;
  place: string;
  when: string;
  time: string;
  courseType: string;
  label: string;
  price: string;
}

/** appendChild for each node (the Workers runtime types shadow DOM `append`). */
function add(parent: Node, ...kids: Node[]): void {
  for (const k of kids) parent.appendChild(k);
}

function isProps(v: unknown): v is OutingFeatureProps {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return ["url", "title", "course", "place", "when", "time", "courseType", "label", "price"].every(
    (k) => typeof r[k] === "string",
  ) && typeof r.url === "string" && r.url.startsWith("/outings/");
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function card(p: OutingFeatureProps): HTMLElement {
  const art = el("article", "near-card");
  const h = el("h3");
  const a = el("a", undefined, p.title);
  a.href = p.url;
  add(h, a);
  const course = el("p");
  add(course, el("strong", undefined, p.course), document.createTextNode(`, ${p.place}`));
  const when = el("p", undefined, p.time ? `${p.when}, ${p.time}` : p.when);
  const badges = el("p", "badges");
  add(badges, el("span", "badge type", p.courseType), document.createTextNode(" "), el("span", "badge", p.label));
  const price = el("p", "near-price", p.price);
  add(art, h, course, when, badges, price);
  return art;
}

export function initNearYou(): void {
  const button = document.querySelector<HTMLButtonElement>("[data-near-button]");
  const list = document.querySelector<HTMLElement>("[data-near-list]");
  const status = document.querySelector<HTMLElement>("[data-near-status]");
  if (!button || !list || !status) return;
  if (!("geolocation" in navigator)) {
    button.hidden = true;
    return;
  }
  button.addEventListener("click", () => {
    status.textContent = "Finding your location…";
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const lat = pos.coords.latitude.toFixed(3);
        const lng = pos.coords.longitude.toFixed(3);
        status.textContent = "Looking for outings within 100 miles…";
        try {
          const res = await fetch(`/api/outings?lat=${lat}&lng=${lng}&radius=100&limit=12`, {
            headers: { accept: "application/geo+json" },
          });
          if (!res.ok) throw new Error(String(res.status));
          const body: unknown = await res.json();
          const features =
            typeof body === "object" && body !== null && Array.isArray((body as { features?: unknown }).features)
              ? ((body as { features: unknown[] }).features)
              : [];
          const items = features
            .map((f) => (typeof f === "object" && f !== null ? (f as { properties?: unknown }).properties : null))
            .filter(isProps);
          list.replaceChildren(...items.map(card));
          status.textContent =
            items.length === 0
              ? "No upcoming outings within 100 miles yet. The national list below shows the soonest ones."
              : `${items.length} upcoming ${items.length === 1 ? "outing" : "outings"} within 100 miles, nearest first.`;
        } catch {
          status.textContent = "We couldn't load outings near you. The national list below still works.";
        }
      },
      () => {
        status.textContent = "Location is off, so here are the soonest outings nationwide. You can also search by city or ZIP.";
      },
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 600_000 },
    );
  });
}
