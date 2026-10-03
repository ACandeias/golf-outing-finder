/**
 * "Near you" on the home page: asks for the browser's location only when the
 * visitor presses the button, then fetches /api/outings. Every value is written
 * with textContent; nothing from the response is parsed as HTML.
 */

import { dateBlock } from "../lib/date-block.ts";

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
  status: string;
  startDate: string | null;
  registrationUrl: string | null;
}

/** appendChild for each node (the Workers runtime types shadow DOM `append`). */
function add(parent: Node, ...kids: Node[]): void {
  for (const k of kids) parent.appendChild(k);
}

function isProps(v: unknown): v is OutingFeatureProps {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  const strOrNull = (k: string) => r[k] === null || r[k] === undefined || typeof r[k] === "string";
  return (
    ["url", "title", "course", "place", "when", "time", "courseType", "label", "price", "status"].every(
      (k) => typeof r[k] === "string",
    ) &&
    strOrNull("startDate") &&
    strOrNull("registrationUrl") &&
    typeof r.url === "string" &&
    r.url.startsWith("/outings/")
  );
}

/** Only http(s) registration links become hrefs; anything else falls back to our outing page. */
function safeHttpUrl(v: string | null): string | null {
  if (!v) return null;
  try {
    const u = new URL(v);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
  } catch {
    return null;
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** One tee sheet row, the same markup as TeeSheetRow.astro (text only, no HTML parsing). */
function row(p: OutingFeatureProps): HTMLElement {
  const li = el("li", "tee-row");
  const d = dateBlock({ status: p.status, startDate: p.startDate ?? null });
  const date = el("p", "tee-date data");
  date.setAttribute("aria-hidden", "true");
  add(date, el("span", "tee-date-top", d.top), el("span", "tee-date-big", d.big), el("span", "tee-date-bottom", d.bottom));

  const main = el("div", "tee-main");
  const h = el("h3", "tee-title");
  const a = el("a", undefined, p.title);
  a.href = p.url;
  add(h, a);
  const course = el("p", "tee-course data");
  add(course, el("span", "visually-hidden", `${p.when}. `), document.createTextNode(`${p.course}, ${p.place}`));
  if (p.time) add(course, el("span", "tee-time", `, ${p.time}`));
  const labels = el("p", "labels");
  add(labels, el("span", "label", p.courseType), el("span", "label", p.label));
  if (p.status === "waitlist") add(labels, el("span", "label", "Waitlist"));
  if (p.status === "sold_out") add(labels, el("span", "label alert", "Sold out"));
  add(main, h, course, labels);

  const price = el("p", /^\$/.test(p.price) ? "tee-price data" : "tee-price data tee-price-unknown");
  p.price.split(", ").forEach((line, i) => {
    const span = el("span");
    if (i > 0) add(span, el("span", "visually-hidden", ", "));
    add(span, document.createTextNode(line));
    add(price, span);
  });

  const action = el("div", "tee-action");
  const reg = safeHttpUrl(p.registrationUrl);
  const btn = el("a", reg ? "button" : "button secondary", reg ? "Register" : "Details");
  btn.href = reg ?? p.url;
  if (reg) {
    btn.rel = "nofollow noopener";
    btn.target = "_blank";
  }
  add(btn, el("span", "visually-hidden", reg ? ` for ${p.title} (opens the organizer's site)` : ` for ${p.title}`));
  add(action, btn);

  add(li, date, main, price, action);
  return li;
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
          list.replaceChildren(...items.map(row));
          status.textContent =
            items.length === 0
              ? "No upcoming outings within 100 miles yet. The list above shows the soonest ones nationwide."
              : `${items.length} upcoming ${items.length === 1 ? "outing" : "outings"} within 100 miles, nearest first.`;
        } catch {
          status.textContent = "We couldn't load outings near you. The national list above still works.";
        }
      },
      () => {
        status.textContent = "Location is off, so here are the soonest outings nationwide. You can also search by city or ZIP.";
      },
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 600_000 },
    );
  });
}
