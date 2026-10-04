import { describe, expect, it } from "vitest";
import {
  FRAME_MAX_HEIGHT,
  FRAME_MAX_MESSAGE_BYTES,
  FRAME_MAX_MESSAGES_PER_SEC,
  FRAME_MIN_HEIGHT,
  clampFrameHeight,
  createFrameRateLimiter,
  parseFrameMessage,
} from "../src/frame.js";

describe("parseFrameMessage", () => {
  it("accepts a well-formed envelope", () => {
    expect(
      parseFrameMessage({ v: 1, id: "a1", type: "ready" }),
    ).toMatchObject({ v: 1, id: "a1", type: "ready" });
  });

  it("rejects malformed envelopes and unknown types", () => {
    expect(parseFrameMessage(null)).toBeNull();
    expect(parseFrameMessage("ready")).toBeNull();
    expect(parseFrameMessage({ v: 2, id: "a", type: "ready" })).toBeNull();
    expect(parseFrameMessage({ v: 1, type: "ready" })).toBeNull();
    expect(
      parseFrameMessage({ v: 1, id: "a", type: "eval", payload: "x" }),
    ).toBeNull();
    expect(parseFrameMessage({ v: 1, id: "", type: "ready" })).toBeNull();
  });

  it("drops messages larger than the 64 KB cap", () => {
    const big = {
      v: 1,
      id: "a",
      type: "run",
      payload: { blob: "x".repeat(FRAME_MAX_MESSAGE_BYTES) },
    };
    expect(JSON.stringify(big).length).toBeGreaterThan(FRAME_MAX_MESSAGE_BYTES);
    expect(parseFrameMessage(big)).toBeNull();
  });
});

describe("clampFrameHeight", () => {
  it("clamps into [80, 1600] and handles non-numbers", () => {
    expect(clampFrameHeight(10)).toBe(FRAME_MIN_HEIGHT);
    expect(clampFrameHeight(400)).toBe(400);
    expect(clampFrameHeight(999_999)).toBe(FRAME_MAX_HEIGHT);
    expect(clampFrameHeight(400.6)).toBe(401);
    expect(clampFrameHeight("tall")).toBe(FRAME_MIN_HEIGHT);
    expect(clampFrameHeight(Number.NaN)).toBe(FRAME_MIN_HEIGHT);
    expect(clampFrameHeight(undefined)).toBe(FRAME_MIN_HEIGHT);
  });
});

describe("createFrameRateLimiter", () => {
  it("admits up to the cap per window and drops the excess", () => {
    let t = 0;
    const allow = createFrameRateLimiter(3, 1000, () => t);
    expect(allow()).toBe(true);
    expect(allow()).toBe(true);
    expect(allow()).toBe(true);
    expect(allow()).toBe(false); // 4th in the same second dropped
    t = 1001;
    expect(allow()).toBe(true); // window slid — admitted again
  });

  it("defaults to 20 msg/s", () => {
    let t = 0;
    const allow = createFrameRateLimiter(
      FRAME_MAX_MESSAGES_PER_SEC,
      1000,
      () => t,
    );
    for (let i = 0; i < FRAME_MAX_MESSAGES_PER_SEC; i++) {
      expect(allow()).toBe(true);
    }
    expect(allow()).toBe(false);
  });
});
