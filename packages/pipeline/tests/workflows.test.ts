import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { z } from "zod";
import { REPO_ROOT } from "../src/lib/paths.ts";
import { NIGHTLY_STAGES } from "../src/stages/registry.ts";

/**
 * SPEC.md 13 Phase 5: "A forced stage failure makes the nightly job fail and
 * email the owner." nightly.yml's workflow_dispatch input `fail_stage` offers
 * every stage `--fail-stage` takes in a nightly run, and passes it through an
 * env var (never inlined into the script, so an input can't inject shell).
 */

const WORKFLOWS = join(REPO_ROOT, ".github/workflows");

const stepSchema = z.object({
  uses: z.string().optional(),
  run: z.string().optional(),
  env: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
});
const workflowSchema = z.object({
  on: z.object({
    workflow_dispatch: z.object({
      inputs: z.record(
        z.string(),
        z.object({
          type: z.string(),
          options: z.array(z.string()).optional(),
          default: z.union([z.string(), z.boolean()]).optional(),
        }),
      ),
    }),
  }),
  permissions: z.record(z.string(), z.string()),
  jobs: z.record(
    z.string(),
    z.object({ permissions: z.record(z.string(), z.string()).optional(), steps: z.array(stepSchema) }),
  ),
});

function workflow(name: string): z.infer<typeof workflowSchema> {
  return workflowSchema.parse(parse(readFileSync(join(WORKFLOWS, name), "utf8")));
}

describe("nightly.yml", () => {
  const wf = workflow("nightly.yml");
  const steps = wf.jobs.run!.steps;
  const pipelineStep = steps.find((s) => s.run?.includes("pnpm run pipeline"))!;

  it("offers fail_stage: none plus every nightly stage --fail-stage accepts, in run order", () => {
    const input = wf.on.workflow_dispatch.inputs.fail_stage!;
    expect(input.type).toBe("choice");
    expect(input.default).toBe("none");
    expect(input.options).toEqual(["none", ...NIGHTLY_STAGES.filter((s) => s !== "report")]);
  });

  it("passes fail_stage and weekly_report through env vars, never inline in the script", () => {
    expect(pipelineStep.env?.FAIL_STAGE).toBe("${{ inputs.fail_stage || 'none' }}");
    expect(pipelineStep.env?.WEEKLY_REPORT).toBe("${{ inputs.weekly_report == true }}");
    expect(pipelineStep.run).not.toMatch(/\$\{\{/);
    expect(pipelineStep.run).toContain('"--fail-stage=$FAIL_STAGE"');
    expect(pipelineStep.run).toContain('[ "$FAIL_STAGE" != "none" ]');
    expect(wf.on.workflow_dispatch.inputs.weekly_report).toMatchObject({ type: "boolean", default: false });
  });

  it("can write the weekly report issue and has the token for it", () => {
    expect(wf.permissions).toEqual({ contents: "read" });
    expect(wf.jobs.run!.permissions).toEqual({ contents: "read", issues: "write" });
    expect(pipelineStep.env?.GH_TOKEN).toBe("${{ github.token }}");
  });
});

describe("every workflow", () => {
  const files = readdirSync(WORKFLOWS).filter((f) => f.endsWith(".yml"));

  it("pins every action to a full commit SHA", () => {
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const text = readFileSync(join(WORKFLOWS, f), "utf8");
      for (const m of text.matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)) {
        const ref = m[1]!;
        if (ref.startsWith("./")) continue;
        expect(ref, `${f}: ${ref}`).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/);
      }
    }
  });
});
