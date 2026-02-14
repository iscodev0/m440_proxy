import { Hono } from 'hono';
import { cors } from 'hono/cors';

type Bindings = { TARGET_ORIGIN: string };

const app = new Hono<{ Bindings: Bindings }>();
app.use('*', cors());

// ── Proxy types ─────────────────────────────────────────────
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
  isPrimary: boolean;
}

// ── Primary proxies (fallback if direct fails) ─────────────
const PRIMARY_PROXIES: ProxyEntry[] = [
  { host: '20.81.205.173', port: 80, type: 'http' },
  { host: '168.235.110.63', port: 3128, type: 'http' },
  { host: '190.153.237.6', port: 37453, type: 'http' },
  { host: '108.170.12.14', port: 80, type: 'http' },
  { host: '217.217.254.94', port: 8080, type: 'http' },
  { host: '115.190.91.223', port: 7897, type: 'https' },
  { host: '78.63.115.20', port: 8899, type: 'socks5' },
  { host: '185.194.217.97', port: 1080, type: 'socks5' },
  { host: '187.102.16.66', port: 51327, type: 'socks4' },
  { host: '132.226.163.224', port: 2053, type: 'socks4' },
  { host: '173.245.49.185', port: 80, type: 'http' },
  { host: '138.124.117.139', port: 31646, type: 'http' },
  { host: '37.9.171.155', port: 41075, type: 'socks4' },
  { host: '110.78.149.235', port: 4145, type: 'socks4' },
  { host: '116.99.238.62', port: 30025, type: 'socks4' },
];

// ── Pool management ─────────────────────────────────────────
const COOLDOWN_MS = 30_000;
const ERROR_COOLDOWN_MS = 60_000;
const DEAD_THRESHOLD = 50;

const proxyPool = new Map<string, ProxyState>();

function makeLabel(p: ProxyEntry): string {
  return `${p.type}://${p.host}:${p.port}`;
}

function addToPool(entry: ProxyEntry, isPrimary: boolean): boolean {
  const label = makeLabel(entry);
  if (proxyPool.has(label)) return false;
  proxyPool.set(label, {
    entry,
    label,
    score: isPrimary ? 0 : 5,
    cooldownUntil: 0,
    totalSuccess: 0,
    totalFail: 0,
    isPrimary,
  });
  return true;
}

for (const p of PRIMARY_PROXIES) {
  addToPool(p, true);
}
console.log(`[Pool] ${proxyPool.size} proxies loaded`);

// ── Smart proxy selection ───────────────────────────────────
let roundRobinIndex = 0;

