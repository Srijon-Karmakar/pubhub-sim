import { Info, LocateFixed, Search, Settings } from 'lucide-react';
import { motion } from 'motion/react';
import { compact } from '../../lib/format';
import { POPULAR, popularToCity } from '../../lib/osm/search';
import { Flag } from '../Flag';
import { openAbout, openCity } from '../../game/actions';
import { setApp } from '../../store/app';
import { useProgress } from '../../store/progress';
import { useSettings } from '../../store/settings';

const container = {
  hidden: {},
  show: { transition: { staggerChildren: 0.06, delayChildren: 0.1 } },
};
const item = {
  hidden: { opacity: 0, y: 18 },
  show: { opacity: 1, y: 0, transition: { type: 'spring' as const, stiffness: 260, damping: 26 } },
};

export function HomeScreen() {
  const recent = useProgress((s) => s.recentCities);
  const totals = useProgress((s) => s.totals);
  const units = useSettings((s) => s.units);
  const km = units === 'metric' ? totals.distance / 1000 : totals.distance / 1609.34;

  return (
    <motion.div className="screen home" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: 0.25 } }}>
      <div className="scrim-top" />
      <div className="scrim-bottom" />
      <div className="home-top">
        <div className="brand">
          <img src="/favicon-updated.png" alt="PublicPort" />
          <b>PublicPort</b>
        </div>
        <div className="home-actions">
          <button className="icon-btn glass" aria-label="About PublicPort" onClick={openAbout}>
            <Info size={20} />
          </button>
          <button className="icon-btn glass" aria-label="Settings" onClick={() => setApp({ settingsOpen: true })}>
            <Settings size={20} />
          </button>
        </div>
      </div>

      <motion.div className="home-body" variants={container} initial="hidden" animate="show">
        <motion.div className="hero" variants={item}>
          <div className="eyebrow">OpenStreetMap transit simulator</div>
          <h1>
            Drive <span className="grad-text">any city.</span>
          </h1>
          <p>Real metro, train, tram, bus and ferry routes, loaded live from OpenStreetMap for any city on Earth. Keep to the timetable, stop on the mark, and keep your passengers comfortable.</p>
        </motion.div>

        <motion.button variants={item} className="search-trigger glass-strong" onClick={() => setApp({ searchOpen: true })}>
          <Search size={20} />
          <span className="st-label">Search any city…</span>
          <span
            className="locate"
            role="button"
            aria-label="Use my location"
            onClick={(e) => {
              e.stopPropagation();
              setApp({ searchOpen: true });
              window.dispatchEvent(new CustomEvent('pp:locate'));
            }}
          >
            <LocateFixed size={20} />
          </span>
        </motion.button>

        <motion.div variants={item} className="popular">
          <div className="section-title" style={{ marginTop: 4 }}>
            <span className="eyebrow">{recent.length ? 'Jump back in' : 'Popular cities'}</span>
          </div>
          <div className="hscroll">
            {recent.map((c) => (
              <button key={c.id} className="city-chip glass" onClick={() => openCity(c)}>
                <Flag cc={c.countryCode} />
                {c.name}
              </button>
            ))}
            {POPULAR.filter((p) => !recent.some((r) => r.name === p.name)).map((p) => (
              <button key={p.name} className="city-chip glass" onClick={() => openCity(popularToCity(p))}>
                <Flag cc={p.cc} />
                {p.name}
              </button>
            ))}
          </div>
        </motion.div>

        {totals.runs > 0 && (
          <motion.div variants={item} className="career glass">
            <div>
              <b className="num">{totals.runs}</b>
              <small>Shifts</small>
            </div>
            <div>
              <b className="num">
                {km < 100 ? km.toFixed(1) : compact(km)}
                <span style={{ fontSize: 13, opacity: 0.6 }}> {units === 'metric' ? 'km' : 'mi'}</span>
              </b>
              <small>Driven</small>
            </div>
            <div>
              <b className="num">{compact(totals.pax)}</b>
              <small>Passengers</small>
            </div>
          </motion.div>
        )}

        <motion.div variants={item} className="home-foot">
          <span>Map data © OpenStreetMap contributors</span>
          <span>Tiles: OpenFreeMap</span>
        </motion.div>
      </motion.div>
    </motion.div>
  );
}
