import { AnimatePresence } from 'motion/react';
import { useEffect } from 'react';
import { MapStage } from './components/MapStage';
import { AboutScreen } from './components/screens/About';
import { CityScreen } from './components/screens/City';
import { DriveScreen } from './components/screens/Drive';
import { HomeScreen } from './components/screens/Home';
import { ResultsScreen } from './components/screens/Results';
import { RouteScreen } from './components/screens/Route';
import { SearchOverlay } from './components/screens/SearchOverlay';
import { SettingsSheet } from './components/screens/SettingsSheet';
import { initHistory } from './game/actions';
import { refreshTheme, syncTheme } from './game/env';
import { audio } from './lib/audio/audio';
import { setHaptics } from './lib/haptics';
import { useApp } from './store/app';
import { useSettings } from './store/settings';

export default function App() {
  const screen = useApp((s) => s.screen);
  const searchOpen = useApp((s) => s.searchOpen);
  const settingsOpen = useApp((s) => s.settingsOpen);
  const theme = useSettings((s) => s.theme);

  useEffect(() => {
    initHistory();
    const st = useSettings.getState();
    setHaptics(st.haptics);
    audio.announcements = st.announcements;
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const on = () => syncTheme();
    mq.addEventListener('change', on);
    // unlock audio on first interaction anywhere
    const unlock = () => {
      audio.init();
      audio.setEnabled(useSettings.getState().sound, useSettings.getState().volume);
      window.removeEventListener('pointerdown', unlock);
    };
    window.addEventListener('pointerdown', unlock);
    return () => mq.removeEventListener('change', on);
  }, []);

  useEffect(() => {
    refreshTheme();
  }, [theme]);

  return (
    <div className="app" data-screen={screen}>
      <MapStage />
      <AnimatePresence mode="sync">
        {screen === 'home' && <HomeScreen key="home" />}
        {screen === 'about' && <AboutScreen key="about" />}
        {screen === 'city' && <CityScreen key="city" />}
        {screen === 'route' && <RouteScreen key="route" />}
        {(screen === 'drive' || screen === 'results') && <DriveScreen key="drive" />}
      </AnimatePresence>
      <AnimatePresence>{screen === 'results' && <ResultsScreen key="results" />}</AnimatePresence>
      <AnimatePresence>{searchOpen && <SearchOverlay key="search" />}</AnimatePresence>
      <AnimatePresence>{settingsOpen && <SettingsSheet key="settings" />}</AnimatePresence>
    </div>
  );
}
