import { useEffect, useRef, useState } from "react";

const SIZE = 56;
const STORAGE = "hubert.mascot.position";
type Point = { x: number; y: number };
const DEFAULT: Point = { x: 0.92, y: 0.82 };
export const clamp = (n: number) => Math.min(1, Math.max(0, Number.isFinite(n) ? n : 0));
export const bounds = (p: Point, width: number, height: number) => ({
  x: Math.round(clamp(p.x) * Math.max(0, width - Math.min(SIZE, width))),
  y: Math.round(clamp(p.y) * Math.max(0, height - Math.min(SIZE, height))),
});

/** Fixed viewport mascot. `roam` enables slow wandering; changing `resetKey` restores the default position. */
export function Mascot({ roam = false, resetKey }: { roam?: boolean; resetKey?: number }) {
  const [point, setPoint] = useState<Point>(() => {
    try {
      const value = JSON.parse(localStorage.getItem(STORAGE) ?? "null");
      return value && Number.isFinite(value.x) && Number.isFinite(value.y)
        ? { x: clamp(value.x), y: clamp(value.y) } : DEFAULT;
    } catch { return DEFAULT; }
  });
  const [size, setSize] = useState(() => ({ width: innerWidth, height: innerHeight }));
  const [reduced, setReduced] = useState(false);
  const drag = useRef<{ id: number; dx: number; dy: number } | null>(null);
  const previousReset = useRef(resetKey);

  useEffect(() => {
    const resize = () => setSize({ width: innerWidth, height: innerHeight });
    window.addEventListener("resize", resize);
    const query = matchMedia("(prefers-reduced-motion: reduce)");
    const motion = () => setReduced(query.matches);
    motion();
    query.addEventListener("change", motion);
    return () => { window.removeEventListener("resize", resize); query.removeEventListener("change", motion); };
  }, []);
  useEffect(() => {
    if (previousReset.current === resetKey) return;
    previousReset.current = resetKey;
    setPoint(DEFAULT);
  }, [resetKey]);
  useEffect(() => { try { localStorage.setItem(STORAGE, JSON.stringify(point)); } catch { /* private browsing */ } }, [point]);
  useEffect(() => {
    if (!roam || reduced) return;
    const timer = window.setInterval(() => {
      if (!drag.current) setPoint(p => ({ x: clamp(p.x + (Math.random() - 0.5) * 0.08), y: clamp(p.y + (Math.random() - 0.5) * 0.06) }));
    }, 5500);
    return () => clearInterval(timer);
  }, [roam, reduced]);

  const pos = bounds(point, size.width, size.height);
  const move = (x: number, y: number) => setPoint({
    x: clamp(x / Math.max(1, size.width - Math.min(SIZE, size.width))),
    y: clamp(y / Math.max(1, size.height - Math.min(SIZE, size.height))),
  });
  return <button type="button" className="hubert-mascot-drag" aria-label="Move Hubert mascot; use arrow keys to reposition" title="Drag Hubert or use arrow keys"
    style={{ left: pos.x, top: pos.y, transition: drag.current ? "none" : undefined }}
    onPointerDown={e => {
      if (e.button !== 0) return;
      drag.current = { id: e.pointerId, dx: e.clientX - pos.x, dy: e.clientY - pos.y };
      e.currentTarget.setPointerCapture(e.pointerId);
    }}
    onPointerMove={e => { if (drag.current?.id === e.pointerId) move(e.clientX - drag.current.dx, e.clientY - drag.current.dy); }}
    onPointerUp={e => { if (drag.current?.id === e.pointerId) drag.current = null; }}
    onPointerCancel={e => { if (drag.current?.id === e.pointerId) drag.current = null; }}
    onKeyDown={e => {
      const offset: Record<string, [number, number]> = { ArrowLeft: [-10, 0], ArrowRight: [10, 0], ArrowUp: [0, -10], ArrowDown: [0, 10] };
      const delta = offset[e.key];
      if (delta) { e.preventDefault(); move(pos.x + delta[0], pos.y + delta[1]); }
    }}>
    <img src="/docs/mascot.png" alt="" draggable={false} className="hubert-mascot" />
  </button>;
}
