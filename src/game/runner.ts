import type { City, Line, RunResult } from '../types';
import { audio } from '../lib/audio/audio';
import { haptic } from '../lib/haptics';
import { Engine, type GameEvent } from '../lib/sim/engine';
import { mapCtl } from '../map/mapController';
import { setApp } from '../store/app';
import { pushToast, useHud } from '../store/hud';
import { useProgress } from '../store/progress';
import { useSettings } from '../store/settings';
import { applyEnv } from './env';
import { carInput, resetCarInput, updateCarInput } from './carInput';

interface RunCtx {
  city: City;
  line: Line;
  startIdx: number;
  endIdx: number;
  utcOffset: number;
}

class Runner {
  engine: Engine | null = null;
  private ctx: RunCtx | null = null;
  private raf = 0;
  private last = 0;
  private hudAcc = 0;
  private envAcc = 99;
  private progAcc = 0;
  private stopsKey = '';
  private wake: { release: () => Promise<void> } | null = null;
  private finishTimer = 0;
  private tunnelBlend = 0;
  private stationBlend = 0;
  private introTimer = 0;

  start(engine: Engine, ctx: RunCtx) {
    this.stop();
    this.engine = engine;
    this.ctx = ctx;
    const t = engine.tt.targets;
    useHud.setState({
      snap: engine.hud(),
      paused: false,
      warp: 1,
      freeCam: false,
      toasts: [],
      utcOffset: ctx.utcOffset,
      stopTargets: t.map((x) => (x - t[0]) / Math.max(1, t[t.length - 1] - t[0])),
      intro: true,
    });
    clearTimeout(this.introTimer);
    this.introTimer = window.setTimeout(() => this.endIntro(), 3600);
    mapCtl.onFreeCamChange = (free) => useHud.setState({ freeCam: free });
    mapCtl.enterDrive(engine, engine.route.colour, engine.route.driveSide, true);
    mapCtl.scene.assists = useSettings.getState().assists;
    mapCtl.scene.hideVehicle = useSettings.getState().camera === 'cab';
    audio.setVehicle(engine.profile);
    resetCarInput();
    this.last = performance.now();
    this.envAcc = 99;
    this.stopsKey = '';
    this.tunnelBlend = 0;
    this.raf = requestAnimationFrame(this.loop);
    this.requestWake();
    document.addEventListener('visibilitychange', this.onVis);
  }

  endIntro() {
    clearTimeout(this.introTimer);
    if (useHud.getState().intro) useHud.setState({ intro: false });
  }

  stop() {
    cancelAnimationFrame(this.raf);
    clearTimeout(this.finishTimer);
    clearTimeout(this.introTimer);
    this.raf = 0;
    this.engine = null;
    document.removeEventListener('visibilitychange', this.onVis);
    void this.wake?.release().catch(() => {});
    this.wake = null;
    audio.idle();
    audio.clearSpeech();
  }

  private onVis = () => {
    if (document.hidden) {
      this.pause(true);
      this.wake = null;
    }
  };

  private async requestWake() {
    try {
      const nav = navigator as Navigator & { wakeLock?: { request: (t: 'screen') => Promise<{ release: () => Promise<void> }> } };
      this.wake = (await nav.wakeLock?.request('screen')) ?? null;
    } catch {
      /* not available */
    }
  }

  pause(on: boolean) {
    if (!this.engine) return;
    useHud.setState({ paused: on });
    if (on) audio.suspend();
    else {
      audio.resume();
      this.last = performance.now();
      if (!this.wake) void this.requestWake();
    }
  }

  setWarp(w: 1 | 2 | 4) {
    useHud.setState({ warp: w });
  }

  private dispatch(ev: GameEvent) {
    switch (ev.type) {
      case 'sound':
        audio.play(ev.id);
        break;
      case 'haptic':
        haptic(ev.pattern);
        break;
      case 'announce':
        audio.announce(ev.text);
        break;
      case 'score':
        pushToast({ kind: 'score', label: ev.label, sub: ev.sub, points: Math.round(ev.points), tone: ev.tone });
        break;
      case 'toast':
        pushToast({ kind: 'toast', label: ev.text, tone: ev.tone });
        break;
      case 'finished':
        this.finishTimer = window.setTimeout(() => this.finish(), 1600);
        break;
    }
  }

