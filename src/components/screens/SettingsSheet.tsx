import { BatteryMedium, Compass, Crosshair, Database, DoorOpen, Gauge, Megaphone, Palette, Trash2, Volume2, X } from 'lucide-react';
import { mapCtl } from '../../map/mapController';
import { motion } from 'motion/react';
import { useEffect, useState } from 'react';
import { audio } from '../../lib/audio/audio';
import { cacheClear, cacheCount } from '../../lib/osm/cache';
import { setHaptics } from '../../lib/haptics';
import { syncTheme } from '../../game/env';
import { setApp } from '../../store/app';
import { useProgress } from '../../store/progress';
import { useSettings, type ThemePref } from '../../store/settings';
import { Segmented, Toggle } from '../ui/primitives';

export function SettingsSheet() {
  const s = useSettings();
  const resetProgress = useProgress((p) => p.reset);
  const [cached, setCached] = useState<number | null>(null);
  useEffect(() => {
    void cacheCount().then(setCached);
  }, []);
  const close = () => setApp({ settingsOpen: false });

  return (
    <motion.div className="modal" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <div className="modal-backdrop" onClick={close} />
      <motion.div
        className="modal-card glass-strong"
        initial={{ y: 80, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: 80, opacity: 0 }}
        transition={{ type: 'spring', stiffness: 380, damping: 34 }}
      >
        <div className="sheet-handle" style={{ marginTop: 4 }} />
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h3>Settings</h3>
          <button className="icon-btn" onClick={close} aria-label="Close">
            <X size={20} />
          </button>
        </div>

        <div className="cond-label">
          <Palette size={12} style={{ verticalAlign: '-1px' }} /> Appearance
        </div>
        <div style={{ marginBottom: 14 }}>
          <Segmented<ThemePref>
            id="theme"
            value={s.theme}
            options={[
              { value: 'auto', label: 'City time' },
              { value: 'system', label: 'System' },
              { value: 'light', label: 'Light' },
              { value: 'dark', label: 'Dark' },
            ]}
            onChange={(v) => {
              s.set({ theme: v });
              setTimeout(() => syncTheme(), 0);
            }}
          />
          <p className="faint" style={{ fontSize: 12, margin: '6px 2px 0' }}>
            “City time” switches between day and night with the real sun position at the city you’re driving.
          </p>
        </div>

        <div className="set-group">
          <div className="set-row">
            <span className="ico">
              <Gauge size={17} />
            </span>
            <span className="txt">
              <b>Units</b>
            </span>
            <div style={{ width: 150 }}>
              <Segmented
                id="units"
                value={s.units}
                options={[
                  { value: 'metric', label: 'km/h' },
                  { value: 'imperial', label: 'mph' },
                ]}
                onChange={(v) => s.set({ units: v })}
              />
            </div>
          </div>
          <div className="set-row">
            <span className="ico">
              <Compass size={17} />
            </span>
            <span className="txt">
              <b>2D map follows heading</b>
              <small>Off keeps north up</small>
            </span>
            <Toggle on={s.headingUp} label="Heading up" onChange={(v) => s.set({ headingUp: v })} />
          </div>
          <div className="set-row">
            <span className="ico">
              <BatteryMedium size={17} />
            </span>
            <span className="txt">
              <b>Battery saver</b>
              <small>Flat buildings and lower resolution</small>
            </span>
            <Toggle
              on={s.quality === 'low'}
              label="Battery saver"
              onChange={(v) => {
                s.set({ quality: v ? 'low' : 'high' });
                mapCtl.setQuality(v ? 'low' : 'high');
              }}
            />
          </div>
        </div>

        <div className="set-group">
          <div className="set-row">
            <span className="ico">
              <Volume2 size={17} />
            </span>
            <span className="txt">
              <b>Sound</b>
            </span>
            <input
              className="range"
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={s.volume}
              onChange={(e) => {
                const v = Number(e.target.value);
                s.set({ volume: v });
                audio.setEnabled(s.sound, v);
              }}
            />
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
              <b>Station announcements</b>
              <small>Spoken by your device’s voice</small>
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
            <span className="ico">📳</span>
            <span className="txt">
              <b>Haptics</b>
              <small>Vibration on supported phones</small>
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

        <div className="set-group">
          <div className="set-row">
            <span className="ico">
              <DoorOpen size={17} />
            </span>
            <span className="txt">
              <b>Automatic doors</b>
              <small>Open on stopping, close at departure time</small>
            </span>
            <Toggle on={s.autoDoors} label="Automatic doors" onChange={(v) => s.set({ autoDoors: v })} />
          </div>
          <div className="set-row">
            <span className="ico">
              <Crosshair size={17} />
            </span>
            <span className="txt">
              <b>Driving assists</b>
              <small>Stop zone on the track, braking hints</small>
            </span>
            <Toggle on={s.assists} label="Driving assists" onChange={(v) => s.set({ assists: v })} />
          </div>
          <button className="set-row" onClick={() => s.set({ tutorialDone: false })}>
            <span className="ico">💡</span>
            <span className="txt">
              <b>Show tips again</b>
              <small>Replay the in-cab coaching on your next shift</small>
            </span>
          </button>
        </div>

        <div className="set-group">
          <button
            className="set-row"
            onClick={async () => {
              await cacheClear();
              setCached(0);
            }}
          >
            <span className="ico">
              <Database size={17} />
            </span>
            <span className="txt">
              <b>Clear saved map data</b>
              <small>{cached === null ? '…' : `${cached} cities & routes stored for offline use`}</small>
            </span>
          </button>
          <button
            className="set-row"
            onClick={() => {
              if (confirm('Reset all scores and career stats?')) resetProgress();
            }}
          >
            <span className="ico" style={{ color: 'var(--bad)' }}>
              <Trash2 size={17} />
            </span>
            <span className="txt">
              <b style={{ color: 'var(--bad)' }}>Reset career</b>
              <small>Scores, stars and totals</small>
            </span>
          </button>
        </div>
        <p className="faint" style={{ fontSize: 12, textAlign: 'center', margin: '6px 0 0', lineHeight: 1.6 }}>
          PublicPort · Map data © OpenStreetMap contributors (ODbL) · Tiles by OpenFreeMap · Search by Photon · Weather by Open-Meteo
        </p>
      </motion.div>
    </motion.div>
  );
}
