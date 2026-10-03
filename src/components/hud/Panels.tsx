import { AlertOctagon, ArrowDown, ArrowUp, DoorClosed, DoorOpen, Gauge, Hand, Sparkles, Users, X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import type { Mode } from '../../types';
import type { HudSnapshot } from '../../lib/sim/engine';
import type { VehicleProfile } from '../../lib/sim/profiles';
import { distance, mmss, shortDistance, signedMmss, type Units } from '../../lib/format';
import { formatClock } from '../../lib/env/sun';
import { runner } from '../../game/runner';
import { useHud } from '../../store/hud';
import { useSettings } from '../../store/settings';
import { LineBadge } from '../ui/primitives';

export function deltaClass(d: number) {
  if (d > 60) return 'vlate';
  if (d > 15) return 'late';
  if (d < -15) return 'early';
  return 'ok';
}

export function NextCard({ snap, lineRef, colour, textColour, units, mode }: { snap: HudSnapshot; lineRef: string; colour: string; textColour: string; units: Units; mode: Mode }) {
  const targets = useHud((s) => s.stopTargets);
  const off = useHud((s) => s.utcOffset);
  const atStop = snap.served;
  const label = atStop ? (snap.k === snap.stopsTotal - 1 ? 'Terminus' : 'At platform') : snap.k === snap.stopsTotal - 1 ? 'Next · Terminus' : 'Next stop';
  const delta = snap.delta;
  const sched = atStop ? snap.schedDep : snap.schedArr;
  return (
    <div className="next-card glass">
      <div className="row1">
        <LineBadge text={lineRef} colour={colour} textColour={textColour} mode={mode} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="lbl">{label}</div>
          <div className="nm">{snap.stopName}</div>
        </div>
      </div>
      <div className="row2 num">
        {!atStop && <span>{distance(Math.max(0, snap.distToStop), units)}</span>}
        {!atStop && <span style={{ opacity: 0.4 }}>·</span>}
        <span>
          {atStop ? 'dep' : 'arr'} {formatClock(runnerClock(sched), off)}
        </span>
        <span className={`delta ${deltaClass(delta)}`}>{Math.abs(delta) <= 15 ? 'On time' : delta < 0 ? `${signedMmss(delta)} early` : `${signedMmss(delta)} late`}</span>
        {!atStop && snap.waiting > 0 && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, marginLeft: 'auto' }}>
            <Users size={13} /> {snap.waiting}
          </span>
        )}
      </div>
      <div className="progress-strip">
        <div className="track">
          <div className="fill" style={{ width: `${snap.progress * 100}%` }} />
        </div>
        {targets.map((t, i) => (
          <span key={i} className={`sdot ${i < snap.k || (i === snap.k && snap.served) ? 'done' : i === snap.k ? 'next' : ''}`} style={{ left: `${t * 100}%` }} />
        ))}
        <span className="veh" style={{ left: `${snap.progress * 100}%` }} />
      </div>
    </div>
  );
}

function runnerClock(schedSec: number) {
  const e = runner.engine;
  return e ? e.clockStartUtc + schedSec * 1000 : Date.now();
}

export function ApproachGauge({ snap, p, units, assists }: { snap: HudSnapshot; p: VehicleProfile; units: Units; assists: boolean }) {
  const d = snap.distToStop;
  const tol = p.tol[3];
  const t1 = p.tol[1];
  const k = 6;
  const target = 0.78;
  const far = Math.log(1 + p.approach / k);
  const over = Math.log(1 + (tol * 2.5) / k);
  const x = (dist: number) =>
    dist >= 0 ? target - (Math.log(1 + dist / k) / far) * target : target + (Math.log(1 + -dist / k) / over) * (1 - target);
  const clampX = (v: number) => Math.max(0, Math.min(1, v));
  const v = snap.speed;
  const brakeDist = (v * v) / (2 * 0.62 * p.brake);
  const needBrake = assists && d > 0 && snap.reqDecel > 0.55 * p.brake;
  let hint = '';
  let hintColor = 'var(--text-2)';
  if (snap.inZone && v === 0) {
    hint = 'Open doors';
    hintColor = 'var(--good)';
  } else if (d < -tol) {
    hint = v === 0 ? 'Overshot' : 'Too far!';
    hintColor = 'var(--bad)';
  } else if (needBrake) {
    hint = `Brake · B${snap.brakeHint}`;
    hintColor = 'var(--warn)';
  } else if (v === 0 && d > tol) {
    hint = 'Creep forward';
  } else if (snap.inZone) {
    hint = 'In zone, stop!';
    hintColor = 'var(--good)';
  }
  return (
    <motion.div className="approach glass" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 12 }}>
      <div className="top">
        <span className="dist num" style={{ color: snap.inZone ? 'var(--good)' : d < -tol ? 'var(--bad)' : undefined }}>
          {d >= 0 ? shortDistance(d, units) : `+${shortDistance(-d, units)}`}
        </span>
        <span className="hint" style={{ color: hintColor }}>
          {hint}
        </span>
      </div>
      <div className="ruler">
        <div className="zone" style={{ left: `${clampX(x(tol)) * 100}%`, width: `${(clampX(x(-tol)) - clampX(x(tol))) * 100}%` }} />
        <div className="core" style={{ left: `${clampX(x(t1)) * 100}%`, width: `${(clampX(x(-t1)) - clampX(x(t1))) * 100}%` }} />
        <div className="target" style={{ left: `${target * 100}%` }} />
        {assists && d > 0 && v > 0.5 && brakeDist < p.approach && <div className="brakept" style={{ left: `${clampX(x(brakeDist)) * 100}%` }} />}
        <div className="marker" style={{ left: `${clampX(x(d)) * 100}%` }} />
      </div>
    </motion.div>
  );
}

