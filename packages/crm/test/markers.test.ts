// The idempotency key and the write markers (Phase 6 spec §4.4): committed vectors, made outside
// this code with Python's hashlib and base64 (RFC 4648), so a change to either function fails here.
import { describe, expect, it } from "vitest";
import { idempotencyKey, MARKER_CHARS, MARKER_PREFIX, marker, markerUuid } from "../src";
import { base32 } from "../src/markers";

/** A proposal and the review that approved it, as the fixtures in @earshot/core name them. */
const PROPOSAL = "01a1c6e2-e5dc-79b1-a045-4bf227d9db20";
const REVIEW = "01a1c6e4-0a10-7b2c-8d3e-4f5a6b7c8d01";
/** sha256("earshot.sync.v1:01a1c6e2-e5dc-79b1-a045-4bf227d9db20:01a1c6e4-0a10-7b2c-8d3e-4f5a6b7c8d01") */
const KEY = "adec44cb187ee88bb8157d6d32261ab33c47321718fdefe59f991dd2b9535513";
/** The markers of that job's writes 0, 1, 2, and 7. */
const MARKERS: Readonly<Record<number, string>> = {
  0: "es_oxmttwqjbgqfzongy4te",
  1: "es_c6smbbo5tyzkd4jsongl",
  2: "es_7pin3ntw6n5wqswshuah",
  7: "es_37eisnt7o47itfj7ozfg",
};

describe("idempotencyKey", () => {
  it("is the lowercase hex SHA-256 of the prefix, the proposal, and the review (a committed vector)", async () => {
    expect(await idempotencyKey(PROPOSAL, REVIEW)).toBe(KEY);
    expect(
      await idempotencyKey(
        "00000000-0000-7000-8000-000000003001",
        "00000000-0000-7000-8000-000000007001",
      ),
    ).toBe("ff82f4567f72abf308c2ff66cf7e426c1d278451831552d0970939b4251031ff");
  });

  it("doesn't depend on how an id is spelled, and differs by proposal and by review", async () => {
    expect(await idempotencyKey(PROPOSAL.toUpperCase(), REVIEW.toUpperCase())).toBe(KEY);
    const other = "01a1c6e4-0a10-7b2c-8d3e-4f5a6b7c8d02";
    expect(await idempotencyKey(PROPOSAL, other)).not.toBe(KEY);
    expect(await idempotencyKey(REVIEW, PROPOSAL)).not.toBe(KEY);
  });

  it("takes UUIDs only", async () => {
    await expect(idempotencyKey("proposal-1", REVIEW)).rejects.toThrow(TypeError);
    await expect(idempotencyKey(PROPOSAL, `${REVIEW}:hubspot`)).rejects.toThrow(TypeError);
  });
});

describe("marker", () => {
  it.each(Object.entries(MARKERS))(
    "matches the committed vector for write %s",
    async (index, expected) => {
      expect(await marker(KEY, Number(index))).toBe(expected);
    },
  );

  it("is es_ and 20 lowercase base32 characters, the same every time", async () => {
    const first = await marker(KEY, 3);
    expect(first).toMatch(/^es_[a-z2-7]{20}$/);
    expect(first).toHaveLength(MARKER_PREFIX.length + MARKER_CHARS);
    expect(await marker(KEY, 3)).toBe(first);
  });

  it("differs by index, across a plan's eight writes, and by key", async () => {
    const markers = await Promise.all([0, 1, 2, 3, 4, 5, 6, 7].map((index) => marker(KEY, index)));
    expect(new Set(markers).size).toBe(8);
    const otherKey = await idempotencyKey(PROPOSAL, "01a1c6e4-0a10-7b2c-8d3e-4f5a6b7c8d02");
    expect(await marker(otherKey, 0)).not.toBe(MARKERS[0]);
  });

  it("takes an idempotency key and a write's index only", async () => {
    await expect(marker(KEY.toUpperCase(), 0)).rejects.toThrow(TypeError);
    await expect(marker("es_oxmttwqjbgqfzongy4te", 0)).rejects.toThrow(TypeError);
    await expect(marker(KEY, -1)).rejects.toThrow(RangeError);
    await expect(marker(KEY, 1.5)).rejects.toThrow(RangeError);
    await expect(marker(KEY, Number.NaN)).rejects.toThrow(RangeError);
  });
});

describe("base32", () => {
  it.each([
    ["", ""],
    ["f", "my"],
    ["fo", "mzxq"],
    ["foo", "mzxw6"],
    ["foob", "mzxw6yq"],
    ["fooba", "mzxw6ytb"],
    ["foobar", "mzxw6ytboi"],
  ])("encodes %j as RFC 4648's vectors do, lowercase and unpadded", (text, expected) => {
    expect(base32(new TextEncoder().encode(text))).toBe(expected);
  });

  it("encodes a SHA-256 digest in 52 characters", () => {
    expect(base32(new Uint8Array(32).fill(0xff))).toBe(`${"7".repeat(51)}q`);
  });
});

describe("markerUuid", () => {
  it.each([
    ["es_oxmttwqjbgqfzongy4te", "75d939da-0909-8a05-b2e6-9b1c99000000"],
    ["es_c6smbbo5tyzkd4jsongl", "17a4c085-dd9e-832a-87c4-c9cd32c00000"],
    ["es_aaaaaaaaaaaaaaaaaaaa", "00000000-0000-8000-8000-000000000000"],
    ["es_77777777777777777777", "ffffffff-ffff-8fff-bfff-ffffffc00000"],
  ])("makes %s into a UUID v8 (a committed vector, made with Python)", (text, uuid) => {
    expect(markerUuid(text)).toBe(uuid);
    expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("takes a marker only", () => {
    expect(() => markerUuid("es_SHORT")).toThrow(TypeError);
    expect(() => markerUuid("oxmttwqjbgqfzongy4te")).toThrow(TypeError);
  });
});
