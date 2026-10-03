import { useEffect, useRef } from 'react';
import { mapCtl } from '../map/mapController';
import { homeEnv } from '../game/actions';
import { useSettings } from '../store/settings';

export function MapStage() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    const c = homeEnv();
    mapCtl.init(ref.current, c.lat, c.lon);
    mapCtl.setInteractive(false);
    mapCtl.setLabels('minimal');
    if (useSettings.getState().quality === 'low') mapCtl.setQuality('low');
    void mapCtl.ready.then(() => {
      homeEnv();
      mapCtl.startOrbit(c.lat, c.lon, { zoom: 15.2, pitch: 60, speed: 2.4, fly: false });
    });
  }, []);
  return <div ref={ref} className="map-stage" />;
}
