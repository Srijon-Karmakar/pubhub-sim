/**
 * Vercel serverless proxy for Overpass API.
 *
 * overpass-api.de rejects browser requests coming from free-hosting origins
 * (*.vercel.app, *.netlify.app, …) but accepts server requests that identify the
 * app. Successful responses are cached on Vercel's CDN, so a city loaded once
 * loads instantly for everyone afterwards.
 *
 *   GET /api/overpass?data=<Overpass QL>
 */
const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

const USER_AGENT = 'PublicPort/1.0 (+https://github.com/Srijon-Karmakar/pubhub-sim)';
const BUDGET_MS = 55_000;

function json(body: unknown, status: number, cache = 'no-store') {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': cache },
  });
}

async function query(url: string, data: string, timeoutMs: number) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, {
      method: 'POST',
      body: 'data=' + encodeURIComponent(data),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

export async function GET(request: Request) {
  const data = new URL(request.url).searchParams.get('data');
  if (!data || data.length > 8000) return json({ error: 'Missing or oversized "data" parameter' }, 400);
  if (!/\[out:json\]/.test(data)) return json({ error: 'Only [out:json] queries are allowed' }, 400);

  const deadline = Date.now() + BUDGET_MS;
  let lastStatus = 502;
  for (let i = 0; i < ENDPOINTS.length; i++) {
    // the primary server is much faster, so give "busy" answers a couple of quick retries
    const tries = i === 0 ? 3 : 1;
    for (let t = 0; t < tries; t++) {
      const left = deadline - Date.now();
      if (left < 3000) return json({ error: 'Overpass servers are busy' }, 504);
      try {
        const res = await query(ENDPOINTS[i], data, Math.min(left, i === 0 ? 30_000 : 40_000));
        if (res.ok) {
          const text = await res.text();
          if (!text.trimStart().startsWith('{')) throw new Error('non-JSON response');
          const body = JSON.parse(text) as { elements?: unknown[]; remark?: string };
          if (body.remark && /runtime error|timed out|out of memory/i.test(body.remark) && !body.elements?.length) {
            lastStatus = 504;
            break;
          }
          return new Response(text, {
            status: 200,
            headers: {
              'Content-Type': 'application/json; charset=utf-8',
              'Cache-Control': 'public, s-maxage=86400, stale-while-revalidate=604800',
            },
          });
        }
        lastStatus = res.status;
        if (res.status !== 429 && res.status !== 504) break;
        await new Promise((ok) => setTimeout(ok, 1200 * (t + 1)));
      } catch {
        lastStatus = 504;
        break;
      }
    }
  }
  return json({ error: 'All Overpass servers failed' }, lastStatus >= 500 ? lastStatus : 502);
}
