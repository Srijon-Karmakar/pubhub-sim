import { Bus, CableCar, Ship, TrainFront, TrainTrack, TramFront, type LucideProps } from 'lucide-react';
import { motion } from 'motion/react';
import type { ComponentType, ReactNode } from 'react';
import type { Mode, ModeGroup } from '../../types';
import { MODE_GROUP } from '../../lib/sim/profiles';

const GROUP_ICON: Record<ModeGroup, ComponentType<LucideProps>> = {
  metro: TrainFront,
  train: TrainTrack,
  tram: TramFront,
  monorail: CableCar,
  bus: Bus,
  ferry: Ship,
};

export function ModeIcon({ mode, group, size = 18, ...rest }: { mode?: Mode; group?: ModeGroup; size?: number } & LucideProps) {
  const g = group ?? (mode ? MODE_GROUP[mode] : 'metro');
  const I = GROUP_ICON[g];
  return <I size={size} strokeWidth={2.2} {...rest} />;
}

export function LineBadge({
  text,
  colour,
  textColour,
  size,
  circle,
  mode,
}: {
  text: string;
  colour: string;
  textColour: string;
  size?: 'sm' | 'lg';
  circle?: boolean;
  mode?: Mode;
}) {
  if (!text) {
    return (
      <span className={`badge ${size ?? ''} ${circle ? 'circle' : ''}`} style={{ background: colour, color: textColour }}>
        <ModeIcon mode={mode} size={size === 'lg' ? 22 : size === 'sm' ? 13 : 17} />
      </span>
    );
  }
  const fs = text.length > 5 ? 0.72 : text.length > 3 ? 0.86 : 1;
  return (
    <span
      className={`badge ${size ?? ''} ${circle ? 'circle' : ''}`}
      style={{ background: colour, color: textColour }}
    >
      <span style={{ fontSize: `${fs}em` }}>{text}</span>
    </span>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  id,
}: {
  value: T;
  options: { value: T; label: ReactNode }[];
  onChange: (v: T) => void;
  id: string;
}) {
  return (
    <div className="segmented" role="tablist">
      {options.map((o) => (
        <button key={o.value} role="tab" aria-selected={o.value === value} className={o.value === value ? 'on' : ''} onClick={() => onChange(o.value)}>
          {o.value === value && <motion.span layoutId={`seg-${id}`} className="seg-pill" transition={{ type: 'spring', stiffness: 500, damping: 38 }} />}
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return <button role="switch" aria-checked={on} aria-label={label} className={`toggle ${on ? 'on' : ''}`} onClick={() => onChange(!on)} />;
}

export function Stars({ n, size = 14 }: { n: number; size?: number }) {
  return (
    <span className="best-stars" aria-label={`${n} of 3 stars`}>
      {[0, 1, 2].map((i) => (
        <svg key={i} width={size} height={size} viewBox="0 0 24 24" fill={i < n ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" opacity={i < n ? 1 : 0.35}>
          <path d="M12 2.5l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.4 6.1 20.5l1.2-6.5L2.5 9.4l6.6-.9z" strokeLinejoin="round" />
        </svg>
      ))}
    </span>
  );
}
