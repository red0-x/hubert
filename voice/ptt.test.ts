import { expect, test } from "bun:test";
import { isPttAction, resolvePtt } from "./ptt";

test("start and stop are idempotent", () => {
  expect(resolvePtt("idle", "start")).toBe("recording");
  expect(resolvePtt("recording", "start")).toBe("recording");
  expect(resolvePtt("recording", "stop")).toBe("idle");
  expect(resolvePtt("idle", "stop")).toBe("idle");
});

test("toggle flips against the current server state", () => {
  expect(resolvePtt("idle", "toggle")).toBe("recording");
  expect(resolvePtt("recording", "toggle")).toBe("idle");
  expect(resolvePtt(resolvePtt("idle", "toggle"), "toggle")).toBe("idle");
});

test("only the three known actions are accepted", () => {
  expect(isPttAction("start")).toBe(true);
  expect(isPttAction("toggle")).toBe(true);
  expect(isPttAction("Stop")).toBe(false);
  expect(isPttAction(undefined)).toBe(false);
  expect(isPttAction({ action: "start" })).toBe(false);
});
