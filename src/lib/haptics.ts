let enabled = true;

export function setHaptics(on: boolean) {
  enabled = on;
}

export function haptic(pattern: number | number[]) {
  if (!enabled) return;
  try {
    navigator.vibrate?.(pattern);
  } catch {
    /* unsupported */
  }
}
