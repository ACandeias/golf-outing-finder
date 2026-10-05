/**
 * e2e harness (SPEC.md v1.1 section 11, plan Part 5 "Agent 1C").
 *
 *   1. pick a free port (or E2E_PORT)
 *   2. `pnpm run db:migrate:local --persist-to <tmp>` and
 *      `pnpm run seed --persist-to=<tmp>` with PIPELINE_NOW pinned, into a
 *      throwaway D1 state directory, so a developer's own local D1 is untouched
 *   3. `pnpm build` with PUBLIC_SITE_URL set to the server's origin and
 *      NODE_ENV=development, which builds draft guides too (skip with
 *      E2E_SKIP_BUILD=1 when dist/ is fresh)
 *   4. `wrangler dev --local` from apps/site with NODE_ENV=development,
 *      SITE_NOW=2026-09-28, PUBLIC_SITE_URL=<origin>, and test values for
 *      INDEXNOW_KEY, the two site-verification vars and the ads and GA4 vars
 *      (support/ads-facts.ts)
 *   5. wait for /health, export E2E_BASE_URL for the workers
 *
 * Returns the teardown: kill wrangler's process group, delete the D1 directory
 * (keep it with E2E_KEEP_D1=1). With E2E_BASE_URL already set, it does nothing and
 * the suite runs against that server.
 *
 * Offline: no step touches the network. The seed reads committed fixtures.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SITE_NOW } from "./support/seed-facts.ts";
import {
  E2E_BING_VERIFICATION,
  E2E_GOOGLE_VERIFICATION,
  E2E_INDEXNOW_KEY,
} from "./support/guide-facts.ts";
import {
  E2E_ADSENSE_CLIENT,
  E2E_ADSENSE_SLOT_LIST,
  E2E_ADSENSE_SLOT_OUTING,
  E2E_ADSENSE_SLOT_SIDEBAR,
  E2E_GA4_ID,
} from "./support/ads-facts.ts";

const REPO = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
const SITE = join(REPO, "apps/site");
const HEALTH_TIMEOUT_MS = 180_000;

function log(msg: string): void {
  console.log(`[e2e] ${msg}`);
}

function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", fail);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      srv.close(() =>
        addr && typeof addr === "object" ? ok(addr.port) : fail(new Error("no port")),
      );
    });
  });
}

/**
 * Runs `pnpm <args>` through sh: pnpm 12's launcher is a shell script without a
 * shebang on some installs, which execFile can't run directly. Arguments pass as
 * positional parameters, so nothing is re-parsed by the shell.
 */
function pnpm(args: string[], env: NodeJS.ProcessEnv = {}): void {
  log(`$ pnpm ${args.join(" ")}`);
  execFileSync("sh", ["-c", 'exec pnpm "$@"', "pnpm", ...args], {
    cwd: REPO,
    stdio: "inherit",
    env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false", ...env },
  });
}

async function waitForHealth(origin: string, child: ChildProcess, logFile: string): Promise<void> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  let lastError = "";
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    try {
      const res = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(5_000) });
      if (res.ok) {
        const body: unknown = await res.json();
        if (typeof body === "object" && body !== null && "ok" in body && body.ok === true) return;
      }
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  let tail = "";
  try {
    tail = readFileSync(logFile, "utf8").split("\n").slice(-60).join("\n");
  } catch {
    // no log yet
  }
  throw new Error(
    `wrangler dev did not become healthy at ${origin}/health (${lastError}).\n${tail}`,
  );
}

function stop(child: ChildProcess): Promise<void> {
  return new Promise((done) => {
    if (child.exitCode !== null || child.pid === undefined) return done();
    const pid = child.pid;
    const timer = setTimeout(() => {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // already gone
      }
      done();
    }, 5_000);
    child.once("exit", () => {
      clearTimeout(timer);
      done();
    });
    try {
      // Negative pid: the whole group, so workerd goes down with wrangler.
      process.kill(-pid, "SIGTERM");
    } catch {
      clearTimeout(timer);
      done();
    }
  });
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  if (process.env.E2E_BASE_URL) {
    log(`using the running server at ${process.env.E2E_BASE_URL}`);
    return async () => {};
  }

  const port = process.env.E2E_PORT ? Number(process.env.E2E_PORT) : await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const persist = mkdtempSync(join(tmpdir(), "gof-e2e-d1-"));
  log(`D1 state in ${persist}; site at ${origin}; SITE_NOW=${SITE_NOW}`);

  pnpm(["run", "db:migrate:local", "--persist-to", persist]);
  // The loader honours PIPELINE_NOW outside production (SPEC.md 8.0); pin it to
  // the same day as SITE_NOW so publish decisions match the pages' clock.
  pnpm(["run", "seed", `--persist-to=${persist}`], {
    PIPELINE_NOW: SITE_NOW,
    NODE_ENV: "development",
  });
  if (process.env.E2E_SKIP_BUILD === "1") {
    log("E2E_SKIP_BUILD=1: using the existing apps/site/dist");
  } else {
    // NODE_ENV=development builds the draft guides too (apps/site/astro.config.mjs),
    // so the suite can check that drafts render with noindex and stay out of sitemaps.
    pnpm(["build"], { PUBLIC_SITE_URL: origin, NODE_ENV: "development" });
  }

  const logFile = join(persist, "wrangler-dev.log");
  const out = createWriteStream(logFile);
  const wrangler = join(SITE, "node_modules/.bin/wrangler");
  const child = spawn(
    wrangler,
    [
      "dev",
      "--local",
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
      "--persist-to",
      persist,
      "--show-interactive-dev-session=false",
      "--var",
      "NODE_ENV:development",
      "--var",
      `SITE_NOW:${SITE_NOW}`,
      "--var",
      `PUBLIC_SITE_URL:${origin}`,
      "--var",
      `INDEXNOW_KEY:${E2E_INDEXNOW_KEY}`,
      "--var",
      `GOOGLE_SITE_VERIFICATION:${E2E_GOOGLE_VERIFICATION}`,
      "--var",
      `BING_SITE_VERIFICATION:${E2E_BING_VERIFICATION}`,
      // Ads on (SPEC.md 9.5), so slots, the consent bootstrap and /ads.txt render.
      "--var",
      `PUBLIC_ADSENSE_CLIENT:${E2E_ADSENSE_CLIENT}`,
      "--var",
      `PUBLIC_ADSENSE_SLOT_LIST:${E2E_ADSENSE_SLOT_LIST}`,
      "--var",
      `PUBLIC_ADSENSE_SLOT_OUTING:${E2E_ADSENSE_SLOT_OUTING}`,
      "--var",
      `PUBLIC_ADSENSE_SLOT_SIDEBAR:${E2E_ADSENSE_SLOT_SIDEBAR}`,
      "--var",
      `PUBLIC_GA4_ID:${E2E_GA4_ID}`,
    ],
    {
      cwd: SITE,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false", NO_COLOR: "1" },
    },
  );
  child.stdout?.pipe(out);
  child.stderr?.pipe(out);

  try {
    await waitForHealth(origin, child, logFile);
  } catch (err) {
    await stop(child);
    throw err;
  }
  log(`wrangler dev is healthy (log: ${logFile})`);
  process.env.E2E_BASE_URL = origin;

  return async () => {
    await stop(child);
    out.end();
    if (process.env.E2E_KEEP_D1 === "1") log(`kept ${persist}`);
    else rmSync(persist, { recursive: true, force: true });
  };
}
