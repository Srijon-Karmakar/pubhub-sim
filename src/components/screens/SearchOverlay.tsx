import { ArrowLeft, LocateFixed, MapPin, Search, X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import type { City } from '../../types';
import { POPULAR, popularToCity, reverseCity, searchCities } from '../../lib/osm/search';
import { Flag } from '../Flag';
import { openCity } from '../../game/actions';
import { setApp } from '../../store/app';

export function SearchOverlay() {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<City[]>([]);
  const [busy, setBusy] = useState(false);
  const [locating, setLocating] = useState(false);
  const [err, setErr] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const t = setTimeout(() => inputRef.current?.focus(), 250);
    const onLocate = () => locate();
    window.addEventListener('pp:locate', onLocate);
    return () => {
      clearTimeout(t);
      window.removeEventListener('pp:locate', onLocate);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const query = q.trim();
    if (query.length < 2) {
      setResults([]);
      setBusy(false);
      return;
    }
    const ctrl = new AbortController();
    setBusy(true);
    const t = setTimeout(async () => {
      try {
        const r = await searchCities(query, ctrl.signal);
        setResults(r);
        setErr('');
      } catch (e) {
        if ((e as Error).name !== 'AbortError') setErr('Search is unavailable. Check your connection.');
      } finally {
        if (!ctrl.signal.aborted) setBusy(false);
      }
    }, 280);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [q]);

  function locate() {
    if (!navigator.geolocation) {
      setErr('Location is not available on this device.');
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const c = await reverseCity(pos.coords.latitude, pos.coords.longitude);
        setLocating(false);
        void openCity(c);
      },
      () => {
        setLocating(false);
        setErr('Couldn’t get your location. You can search instead.');
      },
      { enableHighAccuracy: false, timeout: 12000, maximumAge: 600000 },
    );
  }

  const close = () => setApp({ searchOpen: false });

  return (
    <motion.div className="overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <div className="overlay-backdrop" onClick={close} />
      <motion.div
        className="search-panel glass-strong"
        initial={{ y: -24, scale: 0.98, opacity: 0 }}
        animate={{ y: 0, scale: 1, opacity: 1 }}
        exit={{ y: -16, opacity: 0 }}
        transition={{ type: 'spring', stiffness: 380, damping: 32 }}
      >
        <div className="search-field">
          <button className="icon-btn" onClick={close} aria-label="Close search" style={{ marginLeft: -8 }}>
            <ArrowLeft size={20} />
          </button>
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="City, town or district"
            enterKeyHint="search"
            autoComplete="off"
            spellCheck={false}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && results[0]) void openCity(results[0]);
              if (e.key === 'Escape') close();
            }}
          />
          {busy ? (
            <span className="spinner" style={{ marginRight: 12, color: 'var(--accent)' }} />
          ) : q ? (
            <button className="icon-btn" onClick={() => setQ('')} aria-label="Clear">
              <X size={18} />
            </button>
          ) : (
            <Search size={18} style={{ marginRight: 12, opacity: 0.5 }} />
          )}
        </div>
        <div className="search-results">
          <button className="result-row" onClick={locate} disabled={locating}>
            <span className="flag-tile" style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}>
              {locating ? <span className="spinner" /> : <LocateFixed size={20} />}
            </span>
            <span>
              <b>Use my location</b>
              <small>Drive the transit lines around you</small>
            </span>
          </button>
          {err && <div className="search-empty">{err}</div>}
          <AnimatePresence initial={false}>
            {results.map((c, i) => (
              <motion.button
                key={c.id}
                className="result-row"
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0, transition: { delay: i * 0.03 } }}
                exit={{ opacity: 0 }}
                onClick={() => openCity(c)}
              >
                <span className="flag-tile"><Flag cc={c.countryCode} /></span>
                <span style={{ minWidth: 0 }}>
                  <b>{c.name}</b>
                  <small>{[c.region, c.country].filter(Boolean).join(', ')}</small>
                </span>
              </motion.button>
            ))}
          </AnimatePresence>
          {q.trim().length >= 2 && !busy && !results.length && !err && (
            <div className="search-empty">
              <MapPin size={22} style={{ opacity: 0.5 }} />
              <div>No places named “{q}”.</div>
            </div>
          )}
          {q.trim().length < 2 && (
            <>
              <div className="eyebrow" style={{ padding: '14px 12px 8px' }}>
                Popular
              </div>
              <div className="pop-grid">
                {POPULAR.map((p) => (
                  <button key={p.name} className="city-chip" style={{ background: 'var(--card)', justifyContent: 'flex-start' }} onClick={() => openCity(popularToCity(p))}>
                    <Flag cc={p.cc} />
                    {p.name}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </motion.div>
    </motion.div>
  );
}
