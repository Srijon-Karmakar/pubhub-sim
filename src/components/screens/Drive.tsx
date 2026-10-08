import { Crosshair, DoorClosed, DoorOpen, Eye, FastForward, Megaphone, Pause, Play, RotateCcw, Undo2, Video, Volume2, VolumeX, X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, type CSSProperties } from 'react';
import type { CameraMode } from '../../types';
import { formatClock } from '../../lib/env/sun';
import { audio } from '../../lib/audio/audio';
import { setHaptics } from '../../lib/haptics';
import { mapCtl } from '../../map/mapController';
import { quitRun, restartRun } from '../../game/actions';
import { runner } from '../../game/runner';
import { useApp } from '../../store/app';
import { useHud } from '../../store/hud';
import { useSettings } from '../../store/settings';
import { ApproachGauge, BoardingCard, Coach, ComfortMeter, NextCard, SignalLamp, StreakPill, Toasts } from '../hud/Panels';
import { Lever } from '../hud/Lever';
import { GearSwitch, Pedals, SteeringWheel, useCarKeyboard } from '../hud/CarControls';
import { LimitSign, Speedo } from '../hud/Speedo';
import { WeatherIcon } from '../WeatherIcon';
import { Toggle } from '../ui/primitives';
import { WeatherOverlay } from '../WeatherOverlay';

const CAMS: CameraMode[] = ['chase', 'cab', 'top'];
const CAM_LABEL: Record<CameraMode, string> = { chase: '3D', cab: 'Cab', top: '2D' };

function setCamera(c: CameraMode) {
  useSettings.getState().set({ camera: c });
  mapCtl.setCameraMode();
  mapCtl.scene.hideVehicle = c === 'cab';
  mapCtl.setFree(false);
}

