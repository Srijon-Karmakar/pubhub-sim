import { useEffect, useRef, useState } from 'react';
import { runner } from '../../game/runner';

function label(n: number, min: number) {
  if (n === 0) return 'N';
  if (n > 0) return `P${n}`;
  if (n === min) return 'EB';
  return `B${-n}`;
}

function colour(n: number, min: number, maxP: number, maxB: number) {
  if (n === 0) return 'linear-gradient(180deg,#64748b,#475569)';
  if (n > 0) {
    const t = n / maxP;
    return `linear-gradient(180deg, hsl(75 100% ${60 - t * 8}%), hsl(78 100% ${44 - t * 6}%))`;
  }
  if (n === min) return 'linear-gradient(180deg,#ef4444,#b91c1c)';
  const t = -n / maxB;
  return `linear-gradient(180deg, hsl(${42 - t * 30} 95% ${55 - t * 6}%), hsl(${34 - t * 28} 90% ${44 - t * 6}%))`;
}

/** Master controller: one vertical lever, power above neutral, brake below. */
export function Lever({ notch, maxP, maxB }: { notch: number; maxP: number; maxB: number }) {
  const min = -(maxB + 1);
  const count = maxP + maxB + 2;
  const trackRef = useRef<HTMLDivElement>(null);
  const [local, setLocal] = useState(notch);
  const dragging = useRef(false);

  useEffect(() => {
    if (!dragging.current) setLocal(notch);
  }, [notch]);

  const idxOf = (n: number) => maxP - n;
  const yPct = (n: number) => ((idxOf(n) + 0.5) / count) * 100;

  const fromY = (clientY: number) => {
    const el = trackRef.current;
    if (!el) return local;
    const r = el.getBoundingClientRect();
    const f = Math.min(0.9999, Math.max(0, (clientY - r.top) / r.height));
    const idx = Math.floor(f * count);
    return maxP - idx;
  };

  const set = (n: number) => {
    const c = Math.max(min, Math.min(maxP, n));
    setLocal(c);
    runner.setNotch(c);
  };

  const ticks: number[] = [];
  for (let n = maxP; n >= min; n--) ticks.push(n);

  return (
    <div
      className="lever glass"
      role="slider"
      aria-label="Master controller"
      aria-valuemin={min}
      aria-valuemax={maxP}
      aria-valuenow={local}
      aria-valuetext={label(local, min)}
      tabIndex={0}
      onPointerDown={(e) => {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        dragging.current = true;
        set(fromY(e.clientY));
      }}
      onPointerMove={(e) => {
        if (!dragging.current) return;
        set(fromY(e.clientY));
      }}
      onPointerUp={() => (dragging.current = false)}
      onPointerCancel={() => (dragging.current = false)}
      onWheel={(e) => set(local + (e.deltaY < 0 ? 1 : -1))}
    >
      <div className="lever-track" ref={trackRef}>
        <div className="lever-zone power" style={{ height: `${(maxP / count) * 100}%` }} />
        <div className="lever-zone brake" style={{ top: `${((maxP + 1) / count) * 100}%`, height: `${(maxB / count) * 100}%` }} />
        <div className="lever-zone eb" style={{ height: `${(1 / count) * 100}%` }} />
        {ticks.map((n) => (
          <div key={n} className={`lever-tick ${n === 0 ? 'n' : ''}`} style={{ top: `${((idxOf(n) + 1) / count) * 100}%`, display: n === min ? 'none' : undefined }}>
            <span />
          </div>
        ))}
        <div
          className="lever-handle"
          style={{
            top: `${yPct(local)}%`,
            background: colour(local, min, maxP, maxB),
            color: local > 0 ? '#0b0f00' : '#fff',
            transition: dragging.current ? 'background .15s' : 'top .18s cubic-bezier(.34,1.56,.64,1), background .2s',
          }}
        >
          {label(local, min)}
        </div>
      </div>
    </div>
  );
}
