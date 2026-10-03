import { describe, expect, it } from "vitest";
import {
  mergeCourseTypeOverrides,
  parseCourseTypesYaml,
  renderCourseTypesYaml,
  type CourseTypeOverride,
} from "./course-types.ts";

describe("course-types.yaml", () => {
  it("parses the empty Phase 0 file", () => {
    expect(parseCourseTypesYaml("# comment\noverrides: []\n")).toEqual([]);
  });

  it("parses osm_ref and course_id entries", () => {
    const text = `overrides:
  - osm_ref: way/122734591
    course_type: private
    reason: "seed"
  - course_id: crs_01ABC
    course_type: municipal
    reason: owner
`;
    expect(parseCourseTypesYaml(text)).toEqual([
      { osm_ref: "way/122734591", course_type: "private", reason: "seed" },
      { course_id: "crs_01ABC", course_type: "municipal", reason: "owner" },
    ]);
  });

  it("rejects an entry with neither key, or a bad type", () => {
    expect(() =>
      parseCourseTypesYaml("overrides:\n  - course_type: private\n    reason: x\n"),
    ).toThrow();
    expect(() =>
      parseCourseTypesYaml(
        "overrides:\n  - osm_ref: way/1\n    course_type: fancy\n    reason: x\n",
      ),
    ).toThrow();
  });

  it("round-trips through render", () => {
    const rows: CourseTypeOverride[] = [
      { osm_ref: "way/1", course_type: "private", reason: "a: b" },
      { osm_ref: "relation/2", course_type: "resort", reason: "c" },
    ];
    expect(parseCourseTypesYaml(renderCourseTypesYaml(rows))).toEqual(rows);
    expect(renderCourseTypesYaml(rows)).toMatch(/^# Course-type overrides/);
  });

  it("merges generated entries without replacing the owner's", () => {
    const owner: CourseTypeOverride[] = [
      { osm_ref: "way/1", course_type: "public", reason: "owner" },
    ];
    const generated: CourseTypeOverride[] = [
      { osm_ref: "way/1", course_type: "private", reason: "seed" },
      { osm_ref: "way/2", course_type: "private", reason: "seed" },
    ];
    const { merged, kept } = mergeCourseTypeOverrides(owner, generated);
    expect(merged).toEqual([
      { osm_ref: "way/1", course_type: "public", reason: "owner" },
      { osm_ref: "way/2", course_type: "private", reason: "seed" },
    ]);
    expect(kept).toEqual(["way/1"]);
  });
});
