import { test, expect } from "bun:test";
import { ANSWER_MS, bounds, clamp, mascotState } from "./mascot";

test("mascot coordinates stay in viewport, including tiny screens and malformed values", () => {
  expect(bounds({ x: 1, y: 1 }, 320, 200)).toEqual({ x: 264, y: 144 });
  expect(bounds({ x: -5, y: 9 }, 30, 40)).toEqual({ x: 0, y: 0 });
  expect(clamp(NaN)).toBe(0);
});

test("mascotState: error outranks every other signal", () => {
  expect(mascotState({ error: true, voice: "listening", thinking: true, now: 100 })).toBe("error");
  expect(mascotState({ stale: true, voice: "listening", now: 100 })).toBe("error");
});

test("mascotState: listening while recording, thinking while transcribing or pending", () => {
  expect(mascotState({ voice: "listening", now: 0 })).toBe("listening");
  expect(mascotState({ voice: "starting", now: 0 })).toBe("listening");
  expect(mascotState({ voice: "transcribing", now: 0 })).toBe("thinking");
  expect(mascotState({ voice: "transcribing", thinking: true, now: 0 })).toBe("thinking");
  expect(mascotState({ thinking: true, now: 0 })).toBe("thinking");
});

test("mascotState: speaking only inside the answer window", () => {
  expect(mascotState({ answeredAt: 1000, now: 1000 })).toBe("speaking");
  expect(mascotState({ answeredAt: 1000, now: 1000 + ANSWER_MS - 1 })).toBe("speaking");
  expect(mascotState({ answeredAt: 1000, now: 1000 + ANSWER_MS })).toBe("idle");
  expect(mascotState({ answeredAt: 1000, now: 999 })).toBe("idle");
  expect(mascotState({ now: 5000 })).toBe("idle");
});

