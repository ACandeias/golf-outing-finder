import { z } from "zod";

/**
 * A small GitHub REST client for the weekly report issue (SPEC.md 8.10), on
 * the global fetch. Only api.github.com, only the issues endpoints, a bearer
 * token, and the API version header GitHub recommends (checked 2026-10-04:
 * 2026-03-10 is the newest version; 2022-11-28 is supported until 2028-03-10).
 * Every response is validated with zod. The token is sent only in the
 * Authorization header and never appears in an error message.
 *
 * Retries: GET and PATCH (idempotent) are retried on network errors, timeouts,
 * 5xx and 429, three attempts in all. POST is never retried: a create that
 * timed out may have succeeded, and a retry would open a second issue.
 */

export const GITHUB_API = "https://api.github.com";
export const GITHUB_API_VERSION = "2026-03-10";
const USER_AGENT = "golf-outing-finder-pipeline";
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_ATTEMPTS = 3;
/** Title-match fallback: at most this many pages of 100 open issues. */
const MAX_FALLBACK_PAGES = 3;

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** `owner/name`, as GITHUB_REPOSITORY gives it. */
export const repoSchema = z
  .string()
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/, "GITHUB_REPOSITORY must be owner/name")
  .refine((r) => !/\/\.{1,2}$/.test(r), "GITHUB_REPOSITORY must be owner/name");

export const issueSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  state: z.enum(["open", "closed"]),
  html_url: z.string().url(),
  /** Present when the "issue" is a pull request (the issues API lists both). */
  pull_request: z.unknown().optional(),
});
export type Issue = z.infer<typeof issueSchema>;

const errorBodySchema = z.object({ message: z.string() }).partial();

export class GitHubApiError extends Error {
  /** HTTP status, or null for a network error or timeout. */
  readonly status: number | null;
  constructor(message: string, status: number | null) {
    super(message);
    this.name = "GitHubApiError";
    this.status = status;
  }
}

export interface GitHubIssuesOptions {
  token: string;
  repo: string;
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}

export interface GitHubIssues {
  /** One page of open issues (and pull requests), newest first; `label` filters. */
  listOpen(q: { label?: string; page: number }): Promise<Issue[]>;
  create(i: { title: string; body: string; labels: readonly string[] }): Promise<Issue>;
  update(number: number, body: string): Promise<Issue>;
}

function oneLine(text: string, secret: string, max = 200): string {
  return text.split(secret).join("[REDACTED]").replace(/\s+/g, " ").trim().slice(0, max);
}

export function createGitHubIssues(opts: GitHubIssuesOptions): GitHubIssues {
  const repo = repoSchema.safeParse(opts.repo);
  if (!repo.success) throw new Error("GITHUB_REPOSITORY must be owner/name");
  const [owner, name] = repo.data.split("/") as [string, string];
  const base = `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues`;
  const doFetch: FetchLike = opts.fetch ?? ((url, init) => fetch(url, init));
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const token = opts.token;

  async function call<T>(
    method: "GET" | "POST" | "PATCH",
    url: string,
    schema: z.ZodType<T, z.ZodTypeDef, unknown>,
    body?: unknown,
  ): Promise<T> {
    const path = new URL(url).pathname;
    const attempts = method === "POST" ? 1 : MAX_ATTEMPTS;
    let last: GitHubApiError | null = null;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      if (attempt > 1) await sleep(1000 * 2 ** (attempt - 2));
      let res: Response;
      try {
        res = await doFetch(url, {
          method,
          headers: {
            accept: "application/vnd.github+json",
            authorization: `Bearer ${token}`,
            "x-github-api-version": GITHUB_API_VERSION,
            "user-agent": USER_AGENT,
            ...(body === undefined ? {} : { "content-type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          redirect: "error",
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        const why = err instanceof Error ? `${err.name}: ${err.message}` : "fetch failed";
        last = new GitHubApiError(`GitHub ${method} ${path}: ${oneLine(why, token)}`, null);
        continue;
      }
      let json: unknown = null;
      try {
        json = await res.json();
      } catch {
        json = null;
      }
      if (!res.ok) {
        const msg = errorBodySchema.safeParse(json);
        const detail = msg.success && msg.data.message ? `: ${oneLine(msg.data.message, token)}` : "";
        last = new GitHubApiError(`GitHub ${method} ${path} returned ${res.status}${detail}`, res.status);
        if (res.status >= 500 || res.status === 429) continue;
        throw last;
      }
      const parsed = schema.safeParse(json);
      if (!parsed.success)
        throw new GitHubApiError(`GitHub ${method} ${path}: unexpected response (${parsed.error.issues.length} problems)`, res.status);
      return parsed.data;
    }
    throw last ?? new GitHubApiError(`GitHub ${method} ${path} failed`, null);
  }

  return {
    listOpen: ({ label, page }) => {
      const q = new URLSearchParams({ state: "open", per_page: "100", page: String(page) });
      if (label) q.set("labels", label);
      return call("GET", `${base}?${q.toString()}`, z.array(issueSchema));
    },
    create: ({ title, body, labels }) =>
      call("POST", base, issueSchema, { title, body, ...(labels.length > 0 ? { labels: [...labels] } : {}) }),
    update: (number, body) => call("PATCH", `${base}/${number}`, issueSchema, { body }),
  };
}

function isTheIssue(i: Issue, title: string): boolean {
  return i.pull_request === undefined && i.state === "open" && i.title === title;
}

/** The open issue with exactly `title`: by label first, then among recent open issues. */
export async function findOpenIssue(gh: GitHubIssues, title: string, label: string): Promise<Issue | null> {
  const labelled = (await gh.listOpen({ label, page: 1 })).filter((i) => isTheIssue(i, title));
  if (labelled.length > 0) return labelled.reduce((a, b) => (b.number < a.number ? b : a));
  for (let page = 1; page <= MAX_FALLBACK_PAGES; page++) {
    const issues = await gh.listOpen({ page });
    const match = issues.filter((i) => isTheIssue(i, title));
    if (match.length > 0) return match.reduce((a, b) => (b.number < a.number ? b : a));
    if (issues.length < 100) break;
  }
  return null;
}

export interface UpsertResult {
  action: "created" | "updated";
  number: number;
  url: string;
}

/**
 * Updates the body of the one open issue titled `title`, or creates it with
 * `label`. When GitHub refuses the label (422), it creates the issue without
 * one; the title match finds it next week.
 */
export async function upsertIssue(
  gh: GitHubIssues,
  i: { title: string; label: string; body: string },
): Promise<UpsertResult> {
  const found = await findOpenIssue(gh, i.title, i.label);
  if (found) {
    const u = await gh.update(found.number, i.body);
    return { action: "updated", number: u.number, url: u.html_url };
  }
  let created: Issue;
  try {
    created = await gh.create({ title: i.title, body: i.body, labels: [i.label] });
  } catch (err) {
    if (!(err instanceof GitHubApiError) || err.status !== 422) throw err;
    created = await gh.create({ title: i.title, body: i.body, labels: [] });
  }
  return { action: "created", number: created.number, url: created.html_url };
}
