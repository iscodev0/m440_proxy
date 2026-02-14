import { Hono } from 'hono';
import { cors } from 'hono/cors';

type Bindings = { TARGET_ORIGIN: string };

const app = new Hono<{ Bindings: Bindings }>();
app.use('*', cors());

// ── Helpers ─────────────────────────────────────────────────
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ── Proxy pool ──────────────────────────────────────────────
interface ProxyEntry {
  host: string;
  port: number;
  type: 'http' | 'https' | 'socks4' | 'socks5';
}

interface ProxyState {
  entry: ProxyEntry;
  label: string;
  score: number;
  cooldownUntil: number;
  totalSuccess: number;
  totalFail: number;
}

// HTTP/HTTPS proxies first — FlareSolverr only supports HTTP proxies
const PRIMARY_PROXIES: ProxyEntry[] = [
  { host: '20.81.205.173', port: 80, type: 'http' },
  { host: '108.170.12.14', port: 80, type: 'http' },
  { host: '173.245.49.185', port: 80, type: 'http' },
  { host: '168.235.110.63', port: 3128, type: 'http' },
  { host: '190.153.237.6', port: 37453, type: 'http' },
  { host: '217.217.254.94', port: 8080, type: 'http' },
  { host: '115.190.91.223', port: 7897, type: 'https' },
  { host: '138.124.117.139', port: 31646, type: 'http' },
  { host: '78.63.115.20', port: 8899, type: 'socks5' },
  { host: '185.194.217.97', port: 1080, type: 'socks5' },
  { host: '187.102.16.66', port: 51327, type: 'socks4' },
  { host: '132.226.163.224', port: 2053, type: 'socks4' },
  { host: '37.9.171.155', port: 41075, type: 'socks4' },
  { host: '110.78.149.235', port: 4145, type: 'socks4' },
  { host: '116.99.238.62', port: 30025, type: 'socks4' },
];

const COOLDOWN_MS = 30_000;
const ERROR_COOLDOWN_MS = 60_000;
const DEAD_THRESHOLD = 50;
const proxyPool = new Map<string, ProxyState>();

function makeLabel(p: ProxyEntry): string {
  return `${p.type}://${p.host}:${p.port}`;
}

for (const p of PRIMARY_PROXIES) {
  const label = makeLabel(p);
  proxyPool.set(label, {
    entry: p, label, score: 0, cooldownUntil: 0,
    totalSuccess: 0, totalFail: 0,
  });
}
console.log(`[Pool] ${proxyPool.size} proxies loaded`);

let roundRobinIndex = 0;

function getNextProxy(): ProxyState | null {
  const now = Date.now();
  const all = Array.from(proxyPool.values());
  const available = all.filter(p => p.cooldownUntil <= now && p.score < DEAD_THRESHOLD);

  if (available.length === 0) {
    const nonDead = all.filter(p => p.score < DEAD_THRESHOLD);
    if (nonDead.length > 0) {
      for (const p of nonDead) p.cooldownUntil = 0;
      return getNextProxy();
    }
    for (const p of all) {
      p.cooldownUntil = 0;
      p.score = Math.max(0, p.score - 30);
    }
    return all.length > 0 ? all[0] : null;
  }

  available.sort((a, b) => a.score - b.score);
  const bestScore = available[0].score;
  const topTier = available.filter(p => p.score <= bestScore + 5);
  const pick = topTier[roundRobinIndex % topTier.length];
  roundRobinIndex++;
  return pick;
}

// Get only HTTP/HTTPS proxies (FlareSolverr doesn't support SOCKS)
function getHttpProxies(): ProxyState[] {
  return Array.from(proxyPool.values())
    .filter(p => p.entry.type === 'http' || p.entry.type === 'https')
    .filter(p => p.score < DEAD_THRESHOLD);
}

// ── FlareSolverr session cache ──────────────────────────────
// Cookies are tied to the proxy IP that solved the challenge,
// so we store which proxy was used.
interface CachedSession {
  cookies: string;
  userAgent: string;
  proxy: ProxyEntry;   // must use THIS proxy with these cookies
  obtainedAt: number;
}

