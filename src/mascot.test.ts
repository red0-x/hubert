import { test, expect } from "bun:test";
import { bounds, clamp } from "./mascot";

test("mascot coordinates stay in viewport, including tiny screens and malformed values", () => {
  expect(bounds({ x: 1, y: 1 }, 320, 200)).toEqual({ x: 264, y: 144 });
  expect(bounds({ x: -5, y: 9 }, 30, 40)).toEqual({ x: 0, y: 0 });
  expect(clamp(NaN)).toBe(0);
});
