import type { RouteData, StopRating, WeatherKind } from '../../types';
import { clamp } from '../geo';
import { hashString, mulberry32, planPassengers, type PaxPlan } from './passengers';
import { PROFILES, vehicleLength, type VehicleProfile } from './profiles';
import { buildTimetable, idealTimeBetween, type Timetable } from './timetable';
import { Track } from './track';

export type Tone = 'perfect' | 'great' | 'good' | 'info' | 'warn' | 'bad';
export type SoundId =
  | 'doorOpen'
  | 'doorClose'
  | 'doorWarn'
  | 'atp'
  | 'overspeed'
  | 'arrive'
  | 'airRelease'
  | 'slip'
  | 'score'
  | 'bad'
  | 'buffer'
  | 'signal';

export type GameEvent =
  | { type: 'score'; label: string; points: number; tone: Tone; sub?: string }
  | { type: 'toast'; text: string; tone: Tone }
  | { type: 'sound'; id: SoundId }
  | { type: 'announce'; text: string }
  | { type: 'haptic'; pattern: number | number[] }
  | { type: 'finished' };

export type DoorState = 'closed' | 'opening' | 'open' | 'closing';

export interface EngineOptions {
  route: RouteData;
  startIdx: number;
  endIdx: number;
  clockStartUtc: number;
  hourLocal: number;
  weather: WeatherKind;
  autoDoors: boolean;
  /** free drive: no speed limits, ATP, timetable or score */
  free?: boolean;
}

export interface HudSnapshot {
  t: number;
  clockUtc: number;
  speed: number;
  accel: number;
  limit: number;
  nextLimit: { dist: number; v: number } | null;
  notch: number;
  doors: DoorState;
  doorProgress: number;
  k: number;
  stopsTotal: number;
  stopName: string;
  nextStopName?: string;
  distToStop: number;
  inZone: boolean;
  canOpen: boolean;
  served: boolean;
  flowDone: boolean;
  alightLeft: number;
  boardLeft: number;
  onboard: number;
  capacity: number;
  waiting: number;
  departIn: number;
  delta: number;
  schedArr: number;
  schedDep: number;
  comfort: number;
  score: number;
  overspeed: boolean;
  atp: boolean;
  slip: boolean;
  inTunnel: boolean;
  canReverse: boolean;
  nextSignal: { dist: number; state: 'red' | 'green' } | null;
  streak: number;
  mult: number;
  reversing: boolean;
  reqDecel: number;
  brakeHint: number;
  progress: number;
  finished: boolean;
}

export interface Signal {
  s: number;
  /** this signal will be red on approach */
  red: boolean;
  /** seconds it stays red once the driver can see it */
  wait: number;
  clearAt: number;
  state: 'red' | 'green';
  seen: boolean;
  waited: boolean;
  passed: boolean;
}

const ADHESION: Record<WeatherKind, number> = { clear: 9, cloudy: 9, fog: 9, rain: 0.9, storm: 0.8, snow: 0.68 };

export class Engine {
  readonly route: RouteData;
  readonly profile: VehicleProfile;
  readonly track: Track;
  readonly tt: Timetable;
  readonly length: number;
  readonly plan: PaxPlan;
  readonly clockStartUtc: number;
  readonly weather: WeatherKind;
  autoDoors: boolean;
  readonly free: boolean;

  t = 0;
  s: number;
  v = 0;
  a = 0;
  private aTr = 0;
  dir: 1 | -1 = 1;
  notch = 0;
  doors: DoorState = 'open';
  doorT = 0;
  k = 0;
  served = true;
  departReady = false;
  stoppedS: number;
  stoppedTime = 0;
  onboard = 0;
  waiting: number[];
  alightLeft = 0;
  boardLeft = 0;
  private flowAcc = 0;
  comfort = 100;
  private comfortInt = 0;
  private runTime = 0;
  score = 0;
  readonly breakdown = new Map<string, number>();
  overspeed = false;
  overspeedT = 0;
  atp = false;
  atpCount = 0;
  private atpHold = 0;
  private dangerFlag = false;
  private ebFlag = false;
  slip = false;
  private slipT = 0;
  private reversedHere = false;
  maxSpeed = 0;
  distance = 0;
  ratings: StopRating[] = [];
  paxDelivered = 0;
  totalBoarded = 0;
  onTime = 0;
  finished = false;
  /** block signals (rail) or traffic lights (road) between stops */
  readonly signals: Signal[] = [];
  streak = 0;
  bestStreak = 0;
  events: GameEvent[] = [];
  private lastEmit: Record<string, number> = {};
  private brakeCap: number;
  private tractionCap: number;
  private fullWarned = false;

