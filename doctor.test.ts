import { expect, test } from "bun:test";
import { agentDirs, bridgeSocket, buildReport, renderReport, type DoctorEnv } from "./doctor";

/** Fake environment: nothing touches disk. `dirs` maps an absolute dir path to a file count. */
function fakeEnv(over: Partial<DoctorEnv> = {}, dirs: Record<string, number | null> = {}): DoctorEnv {
  return {
    port: 7777,
    which: () => false,
    speech: () => ({ active: null }),
    socketUp: () => false,
    scan: (dir) => dir in dirs ? dirs[dir]! : null,
    exists: (p) => p in dirs,
    env: () => undefined,
    home: "/home/u",
    ...over,
  };
}

const byId = (r: ReturnType<typeof buildReport>, id: string) => r.checks.find((c) => c.id === id)!;

test("all present and configured is ok on every check", () => {
  const env = fakeEnv({
    which: () => true,
    speech: () => ({ active: "whisper-socket" }),
    socketUp: () => true,
  }, { "/home/u/.jcode/sessions": 42, "/home/u/.claude/projects": 3 });
  const r = buildReport(env);
  expect(r.status).toBe("ok");
  expect(r.checks.every((c) => c.status === "ok")).toBe(true);
  expect(byId(r, "speech").detail).toBe("active: whisper-socket");
  expect(byId(r, "port").detail).toBe("listening on 127.0.0.1:7777");
});

test("every missing piece yields a warn with a one-line fix hint", () => {
  const r = buildReport(fakeEnv());
  expect(r.status).toBe("warn");
  for (const id of ["speech", "ffmpeg", "tmux", "hyprctl", "jcode", "agents"]) {
    expect(byId(r, id).status).toBe("warn");
    expect(byId(r, id).hint).toBeTruthy();
  }
});

test("jcode installed but bridge socket down is an error (overall status error)", () => {
  const r = buildReport(fakeEnv({ which: (b) => b === "jcode", socketUp: () => false }));
  expect(byId(r, "jcode").status).toBe("error");
  expect(r.status).toBe("error");
  expect(byId(r, "jcode").hint).toMatch(/hubert\.sh/);
});

test("agent data lists found dirs with session counts", () => {
  const r = buildReport(fakeEnv({}, { "/home/u/.jcode/sessions": 5, "/home/u/.codex/sessions": 2, "/home/u/.local/share/opencode/opencode.db": 1 }));
  const found = r.agents.filter((a) => a.found);
  expect(found.map((a) => a.label)).toEqual(["jcode", "Codex", "OpenCode"]);
  expect(found[0]!.sessions).toBe(5);
  expect(r.agents.find((a) => a.id === "opencode")!.found).toBe(true);
  expect(byId(r, "agents").detail).toContain("jcode: 5");
});

test("honors env overrides for data dirs and socket", () => {
  const env = fakeEnv({ env: (k) => ({ JCODE_HOME: "/opt/j", JCODE_API_SOCKET: "/run/x.sock" })[k] });
  expect(agentDirs(env).find((d) => d.id === "jcode")!.path).toBe("/opt/j/sessions");
  expect(bridgeSocket(env)).toBe("/run/x.sock");
  expect(bridgeSocket(fakeEnv({ env: (k) => (k === "XDG_RUNTIME_DIR" ? "/run/user/1" : undefined) }))).toBe("/run/user/1/jcode-api.sock");
});

test("renderReport prints a status line and each hint", () => {
  const text = renderReport(buildReport(fakeEnv()));
  expect(text).toContain("hubert doctor: warn");
  expect(text).toContain("[--] ffmpeg: not found");
  expect(text).toContain("fix: install ffmpeg");
  expect(text).toContain("agent data:");
});