  private loop = (now: number) => {
    this.raf = requestAnimationFrame(this.loop);
    const e = this.engine;
    if (!e) return;
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    const hud = useHud.getState();
    const settings = useSettings.getState();

    if (e.car && !hud.paused) {
      updateCarInput(dt);
      e.setPedals(carInput.throttle, carInput.brake);
      e.setSteer(carInput.steer);
    }
    if (!hud.paused && !e.finished) {
      let rem = dt * hud.warp;
      while (rem > 1e-6) {
        const h = Math.min(1 / 60, rem);
        e.step(h);
        rem -= h;
      }
    }
    if (e.events.length) {
      const evs = e.events.splice(0, e.events.length);
      for (const ev of evs) this.dispatch(ev);
    }

    // camera & scene
    mapCtl.follow(e, settings.camera, dt, settings.headingUp);
    const inTunnel = e.track.inTunnel(e.s - e.length * 0.3);
    this.tunnelBlend += ((inTunnel ? 1 : 0) - this.tunnelBlend) * Math.min(1, dt * 3);
    mapCtl.scene.xray = this.tunnelBlend > 0.5;
    // OSM often maps stations as halls over the tracks: fade buildings around platforms
    const toStop = Math.abs(e.tt.targets[e.k] - e.s);
    const fromLast = e.k > 0 ? Math.abs(e.s - e.tt.targets[e.k - 1]) : Infinity;
    const nearStation = Math.min(toStop, fromLast) < e.length + 120;
    this.stationBlend += ((nearStation ? 1 : 0) - this.stationBlend) * Math.min(1, dt * 2);
    const fade = Math.max(this.tunnelBlend * 0.62, this.stationBlend * 0.42);
    mapCtl.setBuildingOpacity(Math.round((0.94 - fade) * 20) / 20);
    mapCtl.repaint();

    // audio
    if (!hud.paused) {
      const p = e.profile;
      const effort = e.car
        ? (e.doors === 'closed' ? e.throttle : 0) - e.brakeIn
        : e.notch > 0 && e.doors === 'closed' ? e.notch / p.powerNotches : e.notch < 0 ? e.notch / (p.brakeNotches + 1) : 0;
      audio.update({
        v: e.v,
        effort,
        brakeNotchFrac: e.car ? e.brakeIn : e.notch < 0 ? -e.notch / (p.brakeNotches + 1) : 0,
        inTunnel,
        rain: e.weather === 'storm' ? 1 : e.weather === 'rain' ? 0.6 : 0,
        dt,
        s: e.s,
      });
    }

    // HUD @ ~15 Hz
    this.hudAcc += dt;
    if (this.hudAcc > 1 / 15) {
      this.hudAcc = 0;
      useHud.setState({ snap: e.hud() });
    }

    // environment @ 1 Hz (sim time drives sun position)
    this.envAcc += dt;
    if (this.envAcc > 1 && this.ctx) {
      this.envAcc = 0;
      applyEnv(e.clockStartUtc + e.t * 1000, this.ctx.city.lat, this.ctx.city.lon, e.weather);
    }

    // route progress @ 2 Hz
    this.progAcc += dt;
    if (this.progAcc > 0.5 && this.ctx) {
      this.progAcc = 0;
      const L = e.track.length || 1;
      mapCtl.setRouteProgress(e.s / L, e.tt.stops[0].s / L, e.tt.stops[e.tt.stops.length - 1].s / L);
      const key = `${e.k}:${e.served}`;
      if (key !== this.stopsKey) {
        this.stopsKey = key;
        mapCtl.updateStops(e.route, this.ctx.startIdx, this.ctx.endIdx, this.ctx.startIdx + e.k, e.served);
      }
    }
  };

  // ------------------------------------------------------------ input
  setNotch(n: number) {
    const e = this.engine;
    if (!e || useHud.getState().paused) return;
    const before = e.notch;
    e.setNotch(n);
    if (e.notch !== before) {
      audio.click8();
      haptic(e.notch === e.minNotch ? [30, 20, 60] : 6);
    }
  }

  doors() {
    this.engine?.toggleDoors();
  }

  /** horns sound for as long as they're held */
  hornStart() {
    audio.hornStart();
    haptic(15);
  }

  hornStop() {
    audio.hornStop();
  }

  horn() {
    audio.hornStart();
    window.setTimeout(() => audio.hornStop(), 450);
    haptic(15);
  }

  setGear(g: 'D' | 'R') {
    this.engine?.setGear(g);
    audio.click8();
    haptic(10);
  }

  reverse(on: boolean) {
    this.engine?.setReverse(on);
  }

  private finish() {
    const e = this.engine;
    const ctx = this.ctx;
    if (!e || !ctx) return;
    const score = Math.max(0, Math.round(e.score));
    const max = e.maxScore;
    const ratio = score / max;
    const stars = ratio >= 0.8 ? 3 : ratio >= 0.58 ? 2 : ratio >= 0.32 ? 1 : 0;
    const result: RunResult = {
      routeKey: `${e.route.id}:${ctx.startIdx}-${ctx.endIdx}`,
      cityName: ctx.city.name,
      lineRef: ctx.line.ref,
      lineName: e.route.name,
      colour: e.route.colour,
      mode: e.route.mode,
      score,
      maxScore: max,
      stars,
      distance: e.distance,
      duration: e.t,
      stops: e.ratings,
      paxDelivered: e.paxDelivered,
      comfort: e.avgComfort,
      overspeedTime: e.overspeedT,
      atpCount: e.atpCount,
      onTime: e.onTime,
      perfect: e.ratings.filter((r) => r.grade === 'perfect').length,
      breakdown: [...e.breakdown.entries()].map(([label, points]) => ({ label, points: Math.round(points) })).filter((b) => b.points !== 0),
      date: Date.now(),
      best: false,
      free: e.free,
      maxSpeed: e.maxSpeed,
      bestStreak: e.bestStreak,
    };
    // free drives don't count towards scores or bests
    if (!e.free) result.best = useProgress.getState().addRun(result);
    if (!useSettings.getState().tutorialDone) useSettings.getState().set({ tutorialDone: true });
    setApp({ result, screen: 'results' });
    audio.idle();
    // orbit around the parked vehicle
    const [la, lo] = e.track.path.pointAt(e.s - e.length / 2);
    mapCtl.following = false;
    mapCtl.startOrbit(la, lo, { zoom: 17.2, pitch: 62, speed: 6, fly: true });
  }
}

export const runner = new Runner();