function getNextProxy(): ProxyState | null {
  const now = Date.now();
  const all = Array.from(proxyPool.values());

  const available = all.filter(
    p => p.cooldownUntil <= now && p.score < DEAD_THRESHOLD
  );

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

function onProxySuccess(state: ProxyState): void {
  state.totalSuccess++;
  state.score = Math.max(0, state.score - 1);
}

function onProxy503(state: ProxyState): void {
  state.totalFail++;
  state.score += 10;
  state.cooldownUntil = Date.now() + COOLDOWN_MS;
}

function onProxyError(state: ProxyState): void {
  state.totalFail++;
  state.score += 20;
  state.cooldownUntil = Date.now() + ERROR_COOLDOWN_MS;
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

// ── Helpers ─────────────────────────────────────────────────
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ── Fetch via proxy (uses undici + socks-proxy-agent) ───────
async function fetchViaProxy(
  targetUrl: string,
  proxy: ProxyEntry,
  headers: Record<string, string>,
): Promise<{ status: number; contentType: string | null; body: any }> {
  const { ProxyAgent, fetch: proxyFetch } = await import('undici');
  const { request: undiciRequest } = await import('undici');

  const isSocks = proxy.type === 'socks4' || proxy.type === 'socks5';

  if (isSocks) {
    const { SocksProxyAgent } = await import('socks-proxy-agent');
    const agent = new SocksProxyAgent(
      `${proxy.type}://${proxy.host}:${proxy.port}`,
    );
    const res = await undiciRequest(targetUrl, {
      method: 'GET',
      headers,
      dispatcher: agent as any,
    });
    return {
      status: res.statusCode,
      contentType: res.headers['content-type'] as string | null,
      body: res.body,
    };
  }

  const proxyUrl = `http://${proxy.host}:${proxy.port}`;
  const dispatcher = new ProxyAgent(proxyUrl);

  const res = await proxyFetch(targetUrl, {
    method: 'GET',
    headers,
    dispatcher,
    redirect: 'follow',
  });

  return {
    status: res.status,
    contentType: res.headers.get('content-type'),
    body: res.body,
  };
}

// ── Direct fetch (no proxy, server's own IP) ────────────────
async function fetchDirect(
  targetUrl: string,
  headers: Record<string, string>,
): Promise<{ status: number; contentType: string | null; body: ReadableStream | null }> {
  const res = await fetch(targetUrl, {
    method: 'GET',
    headers,
    redirect: 'follow',
  });

  return {
    status: res.status,
    contentType: res.headers.get('content-type'),
    body: res.body,
  };
}

// ── Stats endpoint ──────────────────────────────────────────
app.get('/__stats', (c) => {
  const all = Array.from(proxyPool.values())
    .sort((a, b) => a.score - b.score)
    .map(p => ({
      proxy: p.label,
      score: p.score,
      success: p.totalSuccess,
      fail: p.totalFail,
      primary: p.isPrimary,
      cooldown: p.cooldownUntil > Date.now()
        ? `${Math.ceil((p.cooldownUntil - Date.now()) / 1000)}s`
        : null,
      dead: p.score >= DEAD_THRESHOLD,
    }));

  return c.json({
    total: proxyPool.size,
    available: all.filter(p => !p.cooldown && !p.dead).length,
    onCooldown: all.filter(p => p.cooldown).length,
    dead: all.filter(p => p.dead).length,
    proxies: all,
  });
});

// ── Main route ──────────────────────────────────────────────
app.all('*', async (c) => {
  const target =
    c.env?.TARGET_ORIGIN || process.env.TARGET_ORIGIN || 'https://m440.in';
  const url = new URL(c.req.url);
  const targetUrl = target + url.pathname + url.search;

  const headers: Record<string, string> = {
    ...BROWSER_HEADERS,
    Referer: target + '/',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
  };

  if (url.pathname.startsWith('/lasted') || url.pathname.startsWith('/api')) {
    headers['Accept'] = 'application/json, text/plain, */*';
    headers['Sec-Fetch-Dest'] = 'empty';
    headers['Sec-Fetch-Mode'] = 'cors';
    headers['X-Requested-With'] = 'XMLHttpRequest';
  }

  // ── Step 1: try direct fetch first (fastest, no proxy overhead) ──
  try {
    console.log(`[Direct] ${c.req.method} ${url.pathname}`);
    const directResult = await fetchDirect(targetUrl, headers);

    if (directResult.status !== 503 && directResult.status < 500) {
      console.log(`  OK ${directResult.status} (direct)`);
      const respHeaders = new Headers();
      if (directResult.contentType) respHeaders.set('Content-Type', directResult.contentType);
      respHeaders.set('X-Proxy-Mode', 'direct');

      return new Response(directResult.body as any, {
        status: directResult.status,
        headers: respHeaders,
      });
    }
    console.log(`  ! ${directResult.status} (direct) — falling back to proxies`);
  } catch (err: any) {
    console.log(`  X Direct failed: ${err.message} — falling back to proxies`);
  }

  // ── Step 2: fallback to proxy pool ──────────────────────────
  const maxAttempts = 8;
  let lastError = 'direct fetch failed';
  let backoffMs = 1500;

  for (let i = 0; i < maxAttempts; i++) {
    const state = getNextProxy();
    if (!state) {
      return c.json({ error: 'No proxies available', last: lastError }, 502);
    }

    const { entry, label } = state;

    try {
      console.log(`[${i + 1}/${maxAttempts}] ${c.req.method} ${url.pathname} -> ${label} (score:${state.score})`);

      const result = await fetchViaProxy(targetUrl, entry, headers);

      if (result.status === 503) {
        onProxy503(state);
        console.log(`  ! 503 ${label} [score:${state.score}] waiting ${backoffMs}ms`);
        lastError = `503 via ${label}`;
        await sleep(backoffMs);
        backoffMs = Math.min(backoffMs * 1.5, 10_000);
        continue;
      }

      onProxySuccess(state);
      console.log(`  OK ${result.status} via ${label} [score:${state.score}]`);

      const respHeaders = new Headers();
      if (result.contentType) respHeaders.set('Content-Type', result.contentType);
      respHeaders.set('X-Proxy-Used', label);

      return new Response(result.body as any, {
        status: result.status,
        headers: respHeaders,
      });
    } catch (err: any) {
      onProxyError(state);
      console.log(`  X ${label} [score:${state.score}]: ${err.message}`);
      lastError = `${label}: ${err.message}`;
      await sleep(1000);
      continue;
    }
  }

  return c.json({ error: 'All attempts failed', last: lastError }, 502);
});

export default app;