  constructor(o: EngineOptions) {
    this.route = o.route;
    this.profile = PROFILES[o.route.mode];
    this.track = new Track(o.route, this.profile);
    this.length = vehicleLength(this.profile);
    this.tt = buildTimetable(this.track, this.profile, o.route.stops, o.startIdx, o.endIdx, o.route.mode, this.profile.dwell + 8);
    this.s = this.tt.targets[0];
    this.stoppedS = this.s;
    this.clockStartUtc = o.clockStartUtc;
    this.weather = o.weather;
    this.autoDoors = o.autoDoors;
    this.free = !!o.free;
    this.plan = planPassengers(this.tt.stops, this.profile, o.hourLocal, hashString(`${o.route.id}:${o.startIdx}:${Math.floor(o.hourLocal)}`));
    this.waiting = this.plan.waiting.slice();
    this.boardLeft = this.waiting[0];
    this.doors = 'open';
    this.doorT = 99;
    this.brakeCap = ADHESION[o.weather] * this.profile.brake;
    this.tractionCap = ADHESION[o.weather] * this.profile.accel * 1.15;
    const last = this.tt.stops[this.tt.stops.length - 1];
    this.events.push({ type: 'announce', text: `This is the ${this.route.ref} service to ${last.name}.` });
    if (!this.free && this.profile.sound !== 'ship') this.placeSignals();
  }

  private placeSignals() {
    const p = this.profile;
    const rnd = mulberry32(hashString(`${this.route.id}:signals:${this.tt.targets[0].toFixed(0)}`));
    const T = this.tt.targets;
    let shift = 0;
    for (let k = 1; k < T.length; k++) {
      const a = T[k - 1] + 160;
      const b = T[k] - Math.max(p.rail ? 260 : 110, this.length * 0.6);
      if (b - a > (p.rail ? 420 : 200)) {
        const n = Math.max(1, Math.floor((b - a) / 1400));
        for (let j = 0; j < n; j++) {
          const red = rnd() < (p.rail ? 0.33 : 0.42);
          const wait = p.rail ? 12 + rnd() * 22 : 8 + rnd() * 14;
          this.signals.push({ s: a + ((b - a) * (j + 0.5)) / n, red, wait, clearAt: Infinity, state: red ? 'red' : 'green', seen: false, waited: false, passed: false });
          if (red) shift += wait * 0.9 + 10;
        }
      }
      // the timetable allows for the waits a careful driver will get
      this.tt.arr[k] = Math.round(this.tt.arr[k] + shift);
      this.tt.dep[k] = Math.round(this.tt.dep[k] + shift);
    }
  }

  private updateSignals(sPrev: number) {
    const p = this.profile;
    for (const g of this.signals) {
      if (g.passed) continue;
      const d = g.s - this.s;
      // approach release: the countdown starts once the driver is within braking range
      if (g.red && !g.seen && d < (p.rail ? 380 : 150)) {
        g.seen = true;
        g.clearAt = this.t + g.wait;

      }
      if (g.state === 'red' && g.seen && this.t >= g.clearAt) {
        g.state = 'green';
        this.emit({ type: 'sound', id: 'signal' });
        this.emit({ type: 'toast', text: p.rail ? 'Signal clear. Proceed' : 'Green light. Go', tone: 'info' });
      }
      if (g.state === 'red' && this.v === 0 && d > 0 && d < 150) g.waited = true;
      if (sPrev < g.s && this.s >= g.s) {
        g.passed = true;
        if (g.state === 'red') {
          const pen = p.rail ? -500 : -300;
          if (p.atp && !this.atp) {
            this.atp = true;
            this.atpCount++;
          }
          this.addPoints(p.rail ? 'Signals passed at danger' : 'Red lights run', pen);
          this.emit({ type: 'score', label: p.rail ? 'SIGNAL PASSED AT DANGER' : 'RAN A RED LIGHT', points: pen, tone: 'bad' });
          this.emit({ type: 'sound', id: p.atp ? 'atp' : 'bad' });
          this.emit({ type: 'haptic', pattern: [100, 50, 100, 50, 250] });
        } else if (g.red && g.waited) {
          this.addPoints('Signal discipline', 100);
          this.emit({ type: 'score', label: 'SIGNAL OBEYED', points: 100, tone: 'good' });
        }
      }
    }
  }

