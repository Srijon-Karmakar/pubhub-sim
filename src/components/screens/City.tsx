import { ChevronLeft, ChevronRight, CloudOff, RefreshCw, Search, X } from 'lucide-react';
import { motion } from 'motion/react';
import { useMemo } from 'react';
import type { Line, ModeGroup } from '../../types';
import { formatClock } from '../../lib/env/sun';
import { GROUP_COLOUR, GROUPS } from '../../lib/sim/profiles';
import { back, retryBuses, retryCity, retryRail, selectLine } from '../../game/actions';
import { setApp, useApp } from '../../store/app';
import { useProgress } from '../../store/progress';
import { WeatherIcon } from '../WeatherIcon';
import { LineBadge, ModeIcon, Stars } from '../ui/primitives';
import { Sheet } from '../ui/Sheet';
import { useNow } from '../useNow';

function lineSub(l: Line): string {
  const v = l.variants[0];
  const ends = v.from && v.to ? `${v.from} ⇄ ${v.to}` : l.variants.length > 1 ? `${l.variants.length} directions` : '';
  return [ends, l.network].filter(Boolean).join(' · ');
}

export function CityTopBar({ panel }: { panel?: boolean }) {
  const city = useApp((s) => s.city);
  const weather = useApp((s) => s.weather);
  const now = useNow(15000);
  if (!city) return null;
  return (
    <div className={`topbar ${panel ? 'with-panel' : ''}`}>
      <button className="icon-btn glass" aria-label="Back" onClick={back}>
        <ChevronLeft size={22} />
      </button>
      <div className="title">
        <h2>
          {city.name}
        </h2>
        <p>{[city.region, city.country].filter(Boolean).join(', ') || 'Selected area'}</p>
      </div>
      {weather && (
        <div className="pill glass num">
          <WeatherIcon kind={weather.kind} size={16} />
          {isFinite(weather.temp) ? `${Math.round(weather.temp)}°` : ''}
          <span style={{ opacity: 0.55 }}>·</span>
          {formatClock(now, weather.utcOffset)}
        </div>
      )}
    </div>
  );
}

