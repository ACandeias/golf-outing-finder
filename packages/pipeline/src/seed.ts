// Seed loader. Implemented in Phase 1 (SPEC.md section 13).
//
// `--check` exits 0 only when the loader is implemented. The Docker entrypoint uses
// it to decide whether to seed an empty local D1, so keep that contract.
export const SEED_IMPLEMENTED = false;

export async function runSeed(argv: readonly string[]): Promise<number> {
  if (argv.includes("--check")) return SEED_IMPLEMENTED ? 0 : 3;
  console.log("seed not implemented yet (Phase 1)");
  return 0;
}

runSeed(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