  get streakMult() {
    return 1 + Math.min(4, this.streak) * 0.25;
  }

  get maxNotch() {
    return this.profile.powerNotches;
  }
  get minNotch() {
    return -(this.profile.brakeNotches + 1);
  }

  setNotch(n: number) {
    this.notch = clamp(Math.round(n), this.minNotch, this.maxNotch);
  }

  setAutoDoors(on: boolean) {
    this.autoDoors = on;
  }

  private emit(e: GameEvent) {
    if (this.free && e.type === 'score') {
      // free drive keeps the stop feedback but drops points and penalties
      if (e.points < 0) return;
      e = { ...e, points: 0 };
    }
    this.events.push(e);
  }

  /** Emits at most once per `cooldown` seconds for a given key. */
  private once(key: string, cooldown: number, ...e: GameEvent[]) {
    const last = this.lastEmit[key] ?? -1e9;
    if (this.t - last < cooldown) return;
    this.lastEmit[key] = this.t;
    for (const ev of e) this.events.push(ev);
  }

  private addPoints(label: string, pts: number) {
    if (this.free) return;
    if (pts < 0 && this.streak > 0) {
      this.streak = 0;
      this.emit({ type: 'toast', text: 'Streak lost', tone: 'warn' });
    }
    this.score += pts;
    this.breakdown.set(label, (this.breakdown.get(label) ?? 0) + pts);
  }

  private get target() {
    return this.tt.targets[this.k];
  }
  private get isLast() {
    return this.k === this.tt.targets.length - 1;
  }

  toggleDoors() {
    if (this.finished) return;
    if (this.doors === 'open' || this.doors === 'opening') return this.closeDoors();
    if (this.doors === 'closing') return;
    if (this.v > 0.01) {
      this.once('doorsmoving', 2, { type: 'toast', text: 'Stop the vehicle first', tone: 'warn' });
      return;
    }
    const d = this.target - this.s;
    const tol = this.profile.tol[3];
    if (this.served && Math.abs(this.s - this.stoppedS) < 0.6) {
      this.openDoors(false);
      return;
    }
    if (!this.served && Math.abs(d) <= tol) {
      this.openDoors(true);
      return;
    }
    if (!this.served && d > tol) {
      this.once('notyet', 2, { type: 'toast', text: `Pull forward ${Math.round(d - tol + 1)} m to the platform`, tone: 'info' });
    } else if (!this.served && d < -tol) {
      this.once('past', 2, { type: 'toast', text: 'You overshot. Reverse to the platform', tone: 'warn' });
    } else {
      this.once('noplat', 2, { type: 'toast', text: 'No platform here', tone: 'info' });
    }
  }

  private openDoors(lockIn: boolean) {
    if (lockIn) this.lockIn();
    this.doors = 'opening';
    this.doorT = 0;
    this.emit({ type: 'sound', id: 'doorOpen' });
    this.emit({ type: 'haptic', pattern: 20 });
  }

  private closeDoors() {
    this.doors = 'closing';
    this.doorT = 0;
    this.emit({ type: 'sound', id: 'doorWarn' });
    const left = this.onboard < this.profile.capacity ? this.boardLeft : 0;
    if (left > 0 && !this.isLast) {
      const pen = -Math.min(100, left);
      this.addPoints('Passengers left behind', pen);
      this.emit({ type: 'score', label: 'Left behind', sub: `${left} passengers`, points: pen, tone: 'warn' });
    }
    this.boardLeft = 0;
  }