export function CityScreen() {
  const s = useApp();
  const best = useProgress((p) => p.best);

  const counts = useMemo(() => {
    const c: Partial<Record<ModeGroup, number>> = {};
    for (const l of s.lines) c[l.group] = (c[l.group] ?? 0) + 1;
    return c;
  }, [s.lines]);

  const filtered = useMemo(() => {
    const q = s.query.trim().toLowerCase();
    return s.lines.filter((l) => {
      if (s.group !== 'all' && l.group !== s.group) return false;
      if (!q) return true;
      return (
        l.ref.toLowerCase().includes(q) ||
        l.name.toLowerCase().includes(q) ||
        (l.network ?? '').toLowerCase().includes(q) ||
        l.variants.some((v) => `${v.from ?? ''} ${v.to ?? ''}`.toLowerCase().includes(q))
      );
    });
  }, [s.lines, s.group, s.query]);

  const bestFor = (l: Line) => {
    let stars = 0;
    for (const v of l.variants) for (const [k, b] of Object.entries(best)) if (k.startsWith(`${v.id}:`)) stars = Math.max(stars, b.stars);
    return stars;
  };

  const header = (
    <>
      {s.cityState === 'ready' && s.lines.length > 0 && (
        <div className="hscroll" style={{ paddingBottom: 4 }}>
          <button className={`chip ${s.group === 'all' ? 'active' : ''}`} onClick={() => setApp({ group: 'all' })}>
            All <span className="count">{s.lines.length}</span>
          </button>
          {GROUPS.filter((g) => counts[g.id]).map((g) => (
            <button key={g.id} className={`chip ${s.group === g.id ? 'active' : ''}`} onClick={() => setApp({ group: g.id })}>
              <ModeIcon group={g.id} size={15} color={s.group === g.id ? undefined : g.colour} />
              {g.label}
              <span className="count">{counts[g.id]}</span>
            </button>
          ))}
        </div>
      )}
    </>
  );

  let body;
  if (s.cityState === 'loading') {
    body = (
      <div>
        <div className="loader">
          <div className="radar">
            <span />
            <span />
            <span />
            <i>
              <ModeIcon group="metro" size={22} />
            </i>
          </div>
          <div>
            <b style={{ fontSize: 16 }}>{s.loadingMsg}</b>
            <div className="faint" style={{ fontSize: 13, marginTop: 4 }}>
              Big cities can take up to a minute the first time. After that they load instantly.
            </div>
          </div>
        </div>
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} style={{ display: 'flex', gap: 14, alignItems: 'center', padding: '11px 0' }}>
            <div className="skeleton" style={{ width: 44, height: 32 }} />
            <div style={{ flex: 1 }}>
              <div className="skeleton" style={{ height: 13, width: `${60 - i * 6}%` }} />
              <div className="skeleton" style={{ height: 10, width: `${40 + i * 5}%`, marginTop: 7 }} />
            </div>
          </div>
        ))}
      </div>
    );
  } else if (s.cityState === 'error') {
    body = (
      <div className="empty">
        <CloudOff size={34} style={{ opacity: 0.6 }} />
        <h3>Couldn’t load routes</h3>
        <p style={{ margin: '0 0 16px' }}>{s.cityError}</p>
        <button className="btn btn-primary" onClick={retryCity}>
          <RefreshCw size={18} /> Try again
        </button>
      </div>
    );
  } else if (s.cityState === 'ready' && s.lines.length === 0) {
    body = (
      <div className="empty">
        <ModeIcon group="bus" size={34} style={{ opacity: 0.5 }} />
        <h3>No mapped routes here yet</h3>
        <p>OpenStreetMap has no public transport routes for this area. Try a bigger nearby city.</p>
        <button className="btn btn-soft" onClick={back} style={{ marginTop: 8 }}>
          Choose another city
        </button>
      </div>
    );
  } else {
    let lastGroup: string | null = null;
    body = (
      <div>
        <div className="lines-search">
          <Search size={17} style={{ opacity: 0.5 }} />
          <input value={s.query} onChange={(e) => setApp({ query: e.target.value })} placeholder="Find a line, number or stop…" enterKeyHint="search" />
          {s.query && (
            <button onClick={() => setApp({ query: '' })} aria-label="Clear">
              <X size={16} />
            </button>
          )}
        </div>
        {filtered.map((l) => {
          const showHead = s.group === 'all' && l.group !== lastGroup;
          lastGroup = l.group;
          const stars = bestFor(l);
          return (
            <div key={l.key}>
              {showHead && (
                <div className="group-head">
                  <ModeIcon group={l.group} size={15} color={GROUP_COLOUR[l.group]} />
                  {GROUPS.find((g) => g.id === l.group)?.label}
                  <span className="faint" style={{ fontWeight: 600 }}>
                    {counts[l.group]}
                  </span>
                </div>
              )}
              <button className="line-row" onClick={() => selectLine(l)}>
                <LineBadge text={l.ref} colour={l.colour} textColour={l.textColour} mode={l.mode} />
                <span className="meta">
                  <b>
                    {l.name}
                    {l.longDistance && <span className="ld-tag">Long distance</span>}
                    {l.railLine && !l.longDistance && <span className="ld-tag">Rail line</span>}
                  </b>
                  <small>{lineSub(l) || `${l.variants.length} route${l.variants.length > 1 ? 's' : ''}`}</small>
                </span>
                {stars > 0 && <Stars n={stars} size={12} />}
                <ChevronRight size={18} style={{ opacity: 0.35 }} />
              </button>
            </div>
          );
        })}
        {!filtered.length && s.busState !== 'loading' && <div className="empty">No lines match “{s.query}”.</div>}
        {s.group !== 'bus' && s.railState === 'loading' && s.lines.every((l) => l.group === 'bus') && (
          <div className="bus-status">
            <span className="spinner" style={{ color: GROUP_COLOUR.train }} /> Loading metro, train and tram lines…
          </div>
        )}
        {s.group !== 'bus' && s.railState === 'error' && (
          <button className="bus-status" onClick={retryRail}>
            <RefreshCw size={16} /> Metro, train and tram lines didn’t load. Tap to retry
          </button>
        )}
        {(s.group === 'all' || s.group === 'bus') && s.busState === 'loading' && (
          <div className="bus-status">
            <span className="spinner" style={{ color: GROUP_COLOUR.bus }} /> Loading bus routes…
          </div>
        )}
        {(s.group === 'all' || s.group === 'bus') && s.busState === 'error' && (
          <button className="bus-status" onClick={retryBuses}>
            <RefreshCw size={16} /> Bus routes didn’t load. Tap to retry
          </button>
        )}
      </div>
    );
  }

  return (
    <motion.div className="screen" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: 0.2 } }}>
      <div className="scrim-top" />
      <CityTopBar panel />
      <Sheet snaps={[0.46, 0.9]} initial={0} header={header}>
        {body}
      </Sheet>
    </motion.div>
  );
}
