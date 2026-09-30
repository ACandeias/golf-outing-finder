// Seed loader. Populated in Phase 1.
export async function runSeed(): Promise<void> {
  console.log("seed loader: Phase 1");
}

runSeed().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