  private lockIn() {
    const p = this.profile;
    const d = this.target - this.s;
    const err = Math.abs(d);
    this.served = true;
    this.stoppedS = this.s;
    this.departReady = false;
    this.dir = 1;
    this.reversedHere = false;
    const [t0, t1, t2] = p.tol;
    const grade: StopRating['grade'] = err <= t0 ? 'perfect' : err <= t1 ? 'great' : err <= t2 ? 'good' : 'ok';
    const mult = this.streakMult;
    const pts = Math.round({ perfect: 300, great: 200, good: 120, ok: 50, missed: 0 }[grade] * mult);
    this.addPoints('Stop accuracy', pts);
    if (grade === 'perfect' || grade === 'great') {
      this.streak++;
      this.bestStreak = Math.max(this.bestStreak, this.streak);
    } else this.streak = 0;
    const delay = this.t - this.tt.arr[this.k];
    const stop = this.tt.stops[this.k];
    this.ratings.push({ name: stop.name, error: err, grade, delay, points: pts });
    const label = { perfect: 'PERFECT STOP', great: 'GREAT STOP', good: 'GOOD STOP', ok: 'STOPPED', missed: '' }[grade];
    const tone: Tone = grade === 'perfect' ? 'perfect' : grade === 'great' ? 'great' : grade === 'good' ? 'good' : 'info';
    const streakTxt = mult > 1 ? ` · ×${mult.toFixed(2).replace(/0$/, '')} streak` : '';
    this.emit({ type: 'score', label, sub: `${err < 0.1 ? '0.0' : err.toFixed(1)} m ${d >= 0 ? 'short' : 'over'}${streakTxt}`, points: pts, tone });
    this.emit({ type: 'sound', id: grade === 'perfect' || grade === 'great' ? 'score' : 'airRelease' });
    this.emit({ type: 'haptic', pattern: grade === 'perfect' ? [15, 40, 15, 40, 30] : [25] });

    this.alightLeft = Math.round(this.onboard * this.plan.alightFrac[this.k]);
    this.boardLeft = this.isLast ? 0 : this.waiting[this.k];
    this.fullWarned = false;
    if (this.isLast) {
      this.scorePunctuality(delay, 'arrival');
      this.emit({ type: 'announce', text: `${stop.name}. This is the final stop. Thank you for travelling with us.` });
    } else {
      this.emit({ type: 'announce', text: `${stop.name}.` });
    }
  }

  private scorePunctuality(delay: number, what: 'arrival' | 'departure') {
    if (this.free) return;
    let pts: number;
    let label: string;
    let tone: Tone;
    if (delay < -5 && what === 'departure') {
      pts = -150;
      label = 'EARLY DEPARTURE';
      tone = 'bad';
    } else if (Math.abs(delay) <= 15 || (what === 'arrival' && delay < 0)) {
      pts = 150;
      label = 'ON TIME';
      tone = 'perfect';
      this.onTime++;
    } else if (delay <= 60) {
      pts = 80;
      label = 'SLIGHTLY LATE';
      tone = 'good';
    } else if (delay <= 180) {
      pts = 20;
      label = 'LATE';
      tone = 'warn';
    } else {
      pts = 0;
      label = 'VERY LATE';
      tone = 'bad';
    }
    this.addPoints('Punctuality', pts);
    const sign = delay >= 0 ? '+' : '−';
    const a = Math.abs(Math.round(delay));
    this.emit({ type: 'score', label, sub: `${sign}${Math.floor(a / 60)}:${String(a % 60).padStart(2, '0')}`, points: pts, tone });
    if (pts < 0) this.emit({ type: 'sound', id: 'bad' });
  }

  private depart() {
    const delay = this.t - this.tt.dep[this.k];
    this.scorePunctuality(delay, 'departure');
    const r = this.ratings[this.ratings.length - 1];
    if (r && r.name === this.tt.stops[this.k].name && this.k > 0) r.delay = delay;
    this.k++;
    this.served = false;
    this.departReady = false;
    const next = this.tt.stops[this.k];
    this.emit({
      type: 'announce',
      text: this.isLast ? `The next stop is ${next.name}, where this service terminates.` : `The next stop is ${next.name}.`,
    });
  }

  private missStop() {
    const stop = this.tt.stops[this.k];
    this.addPoints('Missed stops', -300);
    this.ratings.push({ name: stop.name, error: Math.abs(this.target - this.s), grade: 'missed', delay: 0, points: -300 });
    this.emit({ type: 'score', label: 'MISSED STOP', sub: stop.name, points: -300, tone: 'bad' });
    this.emit({ type: 'sound', id: 'bad' });
    this.emit({ type: 'haptic', pattern: [60, 40, 60] });
    if (this.isLast) {
      this.finish();
      return;
    }
    this.k++;
    this.served = false;
    const next = this.tt.stops[this.k];
    this.emit({ type: 'announce', text: `The next stop is ${next.name}.` });
  }

  setReverse(on: boolean) {
    if (this.v > 0.01) return;
    if (on && !this.reversedHere) {
      this.reversedHere = true;
      this.addPoints('Reversing', -50);
      this.emit({ type: 'score', label: 'REVERSING', points: -50, tone: 'warn' });
    }
    this.dir = on ? -1 : 1;
  }

