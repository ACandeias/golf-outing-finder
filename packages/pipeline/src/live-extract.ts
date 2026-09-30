// Re-records LLM extraction fixtures. Phase 2 asks the owner before spending.
export async function runLiveExtract(): Promise<void> {
  console.log("live-extract: Phase 2");
}

runLiveExtract().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