let cachedSession: CachedSession | null = null;
const SESSION_TTL = 10 * 60 * 1000; // 10 min
let solvingInProgress: Promise<CachedSession | null> | null = null;

function getFlaresolverrUrl(): string {
  return process.env.FLARESOLVERR_URL || 'http://flaresolverr:8191/v1';
}

function getSession(): CachedSession | null {
  if (!cachedSession) return null;
  if (Date.now() - cachedSession.obtainedAt > SESSION_TTL) {
    cachedSession = null;
    return null;
  }
  return cachedSession;
}

async function solveChallenge(targetOrigin: string): Promise<CachedSession | null> {
  if (solvingInProgress) return solvingInProgress;

  solvingInProgress = (async () => {
    const fsUrl = getFlaresolverrUrl();
    const httpProxies = getHttpProxies();

    if (httpProxies.length === 0) {
      console.log(`[FlareSolverr] No HTTP proxies available`);
      return null;
    }

    // Try each HTTP proxy until one solves the challenge
    for (const proxyState of httpProxies) {
      const { entry } = proxyState;
      const proxyUrl = `http://${entry.host}:${entry.port}`;

      console.log(`[FlareSolverr] Solving via ${proxyUrl}...`);

      try {
        const res = await fetch(fsUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            cmd: 'request.get',
            url: targetOrigin,
            maxTimeout: 60000,
            proxy: { url: proxyUrl },
          }),
        });

        const data = await res.json() as any;

        if (data.status !== 'ok') {
          console.log(`  ! FlareSolverr failed via ${proxyUrl}: ${data.message || 'unknown'}`);
          continue;
        }

        // Check if the response is actually a block page (not just a challenge)
        const responseHtml = data.solution?.response || '';
        if (responseHtml.includes('you have been blocked') || responseHtml.includes('block_headline')) {
          console.log(`  ! Proxy ${proxyUrl} is blocked by Cloudflare`);
          proxyState.score += 30; // penalize heavily
          continue;
        }

        const cookies = (data.solution?.cookies || [])
          .map((c: any) => `${c.name}=${c.value}`)
          .join('; ');

        if (!cookies.includes('cf_clearance')) {
          console.log(`  ! No cf_clearance cookie via ${proxyUrl}`);
          continue;
        }

        const userAgent = data.solution?.userAgent || '';
        const session: CachedSession = {
          cookies,
          userAgent,
          proxy: entry,
          obtainedAt: Date.now(),
        };

        cachedSession = session;
        console.log(`[FlareSolverr] OK via ${proxyUrl} — got cf_clearance`);
        return session;
      } catch (err: any) {
        console.log(`  X FlareSolverr error via ${proxyUrl}: ${err.message}`);
        continue;
      }
    }

    console.log(`[FlareSolverr] All proxies failed to solve challenge`);
    return null;
  })();

  try {
    return await solvingInProgress;
  } finally {
    solvingInProgress = null;
  }
}

// ── Fetch via proxy ─────────────────────────────────────────
async function fetchViaProxy(
  targetUrl: string,
  proxy: ProxyEntry,
  headers: Record<string, string>,
): Promise<{ status: number; contentType: string | null; body: any; text?: string }> {
  const { ProxyAgent, fetch: proxyFetch } = await import('undici');
  const { request: undiciRequest } = await import('undici');

  const isSocks = proxy.type === 'socks4' || proxy.type === 'socks5';

  let status: number;
  let contentType: string | null;
  let body: any;

  if (isSocks) {
    const { SocksProxyAgent } = await import('socks-proxy-agent');
    const agent = new SocksProxyAgent(`${proxy.type}://${proxy.host}:${proxy.port}`);
    const res = await undiciRequest(targetUrl, {
      method: 'GET', headers, dispatcher: agent as any,
    });
    status = res.statusCode;
    contentType = res.headers['content-type'] as string | null;
    body = res.body;
  } else {
    const dispatcher = new ProxyAgent(`http://${proxy.host}:${proxy.port}`);
    const res = await proxyFetch(targetUrl, {
      method: 'GET', headers, dispatcher, redirect: 'follow',
    });
    status = res.status;
    contentType = res.headers.get('content-type');
    body = res.body;
  }

  // Check for Cloudflare challenge/block on 403/503
  if ((status === 403 || status === 503) && contentType?.includes('text/html')) {
    const chunks: Uint8Array[] = [];
    for await (const chunk of body) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString('utf-8');
    return { status, contentType, body: null, text };
  }

  return { status, contentType, body };
}

