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
  username?: string;
  password?: string;
}

interface ProxyState {
  entry: ProxyEntry;
  label: string;
  score: number;
  cooldownUntil: number;
  totalSuccess: number;
  totalFail: number;
}

// ── Parse proxies from env ──────────────────────────────────
// Format: PROXY_LIST="http://user:pass@host:port,socks5://host:port,http://host:port"
function parseProxyList(raw: string): ProxyEntry[] {
  const entries: ProxyEntry[] = [];
  for (const part of raw.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    try {
      const url = new URL(trimmed);
      const type = url.protocol.replace(':', '') as ProxyEntry['type'];
      if (!['http', 'https', 'socks4', 'socks5'].includes(type)) continue;
      entries.push({
        host: url.hostname,
        port: parseInt(url.port) || (type === 'https' ? 443 : 80),
        type,
        username: url.username || undefined,
        password: url.password || undefined,
      });
    } catch {
      console.log(`[Pool] Skipping invalid proxy: ${trimmed}`);
    }
  }
  return entries;
}

// Fallback hardcoded proxies (free, likely burned)
const FALLBACK_PROXIES: ProxyEntry[] = [
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
  const auth = p.username ? `${p.username}:***@` : '';
  return `${p.type}://${auth}${p.host}:${p.port}`;
}

function loadProxies() {
  const envList = process.env.PROXY_LIST;
  const proxies = envList ? parseProxyList(envList) : FALLBACK_PROXIES;
  const source = envList ? 'PROXY_LIST env' : 'fallback (hardcoded)';

  proxyPool.clear();
  for (const p of proxies) {
    const label = makeLabel(p);
    proxyPool.set(label, {
      entry: p, label, score: 0, cooldownUntil: 0,
      totalSuccess: 0, totalFail: 0,
    });
  }
  console.log(`[Pool] ${proxyPool.size} proxies loaded from ${source}`);
}

loadProxies();

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

function getHttpProxies(): ProxyState[] {
  return Array.from(proxyPool.values())
    .filter(p => p.entry.type === 'http' || p.entry.type === 'https')
    .filter(p => p.score < DEAD_THRESHOLD);
}

// ── FlareSolverr ────────────────────────────────────────────
interface CachedSession {
  cookies: string;
  userAgent: string;
  proxy: ProxyEntry;
  obtainedAt: number;
}

let cachedSession: CachedSession | null = null;
const SESSION_TTL = 10 * 60 * 1000;
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

function buildProxyUrl(entry: ProxyEntry): string {
  const auth = entry.username ? `${entry.username}:${entry.password || ''}@` : '';
  return `${entry.type}://${auth}${entry.host}:${entry.port}`;
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

    for (const proxyState of httpProxies) {
      const { entry } = proxyState;
      const proxyUrl = buildProxyUrl(entry);
      const proxyLabel = makeLabel(entry);

      console.log(`[FlareSolverr] Solving via ${proxyLabel}...`);

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
          console.log(`  ! FlareSolverr failed: ${data.message || 'unknown'}`);
          continue;
        }

        const responseHtml = data.solution?.response || '';
        if (responseHtml.includes('you have been blocked') || responseHtml.includes('block_headline')) {
          console.log(`  ! Proxy blocked by Cloudflare`);
          proxyState.score += 30;
          continue;
        }

        const cookies = (data.solution?.cookies || [])
          .map((c: any) => `${c.name}=${c.value}`)
          .join('; ');

        if (!cookies.includes('cf_clearance')) {
          console.log(`  ! No cf_clearance cookie`);
          continue;
        }

        const session: CachedSession = {
          cookies,
          userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:147.0) Gecko/20100101 Firefox/147.0",
          proxy: entry,
          obtainedAt: Date.now(),
        };

        cachedSession = session;
        console.log(`[FlareSolverr] OK via ${proxyLabel} — got cf_clearance`);
        return session;
      } catch (err: any) {
        console.log(`  X FlareSolverr error: ${err.message}`);
        continue;
      }
    }

    console.log(`[FlareSolverr] All proxies failed`);
    return null;
  })();

  try { return await solvingInProgress; }
  finally { solvingInProgress = null; }
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
    const socksUrl = buildProxyUrl(proxy);
    const agent = new SocksProxyAgent(socksUrl);
    const res = await undiciRequest(targetUrl, {
      method: 'GET', headers, dispatcher: agent as any,
    });
    status = res.statusCode;
    contentType = res.headers['content-type'] as string | null;
    body = res.body;
  } else {
    const proxyUrl = buildProxyUrl(proxy);
    const dispatcher = new ProxyAgent(proxyUrl);
    const res = await proxyFetch(targetUrl, {
      method: 'GET', headers, dispatcher, redirect: 'follow',
    });
    status = res.status;
    contentType = res.headers.get('content-type');
    body = res.body;
  }

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
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:147.0) Gecko/20100101 Firefox/147.0',
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
  if (session) {
    session.userAgent =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:147.0) Gecko/20100101 Firefox/147.0";
  }

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

