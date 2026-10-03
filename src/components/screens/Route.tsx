import { AlertTriangle, ArrowRight, Clock, Gauge, MapPin, Play, RefreshCw, Route as RouteIcon, X } from 'lucide-react';
import { motion } from 'motion/react';
import { useMemo, type CSSProperties } from 'react';
import type { TimeChoice, WeatherChoice } from '../../types';
import { distance, duration, speedUnit, speedValue } from '../../lib/format';
import { WEATHER_LABEL } from '../../lib/env/weather';
import { variantLabel } from '../../lib/osm/routes';
import { PROFILES } from '../../lib/sim/profiles';
import { buildTimetable } from '../../lib/sim/timetable';
import { Track } from '../../lib/sim/track';
import { closeRoute, selectVariant, setRun, startRun } from '../../game/actions';
import { useApp } from '../../store/app';
import { useProgress } from '../../store/progress';
import { useSettings } from '../../store/settings';
import { WeatherIcon } from '../WeatherIcon';
import { LineBadge, ModeIcon, Segmented, Stars } from '../ui/primitives';
import { Sheet } from '../ui/Sheet';
import { CityTopBar } from './City';

const TIMES: { value: TimeChoice; label: string }[] = [
  { value: 'live', label: 'Now' },
  { value: 'dawn', label: 'Dawn' },
  { value: 'day', label: 'Day' },
  { value: 'dusk', label: 'Dusk' },
  { value: 'night', label: 'Night' },
];

const WEATHERS: WeatherChoice[] = ['live', 'clear', 'cloudy', 'rain', 'fog', 'snow', 'storm'];

