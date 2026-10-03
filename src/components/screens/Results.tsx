import { ArrowLeftRight, List, RotateCcw, Share2, Trophy } from 'lucide-react';
import { animate, motion, useMotionValue, useTransform } from 'motion/react';
import { useEffect, useState, type CSSProperties } from 'react';
import { distance, duration, speedUnit, speedValue } from '../../lib/format';
import { closeRoute, restartRun, reverseRun } from '../../game/actions';
import { runner } from '../../game/runner';
import { mapCtl } from '../../map/mapController';
import { setApp, useApp } from '../../store/app';
import { useSettings } from '../../store/settings';
import { LineBadge } from '../ui/primitives';

const GRADE_COL: Record<string, string> = { perfect: '#a78bfa', great: '#c3ff00', good: '#10b981', ok: '#94a3b8', missed: '#ef4444' };

function rank(stars: number, ratio: number) {
  if (stars === 3 && ratio > 0.92) return 'Legendary driver';
  if (stars === 3) return 'Master driver';
  if (stars === 2) return 'Professional driver';
  if (stars === 1) return 'Trainee driver';
  return 'Keep practising';
}

function Star({ on, delay }: { on: boolean; delay: number }) {
  return (
    <motion.svg
      width="54"
      height="54"
      viewBox="0 0 24 24"
      initial={{ scale: 0, rotate: -30 }}
      animate={{ scale: 1, rotate: 0 }}
      transition={{ type: 'spring', stiffness: 300, damping: 14, delay }}
    >
      <defs>
        <linearGradient id="sg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#fde68a" />
          <stop offset="0.5" stopColor="#fbbf24" />
          <stop offset="1" stopColor="#f59e0b" />
        </linearGradient>
      </defs>
      <path
        d="M12 2.5l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.4 6.1 20.5l1.2-6.5L2.5 9.4l6.6-.9z"
        fill={on ? 'url(#sg)' : 'var(--card-2)'}
        stroke={on ? '#f59e0b' : 'var(--stroke-2)'}
        strokeWidth="1"
        strokeLinejoin="round"
      />
    </motion.svg>
  );
}

export function ResultsScreen() {
  const r = useApp((s) => s.result);
  const line = useApp((s) => s.line);
  const units = useSettings((s) => s.units);
  const score = useMotionValue(0);
  const shown = useTransform(score, (v) => Math.round(v).toLocaleString());
  const [txt, setTxt] = useState('0');

  useEffect(() => {
    if (!r) return;
    const a = animate(score, r.score, { duration: 1.6, ease: [0.2, 0.8, 0.2, 1], delay: 0.35 });
    const unsub = shown.on('change', setTxt);
    return () => {
      a.stop();
      unsub();
    };
  }, [r, score, shown]);

  if (!r) return null;
  const ratio = r.score / r.maxScore;
  const style = { '--line': r.colour } as CSSProperties;

  const share = async () => {
    const text = `I scored ${r.score.toLocaleString()} (${'★'.repeat(r.stars)}${'☆'.repeat(3 - r.stars)}) driving ${r.lineRef} ${r.lineName} in ${r.cityName} on PublicPort 🚆`;
    try {
      if (navigator.share) await navigator.share({ text, title: 'PublicPort', url: location.origin });
      else await navigator.clipboard.writeText(text);
    } catch {
      /* cancelled */
    }
  };

  const leave = (fn: () => void) => {
    fn();
  };

  return (
    <motion.div className="results" style={style} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <motion.div
        className="results-card glass-strong"
        initial={{ y: 80, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ type: 'spring', stiffness: 260, damping: 28, delay: 0.1 }}
      >
        <div className="sheet-handle" style={{ marginTop: 2 }} />
        <div className="res-head">
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            {line && <LineBadge text={r.lineRef} colour={r.colour} textColour={line.textColour} size="sm" mode={r.mode} />}
            <span className="muted" style={{ fontSize: 13, fontWeight: 600 }}>
              {r.lineName} · {r.cityName}
            </span>
          </div>
          {r.free ? (
            <>
              <div className="free-tag">Free drive</div>
              <div className="res-score num">
                {Math.round(speedValue(r.maxSpeed ?? 0, units))}
                <span className="res-unit"> {speedUnit(units)}</span>
              </div>
              <div className="res-rank">Top speed · no limits, no score</div>
            </>
          ) : (
            <>
              <div className="stars">
                {[0, 1, 2].map((i) => (
                  <Star key={i} on={i < r.stars} delay={0.5 + i * 0.18} />
                ))}
              </div>
              <div className="res-score num">{txt}</div>
              <div className="res-rank">{rank(r.stars, ratio)}</div>
            </>
          )}
          {r.best && (
            <motion.div className="best-badge" initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ delay: 1.9, type: 'spring', stiffness: 400, damping: 15 }}>
              <Trophy size={14} /> New personal best
            </motion.div>
          )}
        </div>

        <div className="res-grid">
          <div className="stat">
            <small>Distance</small>
            <b className="num">{distance(r.distance, units)}</b>
          </div>
          <div className="stat">
            <small>Time</small>
            <b className="num">{duration(r.duration)}</b>
          </div>
          <div className="stat">
            <small>Comfort</small>
            <b className="num">{Math.round(r.comfort)}%</b>
          </div>
          {r.free ? (
            <div className="stat">
              <small>Top speed</small>
              <b className="num">{Math.round(speedValue(r.maxSpeed ?? 0, units))}</b>
            </div>
          ) : (
            <div className="stat">
              <small>On time</small>
              <b className="num">
                {r.onTime}/{r.stops.length + 1}
              </b>
            </div>
          )}
          <div className="stat">
            <small>{r.free ? 'Perfect' : 'Best streak'}</small>
            <b className="num">{r.free ? r.perfect : `${r.bestStreak ?? 0}×`}</b>
          </div>
          <div className="stat">
            <small>Riders</small>
            <b className="num">{r.paxDelivered.toLocaleString()}</b>
          </div>
        </div>

        {r.stops.length > 0 && (
          <>
            <div className="section-title">
              <span className="eyebrow">Stops</span>
            </div>
            <div className="stop-grades">
              {r.stops.map((s, i) => (
                <span key={i} className="grade" title={`${s.error.toFixed(1)} m`}>
                  <i style={{ background: GRADE_COL[s.grade] }} />
                  <span>{s.name}</span>
                  <span className="faint num">{s.grade === 'missed' ? 'missed' : `${s.error.toFixed(1)}m`}</span>
                </span>
              ))}
            </div>
          </>
        )}

        {!r.free && (
          <div className="section-title">
            <span className="eyebrow">Score breakdown</span>
          </div>
        )}
        {!r.free && r.breakdown.map((b) => (
          <div className="bd-row" key={b.label}>
            <span>{b.label}</span>
            <b className={b.points >= 0 ? 'pos' : 'neg'}>
              {b.points > 0 ? '+' : ''}
              {b.points.toLocaleString()}
            </b>
          </div>
        ))}

        <div className="res-actions">
          <button className="btn btn-line btn-block" onClick={() => leave(restartRun)}>
            <RotateCcw size={18} /> Drive again
          </button>
          <button className="btn btn-soft" onClick={() => leave(reverseRun)}>
            <ArrowLeftRight size={18} /> Return trip
          </button>
          <button
            className="btn btn-soft"
            onClick={() =>
              leave(() => {
                runner.stop();
                mapCtl.exitDrive();
                closeRoute();
                setApp({ result: null });
              })
            }
          >
            <List size={18} /> Other lines
          </button>
          <button className="btn btn-ghost btn-block" onClick={share}>
            <Share2 size={18} /> Share result
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}
