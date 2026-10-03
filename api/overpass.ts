/**
 * Vercel serverless proxy for Overpass API.
 *
 * overpass-api.de rejects browser requests coming from free-hosting origins
 * (*.vercel.app, *.netlify.app, …) but accepts server requests that identify the
 * app. Servers are raced with a stagger (the next starts if the previous hasn't
 * answered in a few seconds) and successful responses are cached on Vercel's
 * CDN, so a city loaded once loads instantly for everyone afterwards.
 *
 *   GET /api/overpass?data=<Overpass QL>
 */
const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

const USER_AGENT = 'PublicPort/1.0 (+https://github.com/Srijon-Karmakar/pubhub-sim)';
const BUDGET_MS = 55_000;
const STAGGER_MS = 4_000;

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

async function attempt(url: string, data: string, signal: AbortSignal): Promise<string> {
  const res = await fetch(url, {
    method: 'POST',
    body: 'data=' + encodeURIComponent(data),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  if (!text.trimStart().startsWith('{')) throw new Error('non-JSON response');
  const body = JSON.parse(text) as { elements?: unknown[]; remark?: string };
  if (!Array.isArray(body.elements)) throw new Error('no elements');
  if (body.remark && /runtime error|timed out|out of memory/i.test(body.remark) && !body.elements.length) throw new Error(body.remark);
  return text;
}

/** Staggered race: first successful server wins, the rest are cancelled. */
function race(data: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const ctrls: AbortController[] = [];
    const timers: ReturnType<typeof setTimeout>[] = [];
    let started = 0;
    let failed = 0;
    let settled = false;
    const finish = () => {
      settled = true;
      timers.forEach(clearTimeout);
      ctrls.forEach((c) => c.abort());
    };
    const launch = () => {
      if (settled || started >= ENDPOINTS.length) return;
      const url = ENDPOINTS[started++];
      const ctrl = new AbortController();
      ctrls.push(ctrl);
      attempt(url, data, ctrl.signal).then(
        (text) => {
          if (settled) return;
          finish();
          resolve(text);
        },
        () => {
          if (settled) return;
          if (++failed >= ENDPOINTS.length) {
            finish();
            reject(new Error('All Overpass servers failed'));
          } else launch();
        },
      );
    };
    launch();
    for (let i = 1; i < ENDPOINTS.length; i++) timers.push(setTimeout(launch, STAGGER_MS * i));
    timers.push(
      setTimeout(() => {
        if (settled) return;
        finish();
        reject(new Error('Overpass servers are busy'));
      }, BUDGET_MS),
    );
  });
}

export async function GET(request: Request) {
  const data = new URL(request.url).searchParams.get('data');
  if (!data || data.length > 8000) return json({ error: 'Missing or oversized "data" parameter' }, 400);
  if (!/\[out:json\]/.test(data)) return json({ error: 'Only [out:json] queries are allowed' }, 400);
  try {
    const text = await race(data);
    return new Response(text, {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'public, s-maxage=86400, stale-while-revalidate=604800',
      },
    });
  } catch (e) {
    return json({ error: (e as Error).message }, 504);
  }
}
