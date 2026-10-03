import { animate, motion, useDragControls, useMotionValue } from 'motion/react';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type UIEvent } from 'react';

function useViewport() {
  const [vp, setVp] = useState(() => ({ h: window.innerHeight, w: window.innerWidth }));
  useEffect(() => {
    const on = () => setVp({ h: window.innerHeight, w: window.innerWidth });
    window.addEventListener('resize', on);
    window.visualViewport?.addEventListener('resize', on);
    return () => {
      window.removeEventListener('resize', on);
      window.visualViewport?.removeEventListener('resize', on);
    };
  }, []);
  return vp;
}

/**
 * Mobile bottom sheet with snap points (fractions of viewport height).
 * Turns into a floating side panel on wide screens.
 */
export function Sheet({
  snaps = [0.42, 0.9],
  initial = 0,
  header,
  children,
  footer,
  onSnap,
}: {
  snaps?: number[];
  initial?: number;
  header?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  onSnap?: (i: number) => void;
}) {
  const { h, w } = useViewport();
  const desktop = w >= 900;
  const max = Math.max(...snaps);
  const sheetH = Math.round(h * max);
  const yFor = (i: number) => Math.round((max - snaps[i]) * h);
  const y = useMotionValue(desktop ? 0 : h);
  const [snap, setSnap] = useState(initial);
  const controls = useDragControls();
  const contentRef = useRef<HTMLDivElement>(null);
  const footerRef = useRef<HTMLDivElement>(null);
  const [footerH, setFooterH] = useState(0);

  useEffect(() => {
    if (desktop) {
      y.set(0);
      return;
    }
    const a = animate(y, yFor(snap), { type: 'spring', stiffness: 380, damping: 40 });
    return () => a.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snap, h, desktop]);

  useLayoutEffect(() => {
    if (!footerRef.current) return setFooterH(0);
    const ro = new ResizeObserver(() => setFooterH(footerRef.current?.offsetHeight ?? 0));
    ro.observe(footerRef.current);
    return () => ro.disconnect();
  }, [footer]);

  const go = (i: number) => {
    setSnap(i);
    onSnap?.(i);
  };

  const onScroll = (e: UIEvent<HTMLDivElement>) => {
    if (desktop) return;
    const top = (e.target as HTMLDivElement).scrollTop;
    if (top > 8 && snap !== snaps.length - 1) go(snaps.length - 1);
  };

  return (
    <>
      <motion.div
        className="sheet glass-strong"
        style={{ height: desktop ? undefined : sheetH, y }}
        drag={desktop ? false : 'y'}
        dragListener={false}
        dragControls={controls}
        dragConstraints={{ top: 0, bottom: yFor(0) + h * 0.12 }}
        dragElastic={0.08}
        dragMomentum={false}
        onDragEnd={(_, info) => {
          const cur = y.get();
          const v = info.velocity.y;
          let best = 0;
          let bd = Infinity;
          snaps.forEach((_, i) => {
            const d = Math.abs(yFor(i) - (cur + v * 0.18));
            if (d < bd) {
              bd = d;
              best = i;
            }
          });
          if (best === snap) animate(y, yFor(best), { type: 'spring', stiffness: 380, damping: 40 });
          go(best);
        }}
        initial={false}
      >
        <div
          className="sheet-handle-area"
          onPointerDown={(e) => {
            if (!desktop) controls.start(e);
          }}
          onClick={() => {
            if (!desktop && snaps.length > 1 && snap === 0) go(snaps.length - 1);
          }}
        >
          <div className="sheet-handle" />
          {header}
        </div>
        <div
          className="sheet-content"
          ref={contentRef}
          onScroll={onScroll}
          style={{ paddingBottom: (footer ? footerH : 0) + 24 + (desktop ? 0 : (max - snaps[snap]) * h) }}
        >
          {children}
          {!desktop && <div style={{ height: 'env(safe-area-inset-bottom, 0px)' }} />}
        </div>
      </motion.div>
      {footer && (
        <div className="sheet-footer" ref={footerRef}>
          {footer}
        </div>
      )}
    </>
  );
}
