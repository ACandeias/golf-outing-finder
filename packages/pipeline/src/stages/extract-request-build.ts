import { notImplemented } from "./not-implemented.ts";
import type { ExtractRequestBuildStage } from "./types.ts";

/**
 * SPEC.md 8.4, workstream C. One Message Batches request per changed page:
 * claude-haiku-4-5, temperature 0, 800 max tokens, the system prompt in
 * prompts/extract.md, the page wrapped as <page url="...">, structured output
 * from the shared extraction schema, no tools. Stops at MAX_EXTRACTIONS_PER_RUN
 * or MAX_LLM_INPUT_TOKENS_PER_RUN and defers the rest.
 */
export const extractRequestBuild: ExtractRequestBuildStage =
  notImplemented("extract-request-build");
