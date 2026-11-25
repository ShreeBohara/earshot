// The visible line on activities (Phase 6 spec decision 17), and a contact's name split in two.
import { describe, expect, it } from "vitest";
import {
  ACTIVITY_LINE_PREFIX,
  activityLine,
  hasActivityLine,
  markerInBody,
  splitName,
  withActivityLine,
} from "../src";

const MARKER = "es_oxmttwqjbgqfzongy4te";
const OTHER = "es_c6smbbo5tyzkd4jsongl";

describe("the activity line", () => {
  it("reads via Earshot, then the marker", () => {
    expect(ACTIVITY_LINE_PREFIX).toBe("via Earshot · ref ");
    expect(activityLine(MARKER)).toBe("via Earshot · ref es_oxmttwqjbgqfzongy4te");
  });

  it("ends an activity's text, after a blank line, or stands alone", () => {
    expect(withActivityLine("Dana wants the review first.", MARKER)).toBe(
      "Dana wants the review first.\n\nvia Earshot · ref es_oxmttwqjbgqfzongy4te",
    );
    expect(withActivityLine(null, MARKER)).toBe(activityLine(MARKER));
    expect(withActivityLine("   ", MARKER)).toBe(activityLine(MARKER));
  });

  it("cuts the text, never the line, to fit a cap", () => {
    const body = withActivityLine("x".repeat(3_000), MARKER, 2_000);
    expect(body).toHaveLength(2_000);
    expect(body.endsWith(`…\n\n${activityLine(MARKER)}`)).toBe(true);
    expect(withActivityLine("short", MARKER, 2_000)).toBe(`short\n\n${activityLine(MARKER)}`);
    expect(withActivityLine("long text", MARKER, 10)).toBe(activityLine(MARKER));
  });

  it("is found again in a body, as text or HTML, the last when there are two", () => {
    expect(markerInBody(withActivityLine("note", MARKER))).toBe(MARKER);
    expect(markerInBody(`<p>note</p><p>via Earshot · ref ${MARKER}</p>`)).toBe(MARKER);
    expect(markerInBody(`quoting ref ${OTHER}\n\n${activityLine(MARKER)}`)).toBe(MARKER);
    expect(markerInBody("no line here")).toBeNull();
    expect(markerInBody("ref es_short")).toBeNull();
    expect(hasActivityLine(`a\n\n${activityLine(MARKER)}`, MARKER)).toBe(true);
    expect(hasActivityLine(`a\n\n${activityLine(MARKER)}`, OTHER)).toBe(false);
    expect(hasActivityLine(`ref ${MARKER}x`, MARKER)).toBe(false);
  });
});

describe("splitName", () => {
  it.each([
    ["Dana Lee", { first: "Dana", last: "Lee" }],
    ["  Mary   Ann  Smith ", { first: "Mary Ann", last: "Smith" }],
    ["Pieter van der Berg", { first: "Pieter van der", last: "Berg" }],
    ["Cher", { first: "Cher", last: null }],
  ])("splits %j: the last word is the last name", (full, parts) => {
    expect(splitName(full)).toEqual(parts);
  });

  it("is null for no name", () => {
    expect(splitName("   ")).toBeNull();
  });
});
