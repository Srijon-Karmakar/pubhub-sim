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

export function SignalLamp({ sig, units, rail }: { sig: HudSnapshot['nextSignal']; units: Units; rail: boolean }) {
  if (!sig) return null;
  const red = sig.state === 'red';
  return (
    <motion.div className={`signal-lamp ${red ? 'red' : 'green'}`} initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }}>
      <span className="head">
        <i className={red ? 'on' : ''} />
        {!rail && <i className="amber" />}
        <i className={red ? '' : 'on'} />
      </span>
      <span className="txt num">
        <b>{red ? (rail ? 'STOP' : 'RED') : 'CLEAR'}</b>
        <small>{shortDistance(Math.max(0, sig.dist), units)}</small>
      </span>
    </motion.div>
  );
}

export function StreakPill({ streak, mult }: { streak: number; mult: number }) {
  if (streak < 1) return null;
  return (
    <motion.div key={streak} className="streak-pill" initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: 'spring', stiffness: 500, damping: 18 }}>
      <small>STREAK {streak}</small>
      <b className="num">×{mult.toFixed(2).replace(/0$/, '')}</b>
    </motion.div>
  );
}

export function ComfortMeter({ comfort }: { comfort: number }) {
  const col = comfort < 40 ? 'var(--bad)' : comfort < 70 ? 'var(--warn)' : 'var(--good)';
  return (
    <div className="comfort-meter glass" title="Ride comfort: smooth acceleration and braking keep it up">
      <small>COMFORT</small>
      <div className="bar">
        <i style={{ width: `${Math.round(comfort)}%`, background: col }} />
      </div>
    </div>
  );
}

export function deltaClass(d: number) {
  if (d > 60) return 'vlate';
  if (d > 15) return 'late';
  if (d < -15) return 'early';
  return 'ok';
}

export function NextCard({ snap, lineRef, colour, textColour, units, mode, free }: { snap: HudSnapshot; lineRef: string; colour: string; textColour: string; units: Units; mode: Mode; free?: boolean }) {
  const targets = useHud((s) => s.stopTargets);
  const off = useHud((s) => s.utcOffset);
  const atStop = snap.served;
  const label = atStop ? (snap.k === snap.stopsTotal - 1 ? 'Terminus' : snap.car ? 'At stop' : 'At platform') : snap.k === snap.stopsTotal - 1 ? 'Next · Terminus' : 'Next stop';
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
        {free ? (
          <span className="delta free">Free drive</span>
        ) : (
          <span className={`delta ${deltaClass(delta)}`}>{Math.abs(delta) <= 15 ? 'On time' : delta < 0 ? `${signedMmss(delta)} early` : `${signedMmss(delta)} late`}</span>
        )}
        {(atStop ? snap.onboard > 0 : snap.waiting > 0) && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, marginLeft: 'auto' }} title={atStop ? 'On board' : 'Waiting at next stop'}>
            <Users size={13} /> {(atStop ? snap.onboard : snap.waiting).toLocaleString()}
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

export function BoardingCard({ snap, autoDoors, free }: { snap: HudSnapshot; autoDoors: boolean; free?: boolean }) {
  const load = Math.min(1, snap.onboard / snap.capacity);
  const doorsOpen = snap.doors === 'open' || snap.doors === 'opening';
  const late = snap.departIn < -15;
  const last = snap.k === snap.stopsTotal - 1;
  let label: string;
  let value = '';
  let tone = '';
  if (last) label = snap.flowDone ? 'Shift complete' : 'Passengers leaving';
  else if (free) label = snap.doors === 'closed' ? 'Go any time' : 'Depart any time';
  else if (snap.doors === 'closed' && snap.departIn > 3) {
    label = 'Hold';
    value = mmss(snap.departIn);
    tone = 'info';
  } else if (snap.doors === 'closed') {
    label = 'Push lever to depart';
    tone = 'good';
  } else if (snap.departIn > 0) {
    label = 'Depart';
    value = mmss(snap.departIn);
  } else if (late) {
    label = 'Late';
    value = '+' + mmss(-snap.departIn);
    tone = 'warn';
  } else {
    label = 'Depart now';
    tone = 'good';
  }
  return (
    <motion.div className="board" initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }}>
      <div className="board-row">
        <span className="flows num">
          <span className={snap.alightLeft ? 'warn' : ''}>
            <ArrowDown size={13} />
            {snap.alightLeft}
          </span>
          <span className={snap.boardLeft ? 'good' : ''}>
            <ArrowUp size={13} />
            {snap.boardLeft}
          </span>
        </span>
        <span className={`cd num ${tone}`}>
          <small>{label}</small>
          {value && <b>{value}</b>}
        </span>
        {!last && doorsOpen && !autoDoors && (
          <button className={`board-btn ${snap.flowDone && snap.departIn <= 3 ? 'hot' : ''}`} onClick={() => runner.doors()} aria-label="Close doors">
            <DoorClosed size={14} /> Close
          </button>
        )}
        {snap.doors === 'closing' && <span className="spinner" style={{ color: 'var(--warn)', width: 14, height: 14 }} />}
      </div>
      <div className="load" title={`${snap.onboard} / ${snap.capacity} on board`}>
        <i style={{ width: `${load * 100}%` }} />
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
  if (snap.car) {
    if (snap.served && snap.k === 0 && snap.doors !== 'closed') {
      msg = 'Passengers are boarding. Close the doors when the timer hits zero.';
      Icon = DoorClosed;
    } else if (snap.served && snap.doors === 'closed' && snap.speed < 0.5) {
      msg = 'Hold GAS to drive. Drag the wheel (or A/D) to steer along the highlighted road.';
      Icon = ArrowUp;
    } else if (!snap.served && snap.inZone && snap.speed === 0) {
      msg = snap.kerbOk ? 'Nice! Tap the door button to open the doors.' : 'Pull in closer to the kerb, then open the doors.';
      Icon = DoorOpen;
    } else if (!snap.served && snap.distToStop < p.approach) {
      msg = 'Hold BRAKE to stop beside the green zone, close to the kerb.';
      Icon = ArrowDown;
    } else if (!snap.served && snap.speed > 1) {
      msg = 'Keep on the route and under the speed limit. Gear R reverses when stopped.';
      Icon = Gauge;
    }
  } else if (snap.served && snap.k === 0 && snap.doors !== 'closed') {
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
