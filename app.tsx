import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Agent, Repo } from "./state";

type State = { now: number; agents: Agent[]; repos: Repo[] };

const ago = (now: number, t: number) => {
  const s = Math.round((now - t) / 1000);
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`;
};
const short = (p: string | null) => (p ?? "").replace(/^\/home\/[^/]+/, "~");

function AgentRow({ a, now, child }: { a: Agent; now: number; child?: boolean }) {
  return (
    <li className={`agent ${a.state}${child ? " child" : ""}`} title={a.title}>
      <div className="line">
        <span className="dot" />
        <b>{a.name}</b>
        <span className="dim">{short(a.repo ?? a.cwd)}</span>
        <span className="right dim">{ago(now, a.lastActive)}</span>
      </div>
      {a.doing && <div className="doing">{a.doing}</div>}
    </li>
  );
}

function App() {
  const [s, setS] = useState<State | null>(null);
  const [err, setErr] = useState(false);
  const [showClosed, setShowClosed] = useState(false);

  useEffect(() => {
    let on = true;
    const tick = () =>
      fetch("/api/state")
        .then((r) => r.json() as Promise<State>)
        .then((d) => on && (setS(d), setErr(false)))
        .catch(() => on && setErr(true));
    tick();
    const id = setInterval(tick, 1500);
    return () => { on = false; clearInterval(id); };
  }, []);

  if (!s) return <p className="dim pad">{err ? "server down" : "loading"}</p>;

  const visible = s.agents.filter((a) => showClosed || a.state === "working" || a.state === "idle");
  const ids = new Set(visible.map((a) => a.id));
  const roots = visible.filter((a) => !a.parent || !ids.has(a.parent));
  const kids = (id: string) => visible.filter((a) => a.parent === id);
  const working = s.agents.filter((a) => a.state === "working").length;

  return (
    <main>
      <header>
        <h1>hubert</h1>
        <span className="dim">{working} working · {s.agents.length} recent{err && " · stale"}</span>
        <label className="right dim">
          <input type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} /> closed
        </label>
      </header>

      <section>
        <h2>Agents</h2>
        <ul>
          {roots.map((a) => [
            <AgentRow key={a.id} a={a} now={s.now} />,
            ...kids(a.id).map((k) => <AgentRow key={k.id} a={k} now={s.now} child />),
          ])}
          {!roots.length && <li className="dim">none</li>}
        </ul>
      </section>

      {s.repos.map((r) => (
        <section key={r.root}>
          <h2>
            {r.name} <span className="dim">{r.branch} · {r.agents.join(", ")}</span>
            <button
              className="right"
              onClick={() => fetch("/api/lazygit", { method: "POST", body: JSON.stringify({ root: r.root }) })}
            >
              lazygit
            </button>
          </h2>
          <ul className="files">
            {r.files.map((f) => (
              <li key={f.path}>
                <span className={`st st-${f.status[0]}`}>{f.status}</span>
                <span className="path" title={f.path}>{f.path}</span>
                <span className="right">
                  {f.add > 0 && <span className="add">+{f.add}</span>} {f.del > 0 && <span className="del">-{f.del}</span>}
                </span>
              </li>
            ))}
            {!r.files.length && <li className="dim">clean</li>}
          </ul>
        </section>
      ))}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