export function RouteScreen() {
  const { line, route, routeState, routeError, variantIdx, run, weather } = useApp();
  const units = useSettings((s) => s.units);
  const best = useProgress((s) => (route ? s.best[`${route.id}:${run.startIdx}-${run.endIdx}`] : undefined));

  const info = useMemo(() => {
    if (!route) return null;
    const p = PROFILES[route.mode];
    const track = new Track(route, p);
    const tt = buildTimetable(track, p, route.stops, run.startIdx, run.endIdx, route.mode, p.dwell + 8);
    const a = route.stops[run.startIdx].s;
    const b = route.stops[run.endIdx].s;
    let vtop = 0;
    let vmin = Infinity;
    for (let i = 0; i < track.limS.length; i++) {
      const s0 = track.limS[i];
      const s1 = track.limS[i + 1] ?? track.length;
      if (s1 < a || s0 > b) continue;
      vtop = Math.max(vtop, track.limV[i]);
      vmin = Math.min(vmin, track.limV[i]);
    }
    const len = b - a;
    const nStops = run.endIdx - run.startIdx + 1;
    const spacing = len / Math.max(1, nStops - 1);
    let diff = 1;
    if (p.brake < 1) diff++;
    if (spacing < 700 && p.rail) diff++;
    if (vtop - vmin > 12) diff++;
    if (track.tunnels.length > 0) diff += 0.5;
    if (nStops > 14) diff += 0.5;
    diff = Math.max(1, Math.min(4, Math.round(diff)));
    return { p, len, nStops, time: tt.arr[tt.arr.length - 1], vtop, diff, tunnels: track.tunnels.length, viaducts: track.bridges.length };
  }, [route, run.startIdx, run.endIdx]);

  const lineStyle = line ? ({ '--line': route?.colour ?? line.colour, '--line-text': route?.textColour ?? line.textColour } as CSSProperties) : undefined;

  const pickStop = (i: number) => {
    if (!route) return;
    let { startIdx, endIdx } = run;
    if (i < startIdx) startIdx = i;
    else if (i > endIdx) endIdx = i;
    else if (i - startIdx < endIdx - i) startIdx = i;
    else endIdx = i;
    if (endIdx <= startIdx) {
      if (i === startIdx) endIdx = Math.min(route.stops.length - 1, startIdx + 1);
      else startIdx = Math.max(0, endIdx - 1);
    }
    setRun({ startIdx, endIdx });
  };

  const presets = route
    ? [
        { label: 'Quick', n: 5 },
        { label: 'Standard', n: 10 },
        { label: 'Full line', n: route.stops.length },
      ].filter((pr, i, arr) => pr.n <= route.stops.length && (i === arr.length - 1 || pr.n < route.stops.length))
    : [];

  const header = line && (
    <div className="route-head" style={lineStyle}>
      <LineBadge text={line.ref} colour={route?.colour ?? line.colour} textColour={route?.textColour ?? line.textColour} size="lg" mode={line.mode} />
      <div className="meta">
        <h3>{route?.name ?? line.name}</h3>
        <p>
          <ModeIcon mode={line.mode} size={13} style={{ verticalAlign: '-2px', marginRight: 5 }} />
          {PROFILES[line.mode].label}
          {line.network ? ` · ${line.network}` : ''}
        </p>
      </div>
      <button className="icon-btn" style={{ background: 'var(--card-2)' }} onClick={closeRoute} aria-label="Close">
        <X size={18} />
      </button>
    </div>
  );

  let body;
  if (routeState === 'loading' || !line) {
    body = (
      <div style={{ paddingTop: 8 }}>
        <div className="stats">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="skeleton" style={{ height: 62 }} />
          ))}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '18px 0', color: 'var(--text-2)', fontSize: 14 }}>
          <span className="spinner" style={{ color: 'var(--line)' }} /> Tracing the route from OpenStreetMap…
        </div>
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="skeleton" style={{ height: 16, width: `${70 - i * 7}%`, margin: '16px 0 16px 34px' }} />
        ))}
      </div>
    );
  } else if (routeState === 'error') {
    body = (
      <div className="empty">
        <AlertTriangle size={32} style={{ opacity: 0.6 }} />
        <h3>This route can’t be driven</h3>
        <p style={{ margin: '0 0 16px' }}>{routeError}</p>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
          <button className="btn btn-soft" onClick={() => selectVariant(variantIdx)}>
            <RefreshCw size={17} /> Retry
          </button>
          {line.variants.length > 1 && (
            <button className="btn btn-soft" onClick={() => selectVariant((variantIdx + 1) % line.variants.length)}>
              Other direction
            </button>
          )}
        </div>
      </div>
    );
  } else if (route && info) {
    body = (
      <div style={lineStyle}>
        <div className="mode-pick">
          <div className="mode-inner">
            <span className="cond-label">Mode</span>
            <Segmented
              id="mode"
              value={run.free ? 'free' : 'career'}
              options={[
                { value: 'career', label: 'Career' },
                { value: 'free', label: 'Free drive' },
              ]}
              onChange={(v) => setRun({ free: v === 'free' })}
            />
            <p className="cond-hint">
              {run.free
                ? 'No speed limits, no emergency brake, no timetable or score. Push it as fast as you like.'
                : 'Speed limits, timetable and scoring. Earn stars and personal bests.'}
            </p>
          </div>
        </div>
        {line.variants.length > 1 && (
          <>
            <div className="section-title" style={{ marginTop: 12 }}>
              <span className="eyebrow">Direction</span>
              <span className="faint" style={{ fontSize: 12 }}>
                {line.variants.length} variants
              </span>
            </div>
            <div className="variant-list">
              {line.variants.slice(0, 6).map((v, i) => (
                <button key={v.id} className={`variant ${i === variantIdx ? 'on' : ''}`} onClick={() => i !== variantIdx && selectVariant(i)}>
                  <ArrowRight size={16} style={{ color: 'var(--line)', flex: 'none' }} />
                  <span>{variantLabel(v)}</span>
                </button>
              ))}
            </div>
          </>
        )}

        <div className="stats">
          <div className="stat">
            <small>
              <RouteIcon size={12} /> Length
            </small>
            <b className="num">{distance(info.len, units)}</b>
          </div>
          <div className="stat">
            <small>
              <MapPin size={12} /> Stops
            </small>
            <b className="num">{info.nStops}</b>
          </div>
          <div className="stat">
            <small>
              <Clock size={12} /> Time
            </small>
            <b className="num">{duration(info.time).replace(/ \d+s$/, '')}</b>
          </div>
          <div className="stat">
            <small>
              <Gauge size={12} /> Max
            </small>
            <b className="num">{Math.round(speedValue(info.vtop, units))}</b>
          </div>
        </div>
        <div className="difficulty">
          <span className="bars">
            {[1, 2, 3, 4].map((i) => (
              <i key={i} style={i <= info.diff ? { background: ['', 'var(--good)', '#84cc16', 'var(--warn)', 'var(--bad)'][info.diff] } : undefined} />
            ))}
          </span>
          <b style={{ color: 'var(--text)' }}>{['', 'Easy', 'Moderate', 'Challenging', 'Expert'][info.diff]}</b>
          <span className="faint">
            {[info.tunnels ? `${info.tunnels} tunnel${info.tunnels > 1 ? 's' : ''}` : '', info.viaducts ? `${info.viaducts} viaduct${info.viaducts > 1 ? 's' : ''}` : '', `${speedUnit(units)}`]
              .filter(Boolean)
              .join(' · ')}
          </span>
        </div>

        <div className="section-title">
          <span className="eyebrow">Your shift</span>
          <span className="faint" style={{ fontSize: 12 }}>
            Tap stops to set start & end
          </span>
        </div>
        <div className="presets">
          {presets.map((pr) => {
            const end = Math.min(route.stops.length - 1, run.startIdx + pr.n - 1);
            const start = pr.n >= route.stops.length ? 0 : end - run.startIdx < pr.n - 1 ? Math.max(0, end - pr.n + 1) : run.startIdx;
            const on = run.startIdx === start && run.endIdx === end;
            return (
              <button key={pr.label} className={`chip ${on ? 'active' : ''}`} onClick={() => setRun({ startIdx: start, endIdx: end })}>
                {pr.label}
                <span className="count">{pr.n} stops</span>
              </button>
            );
          })}
        </div>
        <div className="stop-list">
          {route.stops.map((st, i) => {
            const inR = i >= run.startIdx && i <= run.endIdx;
            const terminal = i === run.startIdx || i === run.endIdx;
            const cls = [
              'stop-row',
              inR ? 'in' : '',
              terminal ? 'terminal' : '',
              i === 0 ? 'first' : '',
              i === route.stops.length - 1 ? 'last' : '',
              i === run.startIdx && i > 0 ? 'edge-start' : '',
              i === run.endIdx && i < route.stops.length - 1 ? 'edge-end' : '',
            ].join(' ');
            return (
              <button key={st.id + i} className={cls} onClick={() => pickStop(i)}>
                <span className="rail">
                  <i />
                </span>
                <span className="nm">{st.name}</span>
                {i === run.startIdx && <span className="tag">Start</span>}
                {i === run.endIdx && <span className="tag">End</span>}
                {!terminal && inR && <span className="km">{distance(st.s - route.stops[run.startIdx].s, units)}</span>}
              </button>
            );
          })}
        </div>

        <div className="section-title">
          <span className="eyebrow">Conditions</span>
        </div>
        <div className="cond-grid">
          <div>
            <span className="cond-label">Time of day</span>
            <Segmented id="time" value={run.time} options={TIMES} onChange={(v) => setRun({ time: v })} />
          </div>
          <div>
            <span className="cond-label">Weather</span>
            <div className="hscroll">
              {WEATHERS.map((w) => (
                <button key={w} className={`chip ${run.weather === w ? 'active' : ''}`} onClick={() => setRun({ weather: w })}>
                  {w === 'live' ? (
                    <>
                      {weather ? <WeatherIcon kind={weather.kind} size={15} /> : null} Live
                      {weather && isFinite(weather.temp) ? <span className="count">{Math.round(weather.temp)}°</span> : null}
                    </>
                  ) : (
                    <>
                      <WeatherIcon kind={w} size={15} /> {WEATHER_LABEL[w]}
                    </>
                  )}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="section-title">
          <span className="eyebrow">Vehicle</span>
        </div>
        <div className="vehicle-card">
          <span className="ico">
            <ModeIcon mode={route.mode} size={26} />
          </span>
          <span style={{ minWidth: 0 }}>
            <b>{info.p.vehicleName}</b>
            <small>
              {Math.round(speedValue(info.p.vmax, units))} {speedUnit(units)} · {info.p.capacity.toLocaleString()} passengers
              {info.p.atp ? ' · ATP' : ''}
            </small>
          </span>
        </div>

        {route.synthStops && (
          <div className="note">
            <AlertTriangle size={18} style={{ flex: 'none', color: 'var(--warn)' }} />
            <span>This route's stops aren't mapped in OpenStreetMap yet, so halts are spaced evenly along it.</span>
          </div>
        )}
        {route.approx && (
          <div className="note">
            <AlertTriangle size={18} style={{ flex: 'none', color: 'var(--warn)' }} />
            <span>This route has no track geometry in OpenStreetMap, so the path between stops is approximate.</span>
          </div>
        )}
      </div>
    );
  }

  const footer =
    routeState === 'ready' && route ? (
      <div style={lineStyle}>
        <button className="btn btn-line btn-block" style={{ height: 58, fontSize: 17 }} onClick={startRun}>
          <Play size={20} fill="currentColor" /> {run.free ? 'Start free drive' : 'Start shift'}
          {best && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginLeft: 6, opacity: 0.9, fontSize: 13 }}>
              · <Stars n={best.stars} size={12} /> {best.score.toLocaleString()}
            </span>
          )}
        </button>
      </div>
    ) : undefined;

  return (
    <motion.div className="screen" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: 0.2 } }}>
      <div className="scrim-top" />
      <CityTopBar panel />
      <Sheet snaps={[0.5, 0.92]} initial={0} header={header} footer={footer}>
        {body}
      </Sheet>
    </motion.div>
  );
}