function isCloudflareBlock(text?: string): boolean {
  if (!text) return false;
  return text.includes('you have been blocked') ||
    text.includes('block_headline') ||
    text.includes('security verification') ||
    text.includes('cf-challenge') ||
    text.includes('challenge-platform') ||
    text.includes('Just a moment');
}

// ── Browser headers ─────────────────────────────────────────
const BROWSER_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'es-419,es;q=0.9,en;q=0.8',
  DNT: '1',
  'Sec-CH-UA': '"Chromium";v="131", "Not_A Brand";v="24"',
  'Sec-CH-UA-Mobile': '?0',
  'Sec-CH-UA-Platform': '"Windows"',
};

// ── Stats endpoint ──────────────────────────────────────────
app.get('/__stats', (c) => {
  const all = Array.from(proxyPool.values())
    .sort((a, b) => a.score - b.score)
    .map(p => ({
      proxy: p.label,
      score: p.score,
      success: p.totalSuccess,
      fail: p.totalFail,
      cooldown: p.cooldownUntil > Date.now()
        ? `${Math.ceil((p.cooldownUntil - Date.now()) / 1000)}s`
        : null,
      dead: p.score >= DEAD_THRESHOLD,
    }));

  const session = getSession();

  return c.json({
    total: proxyPool.size,
    available: all.filter(p => !p.cooldown && !p.dead).length,
    onCooldown: all.filter(p => p.cooldown).length,
    dead: all.filter(p => p.dead).length,
    session: session ? {
      proxy: makeLabel(session.proxy),
      age: `${Math.round((Date.now() - session.obtainedAt) / 1000)}s`,
      hasCfClearance: session.cookies.includes('cf_clearance'),
    } : null,
    proxies: all,
  });
});

