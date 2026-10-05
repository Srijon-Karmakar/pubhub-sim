import { useEffect, useRef, useState } from 'react';
import { carInput } from '../../game/carInput';
import { runner } from '../../game/runner';
import { haptic } from '../../lib/haptics';

const MAX_TURN = 140; // degrees of wheel rotation at full lock

/** Drag in a circle (or sideways) to steer; it springs back to centre when released. */
export function SteeringWheel({ steer }: { steer: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; startAngle: number; startSteer: number } | null>(null);
  const [active, setActive] = useState(false);

  const angleOf = (x: number, y: number) => {
    const r = ref.current!.getBoundingClientRect();
    return (Math.atan2(x - (r.left + r.width / 2), -(y - (r.top + r.height / 2))) * 180) / Math.PI;
  };

  return (
    <div
      ref={ref}
      className={`wheel ${active ? 'active' : ''}`}
      role="slider"
      aria-label="Steering wheel"
      aria-valuemin={-1}
      aria-valuemax={1}
      aria-valuenow={Number(steer.toFixed(2))}
      onPointerDown={(e) => {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        drag.current = { id: e.pointerId, startAngle: angleOf(e.clientX, e.clientY), startSteer: carInput.touchSteer };
        carInput.touchActive = true;
        setActive(true);
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d || d.id !== e.pointerId) return;
        let delta = angleOf(e.clientX, e.clientY) - d.startAngle;
        if (delta > 180) delta -= 360;
        if (delta < -180) delta += 360;
        const next = Math.max(-1, Math.min(1, d.startSteer + delta / MAX_TURN));
        if (Math.abs(next) === 1 && Math.abs(carInput.touchSteer) < 1) haptic(8);
        carInput.touchSteer = next;
      }}
      onPointerUp={() => {
        drag.current = null;
        carInput.touchActive = false;
        carInput.touchSteer = 0;
        setActive(false);
      }}
      onPointerCancel={() => {
        drag.current = null;
        carInput.touchActive = false;
        carInput.touchSteer = 0;
        setActive(false);
      }}
    >
      <svg viewBox="0 0 100 100" style={{ transform: `rotate(${steer * MAX_TURN}deg)` }}>
        <circle cx="50" cy="50" r="44" fill="none" stroke="currentColor" strokeWidth="9" />
        <circle cx="50" cy="50" r="44" fill="none" stroke="rgba(0,0,0,.35)" strokeWidth="9" strokeDasharray="10 266" strokeDashoffset="-133" />
        <path d="M8 52 L36 56 L42 66 L58 66 L64 56 L92 52" fill="none" stroke="currentColor" strokeWidth="8" strokeLinejoin="miter" />
        <path d="M44 66 L44 92 M56 66 L56 92" stroke="currentColor" strokeWidth="7" />
        <rect x="40" y="46" width="20" height="14" fill="currentColor" />
        <rect x="46" y="3" width="8" height="9" fill="var(--primary)" />
      </svg>
    </div>
  );
}

function Pedal({ kind, label, value }: { kind: 'gas' | 'brake'; label: string; value: number }) {
  const set = (on: boolean) => {
    if (kind === 'gas') carInput.throttleHeld = on;
    else carInput.brakeHeld = on;
    if (on) haptic(kind === 'brake' ? 12 : 6);
  };
  return (
    <button
      className={`pedal ${kind} ${value > 0.05 ? 'on' : ''}`}
      aria-label={label}
      onPointerDown={(e) => {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        set(true);
      }}
      onPointerUp={() => set(false)}
      onPointerCancel={() => set(false)}
      onPointerLeave={(e) => {
        if (e.buttons === 0) set(false);
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <span className="fill" style={{ transform: `scaleY(${value})` }} />
      <span className="ribs" />
      <small>{label}</small>
    </button>
  );
}

export function Pedals({ throttle, brake }: { throttle: number; brake: number }) {
  return (
    <div className="pedals">
      <Pedal kind="brake" label="Brake" value={brake} />
      <Pedal kind="gas" label="Gas" value={throttle} />
    </div>
  );
}

export function GearSwitch({ gear }: { gear: 'D' | 'R' }) {
  return (
    <div className="gear" role="radiogroup" aria-label="Gear">
      {(['D', 'R'] as const).map((g) => (
        <button key={g} role="radio" aria-checked={gear === g} className={gear === g ? 'on' : ''} onClick={() => runner.setGear(g)}>
          {g}
        </button>
      ))}
    </div>
  );
}

/** Keyboard driving: W/S or ↑/↓ pedals, A/D or ←/→ steering, R toggles reverse. */
export function useCarKeyboard(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    const set = (e: KeyboardEvent, on: boolean) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return false;
      switch (e.key.toLowerCase()) {
        case 'w':
        case 'arrowup':
          carInput.throttleHeld = on;
          return true;
        case 's':
        case 'arrowdown':
          carInput.brakeHeld = on;
          return true;
        case 'a':
        case 'arrowleft':
          carInput.keyLeft = on;
          return true;
        case 'd':
        case 'arrowright':
          carInput.keyRight = on;
          return true;
      }
      return false;
    };
    const down = (e: KeyboardEvent) => {
      if (set(e, true)) e.preventDefault();
    };
    const up = (e: KeyboardEvent) => {
      if (set(e, false)) e.preventDefault();
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, [enabled]);
}