  private finish() {
    if (this.finished) return;
    this.finished = true;
    const avg = this.runTime > 0 ? this.comfortInt / this.runTime : this.comfort;
    this.addPoints('Ride comfort', Math.round(avg * 5));
    this.addPoints('Passengers delivered', this.paxDelivered);
    this.emit({ type: 'finished' });
  }

  get avgComfort() {
    return this.runTime > 0 ? this.comfortInt / this.runTime : this.comfort;
  }

  get maxScore() {
    const n = this.tt.stops.length;
    const pax = this.plan.waiting.reduce((a, b) => a + b, 0);
    return (n - 1) * 300 + n * 150 + 500 + pax;
  }

  step(dt: number) {
    if (this.finished) return;
    const p = this.profile;
    this.t += dt;

    // ---- doors -------------------------------------------------------
    if (this.doors === 'opening') {
      this.doorT += dt;
      if (this.doorT >= 2.2) {
        this.doors = 'open';
        this.doorT = 0;
      }
    } else if (this.doors === 'closing') {
      this.doorT += dt;
      if (this.doorT >= 3) {
        this.doors = 'closed';
        this.doorT = 0;
        this.emit({ type: 'sound', id: 'doorClose' });
        if (this.served) this.departReady = true;
      }
    } else if (this.doors === 'open') {
      this.flow(dt);
    }

    // ---- traction ----------------------------------------------------
    let notch = this.notch;
    if (this.atp) notch = this.minNotch;
    let aCmd = 0;
    const eb = notch <= this.minNotch;
    if (notch > 0) {
      if (this.doors !== 'closed') {
        this.once('traction', 4, { type: 'toast', text: 'Doors open, traction cut', tone: 'warn' });
      } else {
        const acc = this.free ? p.accel * 1.5 : p.accel;
        const vBase = this.free ? p.vBase * 3.5 : p.vBase;
        aCmd = acc * (notch / p.powerNotches) * Math.min(1, vBase / Math.max(this.v, 0.1));
        if (this.dir < 0) aCmd = Math.min(aCmd, 0.35);
      }
    } else if (notch < 0) {
      aCmd = -(eb ? p.emergency : p.brake * (-notch / p.brakeNotches));
    }
    if (eb && !this.atp && this.v > 1 && !this.ebFlag) {
      this.ebFlag = true;
      this.comfort = Math.max(0, this.comfort - 8);
      this.emit({ type: 'haptic', pattern: [120] });
    }
    if (!eb) this.ebFlag = false;

    this.slip = false;
    if (aCmd < 0 && this.v > 0.6 && -aCmd > this.brakeCap) {
      aCmd = -this.brakeCap * 0.8;
      this.slip = true;
    } else if (aCmd > 0 && this.v < 12 && aCmd > this.tractionCap) {
      aCmd = this.tractionCap * 0.78;
      this.slip = true;
    }
    if (this.slip) {
      this.slipT += dt;
      if (this.slipT > 0.35) {
        this.once('slip', 5, { type: 'toast', text: 'Wheel slip! Ease off the lever', tone: 'warn' }, { type: 'sound', id: 'slip' }, { type: 'haptic', pattern: [10, 30, 10, 30, 10] });
      }
    } else this.slipT = 0;

    if (this.v < 0.01 && aCmd >= 0 && this.aTr < 0) this.aTr = 0;
    const tau = eb ? 0.3 : p.tau;
    this.aTr += (aCmd - this.aTr) * (1 - Math.exp(-dt / tau));
    const resist =
      this.v <= 0 ? 0 : this.free ? 0.008 + 0.000025 * this.v * this.v : p.sound === 'ship' ? 0.01 + 0.0035 * this.v * this.v : 0.012 + 0.00018 * this.v * this.v;
    const prevA = this.a;
    let acc = this.aTr - resist;
    let v = this.v + acc * dt;
    // static friction: a crawling vehicle without traction comes to a clean stop
    if (v <= 0 || (v < 0.04 && this.aTr <= 0.02)) {
      v = 0;
      acc = 0;
    }
    if (this.dir < 0) v = Math.min(v, 1.6);
    this.v = v;
    this.a = acc;
    const ds = this.dir * v * dt;
    const sPrev = this.s;
    this.s += ds;
    this.distance += Math.abs(ds);
    if (v > this.maxSpeed) this.maxSpeed = v;
    if (v === 0) this.stoppedTime += dt;
    else this.stoppedTime = 0;

    // buffer stop
    if (this.s > this.track.length + 12 && this.v > 0) {
      this.v = 0;
      this.aTr = 0;
      this.addPoints('Buffer stop collision', -500);
      this.emit({ type: 'score', label: 'BUFFER STOP!', points: -500, tone: 'bad' });
      this.emit({ type: 'sound', id: 'buffer' });
      this.emit({ type: 'haptic', pattern: [200, 60, 200] });
      this.comfort = Math.max(0, this.comfort - 40);
      this.finish();
      return;
    }

    // ---- comfort -------------------------------------------------------
    if (v > 0 || Math.abs(acc) > 0.05) {
      const comfortA = p.rail ? 1.3 : p.sound === 'ship' ? 0.5 : 1.75;
      const jerk = Math.abs(acc - prevA) / dt;
      let loss = Math.max(0, Math.abs(acc) - comfortA) * 9 + Math.max(0, jerk - 1.6) * 0.9;
      const cv = this.track.curveLimitAt(this.s - this.length / 2);
      if (v > cv * 1.1) loss += (v / cv - 1.1) * 60;
      this.comfort = clamp(this.comfort - loss * dt + (loss < 0.01 ? 0.5 * dt : 0), 0, 100);
      this.comfortInt += this.comfort * dt;
      this.runTime += dt;
    }

    // ---- speed limits / ATP --------------------------------------------
    const lim = this.free ? Infinity : this.track.limitAt(this.s);
    const over = v - lim;
    this.overspeed = over > 1.4;
    if (this.overspeed) {
      this.overspeedT += dt;
      this.addPoints('Overspeed', -6 * dt);
      this.once('overspeed', 1.1, { type: 'sound', id: 'overspeed' });
      this.once('overspeedtoast', 6, { type: 'toast', text: 'Overspeed! Brake', tone: 'bad' }, { type: 'haptic', pattern: [40, 60, 40] });
    }
    if (p.atp && !this.atp && over > 2.8) {
      this.atp = true;
      this.atpCount++;
      this.addPoints('ATP interventions', -400);
      this.comfort = Math.max(0, this.comfort - 20);
      this.emit({ type: 'score', label: 'ATP EMERGENCY BRAKE', points: -400, tone: 'bad' });
      this.emit({ type: 'sound', id: 'atp' });
      this.emit({ type: 'haptic', pattern: [100, 50, 100, 50, 250] });
    }
    if (this.atp && v === 0) {
      this.atpHold += dt;
      if (this.atpHold > 2.5) {
        if (this.notch <= 0) {
          this.atp = false;
          this.atpHold = 0;
          this.emit({ type: 'toast', text: 'ATP reset. Proceed with caution', tone: 'info' });
        } else {
          this.once('atpreset', 4, { type: 'toast', text: 'Return the lever to N to reset ATP', tone: 'warn' });
        }
      }
    }
    if (!p.atp) {
      if (over > 4.2 && !this.dangerFlag) {
        this.dangerFlag = true;
        this.addPoints('Dangerous speed', -120);
        this.emit({ type: 'score', label: 'DANGEROUS SPEED', points: -120, tone: 'bad' });
        this.emit({ type: 'sound', id: 'bad' });
      } else if (over < 0) this.dangerFlag = false;
    }

    if (this.signals.length) this.updateSignals(sPrev);

    // ---- stops ------------------------------------------------------------
    const d = this.target - this.s;
    const tol = p.tol[3];
    if (!this.served) {
      const inZone = Math.abs(d) <= tol;
      if (inZone && v === 0 && this.doors === 'closed' && this.autoDoors && this.stoppedTime > 0.9) this.openDoors(true);
      const margin = this.isLast ? 160 : p.rail ? 45 : 30;
      if (d < -(tol + margin) && this.dir > 0) this.missStop();
    } else if (this.doors === 'closed' && this.departReady && v > 0.2 && Math.abs(this.s - this.stoppedS) > 1.2) {
      this.depart();
    } else if (this.doors === 'closed' && !this.departReady && v > 0.2 && Math.abs(this.s - this.stoppedS) > 1.2) {
      this.departReady = true;
      this.depart();
    }
  }

