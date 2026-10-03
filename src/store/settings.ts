import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { CameraMode } from '../types';
import type { Units } from '../lib/format';

export type ThemePref = 'auto' | 'system' | 'light' | 'dark';

export interface Settings {
  theme: ThemePref;
  units: Units;
  sound: boolean;
  volume: number;
  announcements: boolean;
  haptics: boolean;
  autoDoors: boolean;
  assists: boolean;
  quality: 'high' | 'low';
  camera: CameraMode;
  headingUp: boolean;
  tutorialDone: boolean;
  set: (p: Partial<Omit<Settings, 'set'>>) => void;
}

export const useSettings = create<Settings>()(
  persist(
    (set) => ({
      theme: 'auto',
      units: 'metric',
      sound: true,
      volume: 0.8,
      announcements: true,
      haptics: true,
      autoDoors: false,
      assists: true,
      quality: 'high',
      camera: 'chase',
      headingUp: true,
      tutorialDone: false,
      set: (p) => set(p),
    }),
    { name: 'publicport-settings', version: 1 },
  ),
);