export function BoardingCard({ snap, autoDoors }: { snap: HudSnapshot; autoDoors: boolean }) {
  const load = Math.min(1, snap.onboard / snap.capacity);
  const doorsOpen = snap.doors === 'open' || snap.doors === 'opening';
  const late = snap.departIn < -15;
  const last = snap.k === snap.stopsTotal - 1;
  return (
    <motion.div className="board glass" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 12 }}>
      <div className="flows num">
        <span style={{ color: snap.alightLeft ? 'var(--warn)' : 'var(--text-3)' }}>
          <ArrowDown size={16} /> {snap.alightLeft}
        </span>
        <span style={{ color: snap.boardLeft ? 'var(--good)' : 'var(--text-3)' }}>
          <ArrowUp size={16} /> {snap.boardLeft}
        </span>
        <span style={{ marginLeft: 'auto', color: 'var(--text-2)', fontSize: 13 }}>
          <Users size={15} /> {snap.onboard.toLocaleString()} / {snap.capacity.toLocaleString()}
        </span>
      </div>
      <div className="load">
        <i style={{ width: `${load * 100}%` }} />
      </div>
      <div className="foot">
        {last ? (
          <span className="cd" style={{ fontSize: 16 }}>
            {snap.flowDone ? 'Shift complete' : 'Passengers leaving…'}
          </span>
        ) : snap.doors === 'closed' && snap.departIn > 3 ? (
          <span className="num">
            <span className="faint" style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.1em', display: 'block' }}>
              HOLD FOR TIMETABLE
            </span>
            <span className="cd" style={{ color: 'var(--info)' }}>{mmss(snap.departIn)}</span>
          </span>
        ) : snap.doors === 'closed' ? (
          <span style={{ fontWeight: 700, fontSize: 14, color: 'var(--good)' }}>Doors closed. Push the lever to depart</span>
        ) : (
          <span className="num">
            <span className="faint" style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.1em', display: 'block' }}>
              {snap.departIn > 0 ? 'DEPART IN' : late ? 'RUNNING LATE' : 'DEPART NOW'}
            </span>
            <span className="cd" style={{ color: snap.departIn > 0 ? undefined : late ? 'var(--warn)' : 'var(--good)' }}>
              {mmss(Math.abs(snap.departIn))}
            </span>
          </span>
        )}
        {!last && doorsOpen && !autoDoors && (
          <button className={`btn ${snap.flowDone && snap.departIn <= 3 ? 'btn-primary' : 'btn-soft'}`} onClick={() => runner.doors()}>
            <DoorClosed size={17} /> Close doors
          </button>
        )}
        {snap.doors === 'closing' && <span className="spinner" style={{ color: 'var(--warn)' }} />}
      </div>
    </motion.div>
  );
}

export function Toasts() {
  const toasts = useHud((s) => s.toasts);
  return (
    <div className="toasts">
      <AnimatePresence>
        {toasts.map((t) =>
          t.kind === 'score' ? (
            <motion.div
              key={t.id}
              className={`score-pop ${t.tone}`}
              initial={{ opacity: 0, scale: 0.6, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, y: -30, scale: 0.9 }}
              transition={{ type: 'spring', stiffness: 420, damping: 22 }}
            >
              <div className="lab">{t.label}</div>
              {t.sub && <div className="sub">{t.sub}</div>}
              {t.points !== undefined && t.points !== 0 && <span className={`pts ${t.points < 0 ? 'neg' : ''}`}>{t.points > 0 ? `+${t.points}` : t.points}</span>}
            </motion.div>
          ) : (
            <motion.div
              key={t.id}
              className={`msg-toast glass-strong ${t.tone}`}
              initial={{ opacity: 0, y: 10, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
            >
              {t.tone === 'bad' ? <AlertOctagon size={17} /> : t.tone === 'warn' ? <Hand size={17} /> : <Sparkles size={17} />}
              {t.label}
            </motion.div>
          ),
        )}
      </AnimatePresence>
    </div>
  );
}

export function Coach({ snap, p }: { snap: HudSnapshot; p: VehicleProfile }) {
  const done = useSettings((s) => s.tutorialDone);
  const set = useSettings((s) => s.set);
  if (done) return null;
  let msg: string | null = null;
  let Icon = Sparkles;
  if (snap.served && snap.k === 0 && snap.doors !== 'closed') {
    msg = 'Passengers are boarding. When the timer hits zero, close the doors.';
    Icon = DoorClosed;
  } else if (snap.served && snap.doors === 'closed' && snap.speed < 0.5) {
    msg = 'Drag the lever up (P) to apply power. Centre (N) is coasting.';
    Icon = ArrowUp;
  } else if (!snap.served && snap.inZone && snap.speed === 0) {
    msg = 'Nice stop! Tap the door button to open the doors.';
    Icon = DoorOpen;
  } else if (!snap.served && snap.distToStop < p.approach) {
    msg = 'Pull the lever down (B) to brake. Stop the front of the vehicle in the green zone.';
    Icon = ArrowDown;
  } else if (!snap.served && snap.speed > 1) {
    msg = 'Stay under the red speed sign. Upcoming limits appear above it.';
    Icon = Gauge;
  }
  if (!msg) return null;
  return (
    <motion.div key={msg} className="coach glass-strong" initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }}>
      <span className="ico">
        <Icon size={19} />
      </span>
      <span style={{ flex: 1 }}>{msg}</span>
      <button className="icon-btn" style={{ width: 32, height: 32 }} onClick={() => set({ tutorialDone: true })} aria-label="Dismiss tips">
        <X size={16} />
      </button>
    </motion.div>
  );
}
