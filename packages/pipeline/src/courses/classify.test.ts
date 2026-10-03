import { describe, expect, it } from "vitest";
import { courseTypeFromOsmTags, isExcludedFeature } from "./classify.ts";

describe("isExcludedFeature (SPEC 8.1 step 2)", () => {
  it.each([
    [{ leisure: "golf_course" }, true], // no name
    [{ name: "  " }, true],
    [{ name: "Sunset Mini Golf" }, true],
    [{ name: "Adventure Miniature Golf" }, true],
    [{ name: "Putt-Putt Fun Center" }, true],
    [{ name: "Topgolf Scottsdale" }, true],
    [{ name: "Westchester Driving Range" }, true],
    [{ name: "Range at the Park", golf: "driving_range" }, true],
    [{ name: "Encanto 9 Golf Course" }, false],
    [{ name: "Rolling Hills Par 3" }, false],
    [{ name: "Putterham Meadows Golf Course" }, false],
    [{ name: "Winged Foot Golf Club" }, false],
  ])("%j excluded=%s", (tags, excluded) => {
    expect(isExcludedFeature(tags)).toBe(excluded);
  });
});

describe("courseTypeFromOsmTags (SPEC 8.1 step 4.2)", () => {
  it.each([
    [{ access: "private" }, "private"],
    [{ access: "private", operator: "City of Phoenix" }, "private"],
    [{ "operator:type": "government" }, "municipal"],
    [{ operator: "City of Phoenix" }, "municipal"],
    [{ operator: "Westchester County Parks" }, "municipal"],
    [{ operator: "NYS Office of Parks, Recreation and Historic Preservation" }, "municipal"],
    [{ operator: "Bethpage State Park" }, "municipal"],
    [{ operator: "Cook County Forest Preserves" }, "municipal"],
    [{ access: "yes" }, "public"],
    [{ access: "public" }, "public"],
    [{ access: "customers" }, null],
    [{ operator: "Tampa Sports Authority" }, null],
    [{}, null],
  ])("%j -> %s", (tags, type) => {
    expect(courseTypeFromOsmTags(tags)).toBe(type);
  });
});
