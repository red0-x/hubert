import { expect, test } from "bun:test";
import { audioDevices, setDefaultSource, speakTts } from "./tts";
import { guard } from "../server";

test("audioDevices reports lists and never throws without pactl", async () => {
  const d = await audioDevices();
  expect(Array.isArray(d.sinks)).toBe(true);
  expect(d.sources.every(s => !s.name.endsWith(".monitor"))).toBe(true);
});

test("setDefaultSource rejects names that are not real sources", async () => {
  expect(await setDefaultSource("nope; rm -rf /")).toBe(false);
});

test("speak/audio routes are guarded against foreign hosts", () => {
  const req = new Request("http://evil.example/api/speak", { method: "POST", headers: { host: "evil.example" } });
  expect(guard(req)?.status).toBe(403);
});
