import type { APIRoute } from "astro";
import { BUILD_VERSION } from "../lib/env.ts";

export const prerender = false;

/** Uptime check (SPEC.md 9.1): `{ "ok": true }` plus the build version, never cached. */
export const GET: APIRoute = () =>
  new Response(JSON.stringify({ ok: true, version: BUILD_VERSION }), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-robots-tag": "noindex",
    },
  });