  private flow(dt: number) {
    const p = this.profile;
    const rate = p.cars * p.doorsPerCar * p.doorFlow;
    this.flowAcc += rate * dt;
    while (this.flowAcc >= 1) {
      if (this.alightLeft > 0) {
        this.alightLeft--;
        this.onboard = Math.max(0, this.onboard - 1);
        this.paxDelivered++;
      } else if (this.boardLeft > 0 && this.onboard < p.capacity) {
        this.boardLeft--;
        this.waiting[this.k] = Math.max(0, this.waiting[this.k] - 1);
        this.onboard++;
        this.totalBoarded++;
      } else {
        this.flowAcc = 0;
        break;
      }
      this.flowAcc -= 1;
    }
    if (this.boardLeft > 0 && this.onboard >= p.capacity && !this.fullWarned) {
      this.fullWarned = true;
      this.emit({ type: 'toast', text: 'Vehicle full! Some passengers must wait', tone: 'warn' });
    }
    const done = this.flowDone;
    if (done && this.isLast && this.served) {
      this.finish();
      return;
    }
    if (done && this.autoDoors && this.t >= this.tt.dep[this.k] - 3) this.closeDoors();
  }

  get flowDone() {
    return this.alightLeft === 0 && (this.boardLeft === 0 || this.onboard >= this.profile.capacity);
  }

