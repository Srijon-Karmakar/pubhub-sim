import { createStore, get, set, del, clear, keys } from 'idb-keyval';

const store = typeof indexedDB !== 'undefined' ? createStore('publicport', 'cache') : undefined;

interface Entry<T> {
  t: number;
  v: T;
}

export async function cacheGet<T>(key: string, maxAgeMs: number): Promise<T | null> {
  if (!store) return null;
  try {
    const e = await get<Entry<T>>(key, store);
    if (!e) return null;
    if (Date.now() - e.t > maxAgeMs) return null;
    return e.v;
  } catch {
    return null;
  }
}

export async function cacheSet<T>(key: string, v: T): Promise<void> {
  if (!store) return;
  try {
    await set(key, { t: Date.now(), v } satisfies Entry<T>, store);
  } catch {
    /* quota or private mode: ignore */
  }
}

export async function cacheDel(key: string): Promise<void> {
  if (!store) return;
  try {
    await del(key, store);
  } catch {
    /* ignore */
  }
}

export async function cacheClear(): Promise<void> {
  if (!store) return;
  try {
    await clear(store);
  } catch {
    /* ignore */
  }
}

export async function cacheCount(): Promise<number> {
  if (!store) return 0;
  try {
    return (await keys(store)).length;
  } catch {
    return 0;
  }
}

export const DAY = 24 * 3600 * 1000;
