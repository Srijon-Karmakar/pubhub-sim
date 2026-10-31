import '@fontsource-variable/onest';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import App from './App';
import './styles/global.css';
import { LOW_END } from './lib/device';

registerSW({ immediate: true });

if (LOW_END) document.documentElement.classList.add('lite');

if (import.meta.env.DEV) {
  void Promise.all([import('./game/actions'), import('./game/runner'), import('./store/app'), import('./store/hud'), import('./map/mapController')]).then(([actions, r, app, hud, mc]) => {
    (window as unknown as Record<string, unknown>).__pp = { actions, runner: r.runner, useApp: app.useApp, useHud: hud.useHud };
    Object.defineProperty(window, '__map', { get: () => mc.mapCtl.map });
  });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
