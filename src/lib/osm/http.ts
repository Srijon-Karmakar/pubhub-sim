export class NetError extends Error {
  constructor(
    message: string,
    public status = 0,
  ) {
    super(message);
  }
}

export async function fetchJson<T>(url: string, init: RequestInit = {}, timeoutMs = 20000): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const outer = init.signal;
  const onAbort = () => ctrl.abort();
  outer?.addEventListener('abort', onAbort);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    if (!res.ok) throw new NetError(`HTTP ${res.status}`, res.status);
    return (await res.json()) as T;
  } catch (e) {
    if (outer?.aborted) throw new DOMException('Aborted', 'AbortError');
    if ((e as Error).name === 'AbortError') throw new NetError('Timed out', 408);
    throw e;
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener('abort', onAbort);
  }
}

const PROXY = '/api/overpass';
const DIRECT = [
  'https://overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

const isLocal = typeof location !== 'undefined' && /^(localhost|127\.|\[::1\]|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(location.hostname);

/**
 * overpass-api.de refuses browser requests from free-hosting domains
 * (*.vercel.app, *.netlify.app, …), so deployed builds go through our own
 * serverless proxy (api/overpass.ts) first, then straight to the mirrors that
 * allow it. On localhost the browser can talk to every server directly.
 */
const OVERPASS = isLocal ? DIRECT : [PROXY, ...DIRECT.filter((u) => !u.includes('overpass-api.de'))];

let preferred = 0;

export interface OverpassResult<E = OverpassElement> {
  elements: E[];
  remark?: string;
}

export interface OverpassElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  tags?: Record<string, string>;
  lat?: number;
  lon?: number;
  members?: OverpassMember[];
  geometry?: { lat: number; lon: number }[] | null;
  center?: { lat: number; lon: number };
}

export interface OverpassMember {
  type: 'node' | 'way' | 'relation';
  ref: number;
  role: string;
  lat?: number;
  lon?: number;
  geometry?: ({ lat: number; lon: number } | null)[];
}

/**
 * Runs an Overpass QL query, rotating through public mirrors when one is
 * overloaded. `onAttempt` lets the UI show which server is being asked.
 */
export async function overpass(
  query: string,
  opts: { timeoutMs?: number; signal?: AbortSignal; onAttempt?: (host: string, n: number) => void } = {},
): Promise<OverpassResult> {
  let lastErr: unknown = null;
  let attempt = 0;
  for (let n = 0; n < OVERPASS.length; n++) {
    const idx = (preferred + n) % OVERPASS.length;
    const url = OVERPASS[idx];
    const proxy = url === PROXY;
    // "busy" answers (429/504) usually clear within seconds, and overpass-api.de
    // is far faster than the mirrors, so retry it briefly first (the proxy
    // already retries server-side)
    const retries = n === 0 && !proxy ? 2 : 0;
    for (let r = 0; r <= retries; r++) {
      opts.onAttempt?.(proxy ? 'overpass-api.de' : new URL(url).host, attempt++);
      try {
        // the proxy uses GET so Vercel's CDN can cache each city's answer
        const res = proxy
          ? await fetchJson<OverpassResult>(`${PROXY}?data=${encodeURIComponent(query)}`, { signal: opts.signal }, Math.max(opts.timeoutMs ?? 0, 62000))
          : await fetchJson<OverpassResult>(
              url,
              {
                method: 'POST',
                body: 'data=' + encodeURIComponent(query),
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                signal: opts.signal,
              },
              opts.timeoutMs ?? 90000,
            );
        if (!Array.isArray(res?.elements)) throw new NetError('Unexpected response', 502);
        if (res.remark && /runtime error|timed out|out of memory/i.test(res.remark) && res.elements.length === 0) {
          throw new NetError(res.remark, 504);
        }
        preferred = idx;
        return res;
      } catch (e) {
        if ((e as Error).name === 'AbortError') throw e;
        lastErr = e;
        const busy = e instanceof NetError && (e.status === 429 || e.status === 504);
        if (!busy || r === retries) break;
        await new Promise((ok) => setTimeout(ok, 1500 * (r + 1)));
        if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new NetError('All Overpass servers failed');
}
