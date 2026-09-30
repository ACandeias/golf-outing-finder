/// <reference path="../.astro/types.d.ts" />
/// <reference types="astro/client" />

type Runtime = import("@astrojs/cloudflare").Runtime<Env>;

interface Env {
  DB: D1Database;
  PUBLIC_SITE_URL: string;
  ADS_PROVIDER: "adsense" | "journey" | "raptive";
  PUBLIC_ADSENSE_CLIENT: string;
  PUBLIC_GA4_ID: string;
  TURNSTILE_SECRET?: string;
}

declare namespace App {
  interface Locals extends Runtime {}
}
