import { appendFile } from "node:fs/promises";

/**
 * Appends the run report to $GITHUB_STEP_SUMMARY when Actions sets it (SPEC.md
 * 8.10). Returns whether it wrote.
 */
export async function writeStepSummary(
  markdown: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<boolean> {
  const path = env.GITHUB_STEP_SUMMARY;
  if (!path) return false;
  await appendFile(path, markdown.endsWith("\n") ? markdown : `${markdown}\n`);
  return true;
}
