/**
 * MapLibre GL JS map of upcoming outings (SPEC.md 9.6): OpenFreeMap vector tiles,
 * clustered markers from /api/outings GeoJSON, both required attributions.
 * Loaded only on /map and behind the city-page toggle. Popups are built with DOM
 * text nodes; nothing from the API is parsed as HTML.
 */
import { AttributionControl, Map as MlMap, NavigationControl, Popup, setWorkerUrl, type GeoJSONSource, type LngLatLike } from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import cssUrl from "maplibre-gl/dist/maplibre-gl.css?url";
import { OSM_ATTRIBUTION_TEXT } from "@gof/shared/places";

const STYLE_URL = "https://tiles.openfreemap.org/styles/liberty";
const SOURCE = "outings";

setWorkerUrl(workerUrl);

export interface MountOptions {
  center?: LngLatLike;
  zoom?: number;
  /** Extra query string for /api/outings (filters). */
  query?: string;
  onCount?: (n: number) => void;
}

type FeatureCollection = { type: "FeatureCollection"; features: unknown[] };

function isFeatureCollection(v: unknown): v is FeatureCollection {
  return typeof v === "object" && v !== null && (v as { type?: unknown }).type === "FeatureCollection" && Array.isArray((v as { features?: unknown }).features);
}

/** appendChild for each node (the Workers runtime types shadow DOM `append`). */
function add(parent: Node, ...kids: Node[]): void {
  for (const k of kids) parent.appendChild(k);
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function popupContent(p: Record<string, unknown>): HTMLElement {
  const box = document.createElement("div");
  box.className = "map-popup";
  const a = document.createElement("a");
  const url = str(p.url);
  a.href = url.startsWith("/outings/") ? url : "#";
  a.textContent = str(p.title);
  const strong = document.createElement("strong");
  add(strong, a);
  const lines = [
    `${str(p.course)}, ${str(p.place)}`,
    str(p.time) ? `${str(p.when)}, ${str(p.time)}` : str(p.when),
    `${str(p.courseType)} · ${str(p.label)}`,
    str(p.price),
  ];
  add(box, strong);
  for (const line of lines) {
    const d = document.createElement("div");
    d.textContent = line;
    add(box, d);
  }
  return box;
}

/** Loads MapLibre's stylesheet as a file only when a map mounts (never inlined into pages). */
function loadCss(): Promise<void> {
  if (document.querySelector("link[data-maplibre-css]")) return Promise.resolve();
  return new Promise((resolve) => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = cssUrl;
    link.dataset.maplibreCss = "";
    link.addEventListener("load", () => resolve());
    link.addEventListener("error", () => resolve());
    add(document.head, link);
  });
}

export async function mountMap(container: HTMLElement, opts: MountOptions = {}): Promise<MlMap> {
  await loadCss();
  const map = new MlMap({
    container,
    style: STYLE_URL,
    center: opts.center ?? [-96.5, 38.5],
    zoom: opts.zoom ?? 3.4,
    attributionControl: false,
    cooperativeGestures: false,
  });
  map.addControl(new NavigationControl({ showCompass: false }), "top-right");
  map.addControl(
    // The OpenFreeMap style already credits "OpenFreeMap © OpenMapTiles Data from
    // OpenStreetMap"; add it only if a style ever stops doing so.
    new AttributionControl({ compact: false, customAttribution: [OSM_ATTRIBUTION_TEXT] }),
    "bottom-right",
  );

  let controller: AbortController | null = null;
  async function load(): Promise<void> {
    const b = map.getBounds();
    const bbox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]
      .map((n, i) => Math.max(i % 2 === 0 ? -180 : -90, Math.min(i % 2 === 0 ? 180 : 90, n)).toFixed(4))
      .join(",");
    controller?.abort();
    controller = new AbortController();
    try {
      const res = await fetch(`/api/outings?bbox=${bbox}${opts.query ? `&${opts.query}` : ""}`, { signal: controller.signal });
      if (!res.ok) return;
      const data: unknown = await res.json();
      if (!isFeatureCollection(data)) return;
      const src = map.getSource<GeoJSONSource>(SOURCE);
      // The API answers with GeoJSON points; MapLibre validates the geometry itself.
      src?.setData(data as unknown as Parameters<GeoJSONSource["setData"]>[0]);
      opts.onCount?.(data.features.length);
    } catch {
      // Aborted by a newer request, or offline; keep what is on the map.
    }
  }

  await new Promise<void>((resolve) => map.once("load", () => resolve()));

  map.addSource(SOURCE, {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] },
    cluster: true,
    clusterMaxZoom: 12,
    clusterRadius: 48,
  });
  map.addLayer({
    id: "clusters",
    type: "circle",
    source: SOURCE,
    filter: ["has", "point_count"],
    paint: {
      "circle-color": "#0d5c36",
      "circle-radius": ["step", ["get", "point_count"], 16, 10, 22, 50, 28],
      "circle-stroke-width": 2,
      "circle-stroke-color": "#ffffff",
    },
  });
  map.addLayer({
    id: "cluster-count",
    type: "symbol",
    source: SOURCE,
    filter: ["has", "point_count"],
    layout: { "text-field": "{point_count_abbreviated}", "text-size": 13, "text-font": ["Noto Sans Bold"] },
    paint: { "text-color": "#ffffff" },
  });
  map.addLayer({
    id: "outing-point",
    type: "circle",
    source: SOURCE,
    filter: ["!", ["has", "point_count"]],
    paint: { "circle-color": "#b35c00", "circle-radius": 8, "circle-stroke-width": 2, "circle-stroke-color": "#ffffff" },
  });

  map.on("click", "clusters", async (e) => {
    const f = map.queryRenderedFeatures(e.point, { layers: ["clusters"] })[0];
    const id = f?.properties?.cluster_id as number | undefined;
    if (!f || id === undefined || f.geometry.type !== "Point") return;
    const zoom = await map.getSource<GeoJSONSource>(SOURCE)?.getClusterExpansionZoom(id);
    map.easeTo({ center: f.geometry.coordinates as [number, number], zoom: zoom ?? map.getZoom() + 2 });
  });
  map.on("click", "outing-point", (e) => {
    const f = e.features?.[0];
    if (!f || f.geometry.type !== "Point") return;
    new Popup({ maxWidth: "280px" })
      .setLngLat(f.geometry.coordinates as [number, number])
      .setDOMContent(popupContent(f.properties ?? {}))
      .addTo(map);
  });
  for (const layer of ["clusters", "outing-point"]) {
    map.on("mouseenter", layer, () => (map.getCanvas().style.cursor = "pointer"));
    map.on("mouseleave", layer, () => (map.getCanvas().style.cursor = ""));
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  map.on("moveend", () => {
    clearTimeout(timer);
    timer = setTimeout(() => void load(), 250);
  });
  await load();
  return map;
}