// ── Reload proxies endpoint ─────────────────────────────────
app.post('/__reload', (c) => {
  loadProxies();
  return c.json({ ok: true, total: proxyPool.size });
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

  // ── Step 1: cached FlareSolverr cookies + its proxy ───────
  const session = getSession();
  if (session) {
    const headers = {
      ...baseHeaders,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:147.0) Gecko/20100101 Firefox/147.0',
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

        const body = result.text ?? result.body;
        return new Response(body as any, { status: result.status, headers: respHeaders });
      }

      console.log(`  ! Session expired — clearing cache`);
      cachedSession = null;
    } catch (err: any) {
      console.log(`  X Cached error: ${err.message}`);
      cachedSession = null;
    }
  }

  // ── Step 2: proxy pool directly ───────────────────────────
  const maxAttempts = Math.min(proxyPool.size, 8);
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

      if (isCloudflareBlock(result.text)) {
        console.log(`  ! Cloudflare challenge/block via ${label}`);
        state.score += 5;
        lastError = `cloudflare via ${label}`;
        needsChallengeSolve = true;
        continue;
      }

      if (result.status === 503) {
        state.totalFail++;
        state.score += 10;
        state.cooldownUntil = Date.now() + COOLDOWN_MS;
        lastError = `503 via ${label}`;
        await sleep(backoffMs);
        backoffMs = Math.min(backoffMs * 1.5, 10_000);
        continue;
      }

      state.totalSuccess++;
      state.score = Math.max(0, state.score - 1);
      console.log(`  OK ${result.status} via ${label}`);

      const respHeaders = new Headers();
      if (result.contentType) respHeaders.set('Content-Type', result.contentType);
      respHeaders.set('X-Proxy-Used', label);

      return new Response(result.body as any, { status: result.status, headers: respHeaders });
    } catch (err: any) {
      state.totalFail++;
      state.score += 20;
      state.cooldownUntil = Date.now() + ERROR_COOLDOWN_MS;
      console.log(`  X ${label}: ${err.message}`);
      lastError = `${label}: ${err.message}`;
      await sleep(1000);
      continue;
    }
  }

  // ── Step 3: FlareSolverr + proxy ──────────────────────────
  // if (needsChallengeSolve) {
  //   console.log(`[FlareSolverr] Solving challenge...`);
  //   const newSession = await solveChallenge(target);

  //   if (newSession) {
  //     const headers = {
  //       ...baseHeaders,
  //       'User-Agent': newSession.userAgent,
  //       Cookie: newSession.cookies,
  //     };

  //     try {
  //       const result = await fetchViaProxy(targetUrl, newSession.proxy, headers);

  //       if (!isCloudflareBlock(result.text) && result.status < 500) {
  //         console.log(`  OK ${result.status} (flaresolverr)`);
  //         const respHeaders = new Headers();
  //         if (result.contentType) respHeaders.set('Content-Type', result.contentType);
  //         respHeaders.set('X-Proxy-Mode', 'flaresolverr');

  //         const body = result.text ?? result.body;
  //         return new Response(body as any, { status: result.status, headers: respHeaders });
  //       }
  //       lastError = 'flaresolverr: still blocked';
  //     } catch (err: any) {
  //       lastError = `flaresolverr: ${err.message}`;
  //     }
  //   } else {
  //     lastError = 'flaresolverr: could not solve';
  //   }
  // }

  return c.json({ error: 'All attempts failed', last: lastError }, 502);
});

export default app;