  private nextSignalInfo(): HudSnapshot['nextSignal'] {
    for (const g of this.signals) {
      if (g.passed) continue;
      const d = g.s - this.s;
      if (d < 0) continue;
      return d < (this.profile.rail ? 1200 : 450) ? { dist: d, state: g.state } : null;
    }
    return null;
  }

  hud(): HudSnapshot {
    const p = this.profile;
    const d = this.target - this.s;
    const tol = p.tol[3];
    const v = this.v;
    const horizon = Math.max(350, (v * v) / (2 * 0.5 * p.brake) * 1.5 + 200);
    const reqDecel = d > 0.5 && !this.served ? (v * v) / (2 * d) : 0;
    const brakeHint = reqDecel > 0.05 ? Math.min(p.brakeNotches, Math.ceil((reqDecel / p.brake) * p.brakeNotches)) : 0;
    let delta: number;
    if (!this.served) delta = this.t + idealTimeBetween(this.tt, this.s, this.target) - this.tt.arr[this.k];
    else delta = Math.max(this.t, this.tt.dep[this.k]) - this.tt.dep[this.k];
    const t0 = this.tt.targets[0];
    const tN = this.tt.targets[this.tt.targets.length - 1];
    return {
      t: this.t,
      clockUtc: this.clockStartUtc + this.t * 1000,
      speed: v,
      accel: this.a,
      limit: this.free ? 0 : this.track.limitAt(this.s),
      nextLimit: this.free ? null : this.track.nextLower(this.s, horizon),
      notch: this.atp ? this.minNotch : this.notch,
      doors: this.doors,
      doorProgress: this.doors === 'opening' ? this.doorT / 2.2 : this.doors === 'closing' ? this.doorT / 3 : this.doors === 'open' ? 1 : 0,
      k: this.k,
      stopsTotal: this.tt.stops.length,
      stopName: this.tt.stops[this.k].name,
      nextStopName: this.tt.stops[this.k + 1]?.name,
      distToStop: d,
      inZone: Math.abs(d) <= tol,
      canOpen: !this.served && v === 0 && Math.abs(d) <= tol && this.doors === 'closed',
      served: this.served,
      flowDone: this.flowDone,
      alightLeft: this.alightLeft,
      boardLeft: this.boardLeft,
      onboard: this.onboard,
      capacity: p.capacity,
      waiting: this.waiting[this.k] ?? 0,
      departIn: this.tt.dep[this.k] - this.t,
      delta,
      schedArr: this.tt.arr[this.k],
      schedDep: this.tt.dep[this.k],
      comfort: this.comfort,
      score: this.score,
      overspeed: this.overspeed,
      atp: this.atp,
      slip: this.slip,
      inTunnel: this.track.inTunnel(this.s - this.length * 0.3),
      canReverse: !this.served && v === 0 && d < -tol && this.dir > 0,
      nextSignal: this.nextSignalInfo(),
      streak: this.streak,
      mult: this.streakMult,
      reversing: this.dir < 0,
      reqDecel,
      brakeHint,
      progress: clamp((this.s - t0) / Math.max(1, tN - t0), 0, 1),
      finished: this.finished,
    };
  }
}
