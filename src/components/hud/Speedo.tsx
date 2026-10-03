import { speedUnit, speedValue, distance, type Units } from '../../lib/format';

const R = 50;
const CIRC = 2 * Math.PI * R;
const ARC = CIRC * 0.75;

export function Speedo({ speed, limit, vmax, accel, overspeed, units }: { speed: number; limit: number; vmax: number; accel: number; overspeed: boolean; units: Units }) {
  const scale = Math.ceil((vmax * 1.12 * 3.6) / 20) * 20 / 3.6;
  const f = Math.min(1, speed / scale);
  const lf = Math.min(1, limit / scale);
  const near = limit > 0 && speed > limit - 0.6;
  const col = overspeed ? 'var(--bad)' : near ? 'var(--warn)' : 'var(--accent)';
  const accTxt = Math.abs(accel) < 0.05 ? 'COAST' : `${accel > 0 ? '▲' : '▼'} ${Math.abs(accel).toFixed(1)}`;
  return (
    <div className="speedo glass">
      <svg viewBox="0 0 120 120">
        <circle cx="60" cy="60" r={R} fill="none" stroke="var(--stroke-2)" strokeWidth="8" strokeLinecap="butt" strokeDasharray={`${ARC} ${CIRC}`} />
        <circle
          cx="60"
          cy="60"
          r={R}
          fill="none"
          stroke={col}
          strokeWidth="8"
          strokeLinecap="butt"
          strokeDasharray={`${Math.max(0.001, ARC * f)} ${CIRC}`}
          style={{ transition: 'stroke-dasharray .12s linear, stroke .2s' }}
        />
        {/* limit tick (none in free drive) */}
        {limit > 0 && (
        <circle
          cx="60"
          cy="60"
          r={R}
          fill="none"
          stroke="#e11d2e"
          strokeWidth="14"
          strokeDasharray={`2.2 ${CIRC}`}
          strokeDashoffset={-(ARC * lf - 1.1)}
          style={{ transition: 'stroke-dashoffset .4s' }}
        />
        )}
      </svg>
      <div className="v">
        <b className="num" style={{ color: overspeed ? 'var(--bad)' : undefined }}>
          {Math.round(speedValue(speed, units))}
        </b>
        <small>{speedUnit(units)}</small>
      </div>
      <div className="acc num" style={{ color: accel > 0.05 ? 'var(--accent)' : accel < -0.05 ? 'var(--warn)' : 'var(--text-3)' }}>
        {accTxt}
      </div>
    </div>
  );
}

export function LimitSign({ limit, next, overspeed, units }: { limit: number; next: { dist: number; v: number } | null; overspeed: boolean; units: Units }) {
  return (
    <div className="limit-col">
      {next && (
        <div className="limit-next glass num">
          <span className="mini">{Math.round(speedValue(next.v, units))}</span>
          {distance(next.dist, units)}
        </div>
      )}
      <div className={`limit-sign num ${overspeed ? 'over' : ''}`}>{Math.round(speedValue(limit, units))}</div>
    </div>
  );
}
