import { eventJsonLd } from "../extract/jsonld.ts";
import { sourceIdForUrl } from "../extract/ids.ts";
import { extractionOutputFormat } from "../extract/output-schema.ts";
import {
  buildUserMessage,
  estimateInputTokens,
  EXTRACT_MAX_TOKENS,
  EXTRACT_MODEL,
  EXTRACT_SYSTEM_PROMPT,
} from "../extract/prompt.ts";
import {
  emptyResult,
  type BudgetHit,
  type ExtractionRequest,
  type ExtractionRequestMeta,
  type ExtractRequestBuildStage,
} from "./types.ts";

/** The schema travels with every request; its size counts toward the input estimate. */
const OUTPUT_FORMAT = extractionOutputFormat();
const FIXED_CHARS = EXTRACT_SYSTEM_PROMPT.length + JSON.stringify(OUTPUT_FORMAT).length;

/**
 * SPEC.md 8.4, workstream C. One Message Batches request per changed page:
 * claude-haiku-4-5, temperature 0, no tools, the system prompt from
 * prompts/extract.md (marked for prompt caching), the page wrapped as
 * <page url="...">, Event JSON-LD as a separate <jsonld> block, and structured
 * output from the extraction schema. custom_id is the page's source id. Pages
 * whose hash is unchanged are skipped. Stops at MAX_EXTRACTIONS_PER_RUN or
 * MAX_LLM_INPUT_TOKENS_PER_RUN (whichever comes first), records a budget hit,
 * and defers the rest.
 */
export const extractRequestBuild: ExtractRequestBuildStage = (ctx, input) => {
  const result = emptyResult();
  const requests: ExtractionRequest[] = [];
  const meta: ExtractionRequestMeta[] = [];
  const deferred: string[] = [];
  const maxRequests = input.allowance.MAX_EXTRACTIONS_PER_RUN ?? ctx.caps.MAX_EXTRACTIONS_PER_RUN;
  const maxTokens =
    input.allowance.MAX_LLM_INPUT_TOKENS_PER_RUN ?? ctx.caps.MAX_LLM_INPUT_TOKENS_PER_RUN;
  let tokens = 0;
  let unchanged = 0;
  let stopped: BudgetHit | null = null;
  const seen = new Set<string>();

  for (const page of input.pages) {
    if (page.unchanged) {
      unchanged++;
      continue;
    }
    if (seen.has(page.url)) continue;
    seen.add(page.url);
    if (stopped) {
      deferred.push(page.url);
      continue;
    }
    const user = buildUserMessage({
      url: page.url,
      fetchedDate: page.fetched_at.slice(0, 10),
      text: page.text,
      jsonld: eventJsonLd(page.jsonld),
    });
    const est = estimateInputTokens(FIXED_CHARS + user.length);
    const overCount = requests.length + 1 > maxRequests;
    const overTokens = tokens + est > maxTokens;
    if (overCount || overTokens) {
      const cap = overCount ? "MAX_EXTRACTIONS_PER_RUN" : "MAX_LLM_INPUT_TOKENS_PER_RUN";
      stopped = {
        stage: "extract-request-build",
        cap,
        limit: overCount ? maxRequests : maxTokens,
        at: ctx.now.toISOString(),
        detail: `deferred from ${page.url}`,
      };
      result.budgetHits.push(stopped);
      deferred.push(page.url);
      continue;
    }
    const customId = input.source_ids?.[page.url] ?? sourceIdForUrl(page.url);
    tokens += est;
    requests.push({
      custom_id: customId,
      page_url: page.url,
      est_input_tokens: est,
      params: {
        model: EXTRACT_MODEL,
        max_tokens: EXTRACT_MAX_TOKENS,
        temperature: 0,
        system: [
          { type: "text", text: EXTRACT_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
        ],
        messages: [{ role: "user", content: user }],
        output_config: { format: OUTPUT_FORMAT },
      },
    });
    meta.push({
      custom_id: customId,
      page_url: page.url,
      kind: page.kind,
      hash: page.hash,
      jsonld_events: page.jsonld_events,
      directory_host: page.directory_host,
      page_text: page.text,
    });
  }

  if (unchanged > 0) result.counters.pages_unchanged = unchanged;
  if (deferred.length > 0)
    ctx.log.warn("extraction deferred by budget", { deferred: deferred.length, tokens });
  return { output: { requests, meta, deferred }, result };
};