// ── Main route — NEVER uses server IP, ONLY proxies ─────────
app.all('*', async (c) => {
  const target =
    c.env?.TARGET_ORIGIN || process.env.TARGET_ORIGIN || 'https://m440.in';
  const url = new URL(c.req.url);
  const targetUrl = target + url.pathname + url.search;

  const baseHeaders: Record<string, string> = {
    ...BROWSER_HEADERS,
    Referer: target + '/',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
  };

  if (url.pathname.startsWith('/lasted') || url.pathname.startsWith('/api')) {
    baseHeaders['Accept'] = 'application/json, text/plain, */*';
    baseHeaders['Sec-Fetch-Dest'] = 'empty';
    baseHeaders['Sec-Fetch-Mode'] = 'cors';
    baseHeaders['X-Requested-With'] = 'XMLHttpRequest';
  }

  // ── Step 1: try with cached FlareSolverr cookies + its proxy ──
  const session = getSession();
  if (session) {
    const headers = {
      ...baseHeaders,
      'User-Agent': session.userAgent,
      Cookie: session.cookies,
    };

    try {
      console.log(`[Cached] ${c.req.method} ${url.pathname} via ${makeLabel(session.proxy)}`);
      const result = await fetchViaProxy(targetUrl, session.proxy, headers);

      if (!isCloudflareBlock(result.text) && result.status < 500) {
        console.log(`  OK ${result.status} (cached session)`);
        const respHeaders = new Headers();
        if (result.contentType) respHeaders.set('Content-Type', result.contentType);
        respHeaders.set('X-Proxy-Mode', 'flaresolverr-cached');
        respHeaders.set('X-Proxy-Used', makeLabel(session.proxy));

        const body = result.text ?? result.body;
        return new Response(body as any, { status: result.status, headers: respHeaders });
      }

      console.log(`  ! Session expired or proxy blocked — clearing cache`);
      cachedSession = null;
    } catch (err: any) {
      console.log(`  X Cached session error: ${err.message}`);
      cachedSession = null;
    }
  }

  // ── Step 2: try proxy pool directly (some might not be challenged) ──
  const maxAttempts = 8;
  let lastError = '';
  let backoffMs = 1500;
  let needsChallengeSolve = false;

  for (let i = 0; i < maxAttempts; i++) {
    const state = getNextProxy();
    if (!state) break;

    const { entry, label } = state;

    try {
      console.log(`[${i + 1}/${maxAttempts}] ${c.req.method} ${url.pathname} -> ${label} (score:${state.score})`);

      const result = await fetchViaProxy(targetUrl, entry, baseHeaders);

      // Cloudflare challenge/block
      if (isCloudflareBlock(result.text)) {
        console.log(`  ! Cloudflare challenge/block via ${label}`);
        state.score += 5;
        lastError = `cloudflare block via ${label}`;
        needsChallengeSolve = true;
        continue;
      }

      if (result.status === 503) {
        state.totalFail++;
        state.score += 10;
        state.cooldownUntil = Date.now() + COOLDOWN_MS;
        console.log(`  ! 503 ${label} [score:${state.score}]`);
        lastError = `503 via ${label}`;
        await sleep(backoffMs);
        backoffMs = Math.min(backoffMs * 1.5, 10_000);
        continue;
      }

      state.totalSuccess++;
      state.score = Math.max(0, state.score - 1);
      console.log(`  OK ${result.status} via ${label} [score:${state.score}]`);

      const respHeaders = new Headers();
      if (result.contentType) respHeaders.set('Content-Type', result.contentType);
      respHeaders.set('X-Proxy-Used', label);

      return new Response(result.body as any, {
        status: result.status,
        headers: respHeaders,
      });
    } catch (err: any) {
      state.totalFail++;
      state.score += 20;
      state.cooldownUntil = Date.now() + ERROR_COOLDOWN_MS;
      console.log(`  X ${label} [score:${state.score}]: ${err.message}`);
      lastError = `${label}: ${err.message}`;
      await sleep(1000);
      continue;
    }
  }

  // ── Step 3: all proxies got challenged — use FlareSolverr ──
  if (needsChallengeSolve) {
    console.log(`[FlareSolverr] All proxies challenged — solving via FlareSolverr + proxy...`);
    const newSession = await solveChallenge(target);

    if (newSession) {
      const headers = {
        ...baseHeaders,
        'User-Agent': newSession.userAgent,
        Cookie: newSession.cookies,
      };

      try {
        console.log(`[FlareSolverr] Retrying ${url.pathname} via ${makeLabel(newSession.proxy)}`);
        const result = await fetchViaProxy(targetUrl, newSession.proxy, headers);

        if (!isCloudflareBlock(result.text) && result.status < 500) {
          console.log(`  OK ${result.status} (flaresolverr)`);
          const respHeaders = new Headers();
          if (result.contentType) respHeaders.set('Content-Type', result.contentType);
          respHeaders.set('X-Proxy-Mode', 'flaresolverr');
          respHeaders.set('X-Proxy-Used', makeLabel(newSession.proxy));

          const body = result.text ?? result.body;
          return new Response(body as any, { status: result.status, headers: respHeaders });
        }
        console.log(`  ! Still blocked after FlareSolverr`);
        lastError = 'flaresolverr solved but still blocked';
      } catch (err: any) {
        console.log(`  X FlareSolverr retry failed: ${err.message}`);
        lastError = `flaresolverr: ${err.message}`;
      }
    } else {
      lastError = 'flaresolverr could not solve challenge';
    }
  }

  return c.json({ error: 'All attempts failed', last: lastError }, 502);
});

export default app;