export function DriveScreen() {
  const snap = useHud((s) => s.snap);
  const paused = useHud((s) => s.paused);
  const warp = useHud((s) => s.warp);
  const freeCam = useHud((s) => s.freeCam);
  const off = useHud((s) => s.utcOffset);
  const line = useApp((s) => s.line);
  const settings = useSettings();
  const engine = runner.engine;

  // keyboard controls
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const en = runner.engine;
      if (!en || (e.target as HTMLElement)?.tagName === 'INPUT') return;
      const k = e.key.toLowerCase();
      if (k === 'escape' || k === 'p') {
        runner.pause(!useHud.getState().paused);
        return;
      }
      if (useHud.getState().paused) return;
      if (k === 'h') {
        if (!e.repeat) runner.hornStart();
        e.preventDefault();
        return;
      }
      if (en.car) {
        if (k === ' ') runner.doors();
        else if (k === 'r') runner.setGear(en.gear === 'D' ? 'R' : 'D');
        else if (k === 'c') setCamera(CAMS[(CAMS.indexOf(useSettings.getState().camera) + 1) % CAMS.length]);
        else return;
        e.preventDefault();
        return;
      }
      if (k === 'arrowup' || k === 'w') runner.setNotch(en.notch + 1);
      else if (k === 'arrowdown' || k === 's') runner.setNotch(en.notch - 1);
      else if (k === 'n' || k === 'x') runner.setNotch(0);
      else if (k === 'e' || k === 'backspace') runner.setNotch(en.minNotch);
      else if (k === ' ' || k === 'd') runner.doors();
      else if (k === 'r') runner.reverse(en.dir > 0);
      else if (k === 'c') setCamera(CAMS[(CAMS.indexOf(useSettings.getState().camera) + 1) % CAMS.length]);
      else return;
      e.preventDefault();
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === 'h') runner.hornStop();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, []);
  useCarKeyboard(!!engine?.car);

  if (!snap || !engine || !line) return null;
  const p = engine.profile;
  const units = settings.units;
  const colour = engine.route.colour;
  const style = { '--line': colour, '--line-text': engine.route.textColour } as CSSProperties;
  const showApproach = !snap.served && snap.distToStop < p.approach && snap.distToStop > -(p.tol[3] + 60);
  const showBoard = snap.served && (snap.doors !== 'closed' || snap.speed < 0.3);
  const night = mapCtl.scene.night > 0.5;
  const doorsOpen = snap.doors === 'open' || snap.doors === 'opening';

  return (
    <motion.div className="hud" style={style} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <div className={`tunnel-vignette ${snap.inTunnel ? 'on' : ''}`} />
      {settings.camera === 'cab' && <div className="cab-frame" />}
      <WeatherOverlay kind={engine.weather} hidden={snap.inTunnel} />

      <div className="hud-top">
        <NextCard free={engine.free} snap={snap} lineRef={line.ref} colour={colour} textColour={engine.route.textColour} units={units} mode={engine.route.mode} />
        <div className="side-col">
          <button className="icon-btn glass" aria-label="Pause" onClick={() => runner.pause(true)}>
            <Pause size={20} fill="currentColor" />
          </button>
          <div className="clock-pill glass num">
            <WeatherIcon kind={engine.weather} size={15} night={night} />
            {formatClock(snap.clockUtc, off)}
          </div>
          {!engine.free && <StreakPill streak={snap.streak} mult={snap.mult} />}
          <ComfortMeter comfort={snap.comfort} />
          {engine.free ? (
            <div className="score-pill glass free">
              <small>MODE</small>
              <b>FREE</b>
            </div>
          ) : (
            <div className="score-pill glass">
              <small>SCORE</small>
              <b className="num">{Math.max(0, Math.round(snap.score)).toLocaleString()}</b>
            </div>
          )}
        </div>
      </div>

      <div className="hud-stack">
      <AnimatePresence>
        {snap.atp && (
          <motion.div className="banner atp" initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
            ATP · Emergency brake
          </motion.div>
        )}
        {!snap.atp && snap.inTunnel && (
          <motion.div className="banner tunnel glass" initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
            <Eye size={14} /> Tunnel · X-ray view
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showApproach && !freeCam && <ApproachGauge key="ap" snap={snap} p={p} units={units} assists={settings.assists} />}
        {showBoard && !freeCam && <BoardingCard key="bd" snap={snap} autoDoors={settings.autoDoors} free={engine.free} />}
        {freeCam && (
          <motion.button
            key="rc"
            className="recenter glass-strong"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            onClick={() => {
              mapCtl.setFree(false);
              mapCtl.resetZoom();
            }}
          >
            <Crosshair size={18} /> Follow vehicle
          </motion.button>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {(snap.canReverse || snap.reversing) && (
          <motion.button
            className={`btn ${snap.reversing ? 'btn-primary' : 'btn-soft'} reverse-btn glass`}
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => runner.reverse(!snap.reversing)}
          >
            <Undo2 size={18} /> {snap.reversing ? 'Reversing: tap to go forward' : 'Overshot: reverse'}
          </motion.button>
        )}
      </AnimatePresence>

        {!snap.atp && <Coach snap={snap} p={p} />}
      </div>

      <div className="actions">
        <button
          className={`act glass ${snap.canOpen ? 'pulse' : doorsOpen ? 'on' : ''}`}
          onClick={() => runner.doors()}
          aria-label={doorsOpen ? 'Close doors' : 'Open doors'}
        >
          {doorsOpen ? <DoorOpen size={24} /> : <DoorClosed size={24} />}
          <small>Doors</small>
        </button>
        <button
          className="act glass"
          aria-label="Horn (hold)"
          onPointerDown={(e) => {
            (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
            runner.hornStart();
          }}
          onPointerUp={() => runner.hornStop()}
          onPointerCancel={() => runner.hornStop()}
          onContextMenu={(e) => e.preventDefault()}
        >
          <Megaphone size={22} />
          <small>Horn</small>
        </button>
        <button className="act glass" onClick={() => setCamera(CAMS[(CAMS.indexOf(settings.camera) + 1) % CAMS.length])} aria-label="Camera">
          <Video size={22} />
          <small>{CAM_LABEL[settings.camera]}</small>
        </button>
        <button className={`act glass ${warp > 1 ? 'warn' : ''}`} onClick={() => runner.setWarp(warp === 1 ? 2 : warp === 2 ? 4 : 1)} aria-label="Time warp">
          <FastForward size={22} />
          <small>{warp}×</small>
        </button>
      </div>

      <div className={`speedo-wrap ${snap.car ? 'car' : ''}`}>
        <Speedo speed={snap.speed} limit={engine.free ? 0 : snap.limit} vmax={engine.free ? 450 / 3.6 : p.vmax} accel={snap.accel} overspeed={snap.overspeed} units={units} />
        <div className="limit-stack">
          <AnimatePresence>{!engine.free && snap.nextSignal && <SignalLamp key="sig" sig={snap.nextSignal} units={units} rail={p.rail} />}</AnimatePresence>
          {engine.free ? <div className="no-limit-sign" aria-label="No speed limit" /> : <LimitSign limit={snap.limit} next={snap.nextLimit} overspeed={snap.overspeed} units={units} />}
        </div>
      </div>

      {snap.car ? (
        <>
          <div className="car-left">
            <SteeringWheel steer={snap.steer / ((36 * Math.PI) / 180) / Math.max(0.22, 1 - snap.speed / 26)} />
          </div>
          <div className="car-right">
            <GearSwitch gear={snap.gear} />
            <Pedals throttle={snap.throttle} brake={snap.brakeIn} />
          </div>
          <AnimatePresence>
            {!engine.free && snap.offRoute > 6 && (
              <motion.div className="offroad-warn" initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }}>
                OFF ROUTE · STEER BACK
              </motion.div>
            )}
          </AnimatePresence>
        </>
      ) : (
        <Lever notch={snap.notch} maxP={p.powerNotches} maxB={p.brakeNotches} />
      )}

      <Toasts />

      <AnimatePresence>{paused && <PauseMenu />}</AnimatePresence>
    </motion.div>
  );
}

