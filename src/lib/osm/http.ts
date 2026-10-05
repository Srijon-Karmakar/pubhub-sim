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

let order = OVERPASS.slice();

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

async function queryOne(url: string, query: string, signal: AbortSignal, timeoutMs: number): Promise<OverpassResult> {
  // the proxy uses GET so Vercel's CDN can cache each answer
  const res =
    url === PROXY
      ? await fetchJson<OverpassResult>(`${PROXY}?data=${encodeURIComponent(query)}`, { signal }, Math.max(timeoutMs, 62000))
      : await fetchJson<OverpassResult>(
          url,
          {
            method: 'POST',
            body: 'data=' + encodeURIComponent(query),
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            signal,
          },
          timeoutMs,
        );
  if (!Array.isArray(res?.elements)) throw new NetError('Unexpected response', 502);
  if (res.remark && /runtime error|timed out|out of memory/i.test(res.remark) && res.elements.length === 0) {
    throw new NetError(res.remark, 504);
  }
  return res;
}

/**
 * Runs an Overpass QL query against several public servers as a staggered
 * race: the next server starts if the current one hasn't answered within
 * `staggerMs` (or as soon as it fails), and the first good answer wins.
 * `onAttempt` lets the UI show which server is being asked.
 */
export function overpass(
  query: string,
  opts: { timeoutMs?: number; signal?: AbortSignal; staggerMs?: number; onAttempt?: (host: string, n: number) => void } = {},
): Promise<OverpassResult> {
  const eps = order.slice();
  const stagger = opts.staggerMs ?? 5000;
  return new Promise((resolve, reject) => {
    let settled = false;
    let next = 0;
    let attempts = 0;
    let inFlight = 0;
    let pendingRetries = 0;
    let lastErr: unknown = null;
    const retried = new Map<string, number>();
    const ctrls: AbortController[] = [];
    const timers: number[] = [];
    const done = () => {
      settled = true;
      timers.forEach(clearTimeout);
      ctrls.forEach((c) => c.abort());
      opts.signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      if (settled) return;
      done();
      reject(new DOMException('Aborted', 'AbortError'));
    };
    const maybeFail = () => {
      if (settled || inFlight > 0 || pendingRetries > 0 || next < eps.length) return;
      done();
      reject(lastErr instanceof Error ? lastErr : new NetError('All Overpass servers failed'));
    };
    const attempt = (url: string) => {
      if (settled) return;
      const ctrl = new AbortController();
      ctrls.push(ctrl);
      inFlight++;
      opts.onAttempt?.(url === PROXY ? 'overpass-api.de' : new URL(url).host, attempts++);
      queryOne(url, query, ctrl.signal, opts.timeoutMs ?? 60000).then(
        (res) => {
          inFlight--;
          if (settled) return;
          done();
          // remember the winner for next time
          order = [url, ...order.filter((u) => u !== url)];
          resolve(res);
        },
        (e) => {
          inFlight--;
          if (settled) return;
          lastErr = e;
          // "busy" answers clear within seconds: give the fastest server a couple more tries
          const busy = e instanceof NetError && (e.status === 429 || e.status === 504);
          const n = retried.get(url) ?? 0;
          if (busy && url === eps[0] && n < 2) {
            retried.set(url, n + 1);
            pendingRetries++;
            timers.push(
              window.setTimeout(() => {
                pendingRetries--;
                attempt(url);
              }, 1800 * (n + 1)),
            );
          }
          launchNext();
          maybeFail();
        },
      );
    };
    const launchNext = () => {
      if (settled || next >= eps.length) return;
      attempt(eps[next++]);
    };
    opts.signal?.addEventListener('abort', onAbort);
    launchNext();
    for (let i = 1; i < eps.length; i++) timers.push(window.setTimeout(launchNext, stagger * i));
  });
}
