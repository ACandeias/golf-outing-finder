import { z } from "zod";
import { batchResultSchema } from "../stages/types.ts";

/**
 * tests/fixtures/llm/{id}.json: one Message Batches result per seed page.
 * `recorded: true` files come from `pnpm run test:live-extract`; `recorded:
 * false` files are hand-written stand-ins in the same shape, with a note, until
 * the owner approves a recording run.
 */
export const llmRecordingSchema = z
  .object({
    id: z.string().min(1),
    recorded: z.boolean(),
    note: z.string().optional(),
    recorded_at: z.string(),
    model: z.string(),
    extractor_version: z.string(),
    batch_result: batchResultSchema,
  })
  .strict();
export type LlmRecording = z.infer<typeof llmRecordingSchema>;

export const HAND_WRITTEN_NOTE = "hand-written; replace with pnpm run test:live-extract";