function PauseMenu() {
  const s = useSettings();
  const route = useApp((st) => st.route);
  const line = useApp((st) => st.line);
  return (
    <motion.div className="modal" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <div className="modal-backdrop" onClick={() => runner.pause(false)} />
      <motion.div
        className="modal-card glass-strong"
        initial={{ y: 60, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: 60, opacity: 0 }}
        transition={{ type: 'spring', stiffness: 380, damping: 34 }}
      >
        <div className="sheet-handle" style={{ marginTop: 4 }} />
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h3>Paused</h3>
          <button className="icon-btn" onClick={() => runner.pause(false)} aria-label="Resume">
            <X size={20} />
          </button>
        </div>
        <p className="muted" style={{ margin: '-6px 0 16px', fontSize: 14 }}>
          {line?.ref} · {route?.name}
        </p>
        <div className="pause-actions">
          <button className="btn btn-primary btn-block" onClick={() => runner.pause(false)}>
            <Play size={18} fill="currentColor" /> Resume
          </button>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <button className="btn btn-soft" onClick={() => restartRun()}>
              <RotateCcw size={18} /> Restart
            </button>
            <button className="btn btn-soft" onClick={() => quitRun()}>
              <X size={18} /> End shift
            </button>
          </div>
        </div>
        <div className="set-group" style={{ marginTop: 16 }}>
          <div className="set-row">
            <span className="ico">{s.sound ? <Volume2 size={17} /> : <VolumeX size={17} />}</span>
            <span className="txt">
              <b>Sound</b>
            </span>
            <Toggle
              on={s.sound}
              label="Sound"
              onChange={(v) => {
                s.set({ sound: v });
                audio.setEnabled(v, s.volume);
              }}
            />
          </div>
          <div className="set-row">
            <span className="ico">
              <Megaphone size={17} />
            </span>
            <span className="txt">
              <b>Announcements</b>
            </span>
            <Toggle
              on={s.announcements}
              label="Announcements"
              onChange={(v) => {
                s.set({ announcements: v });
                audio.announcements = v;
              }}
            />
          </div>
          <div className="set-row">
            <span className="ico">
              <DoorOpen size={17} />
            </span>
            <span className="txt">
              <b>Automatic doors</b>
              <small>Open on stopping, close at departure time</small>
            </span>
            <Toggle
              on={s.autoDoors}
              label="Automatic doors"
              onChange={(v) => {
                s.set({ autoDoors: v });
                runner.engine?.setAutoDoors(v);
              }}
            />
          </div>
          <div className="set-row">
            <span className="ico">
              <Crosshair size={17} />
            </span>
            <span className="txt">
              <b>Driving assists</b>
              <small>Stop zone on track, braking hints</small>
            </span>
            <Toggle
              on={s.assists}
              label="Driving assists"
              onChange={(v) => {
                s.set({ assists: v });
                mapCtl.scene.assists = v;
              }}
            />
          </div>
          <div className="set-row">
            <span className="ico">📳</span>
            <span className="txt">
              <b>Haptics</b>
            </span>
            <Toggle
              on={s.haptics}
              label="Haptics"
              onChange={(v) => {
                s.set({ haptics: v });
                setHaptics(v);
              }}
            />
          </div>
        </div>
        <p className="faint" style={{ fontSize: 12, textAlign: 'center', margin: '4px 0 0' }}>
          {runner.engine?.car
            ? 'Keyboard: W gas · S brake · A/D steer · R reverse gear · Space doors · H horn (hold) · C camera'
            : 'Keyboard: W/S lever · E emergency · Space doors · H horn (hold) · C camera · R reverse'}
        </p>
      </motion.div>
    </motion.div>
  );
}
