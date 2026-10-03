import { useEffect, useRef } from 'react';
import type { WeatherKind } from '../types';
import { useHud } from '../store/hud';

/** Screen-space rain / snow / lightning, streaks lean with vehicle speed. */
export function WeatherOverlay({ kind, hidden }: { kind: WeatherKind; hidden: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv || !(kind === 'rain' || kind === 'storm' || kind === 'snow')) return;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    let raf = 0;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const resize = () => {
      cv.width = cv.clientWidth * dpr;
      cv.height = cv.clientHeight * dpr;
    };
    resize();
    window.addEventListener('resize', resize);
    const snow = kind === 'snow';
    const N = snow ? 160 : kind === 'storm' ? 320 : 200;
    const parts = Array.from({ length: N }, () => ({ x: Math.random(), y: Math.random(), z: 0.3 + Math.random() * 0.7, w: Math.random() * Math.PI * 2 }));
    let last = performance.now();
    let flash = 0;
    const tick = (t: number) => {
      raf = requestAnimationFrame(tick);
      const dt = Math.min(0.05, (t - last) / 1000);
      last = t;
      const W = cv.width;
      const H = cv.height;
      ctx.clearRect(0, 0, W, H);
      const v = useHud.getState().snap?.speed ?? 0;
      const lean = Math.min(0.9, v / 25);
      if (kind === 'storm') {
        if (Math.random() < dt * 0.08) flash = 1;
        if (flash > 0) {
          ctx.fillStyle = `rgba(220,230,255,${flash * 0.35})`;
          ctx.fillRect(0, 0, W, H);
          flash = Math.max(0, flash - dt * 3);
        }
      }
      if (snow) {
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        for (const p of parts) {
          p.y += dt * (0.05 + p.z * 0.08 + lean * 0.12);
          p.w += dt * 1.5;
          p.x += dt * (Math.sin(p.w) * 0.02 - lean * 0.05 * (p.x - 0.5));
          if (p.y > 1) {
            p.y = -0.02;
            p.x = Math.random();
          }
          if (p.x < 0) p.x += 1;
          if (p.x > 1) p.x -= 1;
          ctx.globalAlpha = 0.35 + p.z * 0.6;
          ctx.beginPath();
          ctx.arc(p.x * W, p.y * H, (1 + p.z * 2.2) * dpr, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.globalAlpha = 1;
      } else {
        ctx.strokeStyle = 'rgba(200,215,235,0.45)';
        ctx.lineCap = 'round';
        for (const p of parts) {
          const sp = 1.2 + p.z * 1.6 + lean * 0.8;
          p.y += dt * sp;
          // radial streaks when moving fast (from vanishing point)
          const dx = (p.x - 0.5) * lean * 0.9;
          p.x += dx * dt;
          if (p.y > 1.05 || p.x < -0.05 || p.x > 1.05) {
            p.y = -0.05 - Math.random() * 0.1;
            p.x = Math.random();
          }
          const len = (14 + p.z * 22 + lean * 26) * dpr;
          ctx.lineWidth = (0.6 + p.z * 0.9) * dpr;
          ctx.globalAlpha = 0.25 + p.z * 0.5;
          ctx.beginPath();
          const x = p.x * W;
          const y = p.y * H;
          ctx.moveTo(x, y);
          ctx.lineTo(x - dx * len * 2 - 2 * dpr, y - len);
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
      }
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
    };
  }, [kind]);

  return (
    <>
      {(kind === 'fog' || kind === 'storm') && <div className="fog-layer" style={{ opacity: hidden ? 0 : kind === 'fog' ? 1 : 0.5 }} />}
      {(kind === 'rain' || kind === 'storm' || kind === 'snow') && (
        <canvas ref={ref} className="weather-canvas" style={{ width: '100%', height: '100%', opacity: hidden ? 0 : 1, transition: 'opacity .8s' }} />
      )}
    </>
  );
}
