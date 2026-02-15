import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { Impit } from 'impit';

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
  avgMs: number; // average latency
}

const MAX_LATENCY_MS = 1200;
const REQUEST_TIMEOUT_MS = 8_000;
const COOLDOWN_MS = 30_000;
const ERROR_COOLDOWN_MS = 60_000;
const DEAD_THRESHOLD = 50;
const REFRESH_INTERVAL_MS = 5 * 60_000;
const proxyPool = new Map<string, ProxyState>();

function makeLabel(p: ProxyEntry): string {
  const auth = p.username ? `${p.username}:***@` : '';
  return `${p.type}://${auth}${p.host}:${p.port}`;
}

function buildProxyUrl(entry: ProxyEntry): string {
  const auth = entry.username ? `${entry.username}:${entry.password || ''}@` : '';
  return `${entry.type}://${auth}${entry.host}:${entry.port}`;
}

function addToPool(proxies: ProxyEntry[]) {
  let added = 0;
  for (const p of proxies) {
    const label = makeLabel(p);
    if (!proxyPool.has(label)) {
      proxyPool.set(label, {
        entry: p, label, score: 0, cooldownUntil: 0,
        totalSuccess: 0, totalFail: 0, avgMs: 0,
      });
      added++;
    }
  }
  return added;
}

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

// ── Auto-fetch fresh proxies (max 1200ms timeout) ───────────
async function fetchFromProxyScrape(protocol: string): Promise<ProxyEntry[]> {
  try {
    const url = `https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&proxy_format=protocolipport&format=text&protocol=${protocol}&timeout=${MAX_LATENCY_MS}&anonymity=elite,anonymous`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return [];
    const text = await res.text();
    const entries: ProxyEntry[] = [];
    for (const line of text.split('\n')) {
      const match = line.trim().match(/^(https?|socks[45]):\/\/(\d+\.\d+\.\d+\.\d+):(\d+)$/);
      if (match) {
        entries.push({
          type: match[1] as ProxyEntry['type'],
          host: match[2],
          port: parseInt(match[3]),
        });
      }
    }
    return entries;
  } catch {
    return [];
  }
}

async function fetchFromProxyScrapeV2(protocol: string): Promise<ProxyEntry[]> {
  try {
    const url = `https://api.proxyscrape.com/v2/?request=displayproxies&protocol=${protocol}&timeout=${MAX_LATENCY_MS}&country=all&ssl=all&anonymity=all`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return [];
    const text = await res.text();
    const entries: ProxyEntry[] = [];
    for (const line of text.split('\n')) {
      const match = line.trim().match(/^(\d+\.\d+\.\d+\.\d+):(\d+)$/);
      if (match) {
        entries.push({
          type: protocol as ProxyEntry['type'],
          host: match[1],
          port: parseInt(match[2]),
        });
      }
    }
    return entries;
  } catch {
    return [];
  }
}

async function fetchFreshProxies(): Promise<ProxyEntry[]> {
  console.log('[Fetch] Fetching fresh proxies (max %dms)...', MAX_LATENCY_MS);
  const results = await Promise.allSettled([
    fetchFromProxyScrape('http'),
    fetchFromProxyScrape('socks4'),
    fetchFromProxyScrape('socks5'),
    fetchFromProxyScrapeV2('http'),
    fetchFromProxyScrapeV2('socks4'),
    fetchFromProxyScrapeV2('socks5'),
  ]);

  const all: ProxyEntry[] = [];
  for (const r of results) {
    if (r.status === 'fulfilled') all.push(...r.value);
  }

  const seen = new Set<string>();
  const unique: ProxyEntry[] = [];
  for (const p of all) {
    const key = `${p.host}:${p.port}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(p);
    }
  }

  console.log(`[Fetch] Got ${unique.length} unique proxies`);
  return unique;
}

// ── Initialize pool ─────────────────────────────────────────
async function initPool() {
  const envList = process.env.PROXY_LIST;
  if (envList) {
    const proxies = parseProxyList(envList);
    addToPool(proxies);
    console.log(`[Pool] ${proxyPool.size} proxies loaded from PROXY_LIST env`);
    return;
  }

  const fresh = await fetchFreshProxies();
  if (fresh.length > 0) addToPool(fresh);
  console.log(`[Pool] ${proxyPool.size} proxies ready`);
}

function purgeDead() {
  const dead: string[] = [];
  for (const [label, state] of proxyPool) {
    if (state.score >= DEAD_THRESHOLD) dead.push(label);
  }
  for (const label of dead) proxyPool.delete(label);
  if (dead.length > 0) console.log(`[Pool] Purged ${dead.length} dead proxies`);
}

async function refreshLoop() {
  while (true) {
    await sleep(REFRESH_INTERVAL_MS);
    purgeDead();
    const fresh = await fetchFreshProxies();
    const added = addToPool(fresh);
    console.log(`[Pool] Refresh: +${added} new, ${proxyPool.size} total`);
  }
}

await initPool();
refreshLoop().catch(() => {});

// ── Proxy selection (prioritize low latency) ────────────────
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

  // Sort by: proven fast first (has success + low avg), then untested, then slow
  available.sort((a, b) => {
    // Proxies with success are always preferred
    if (a.totalSuccess > 0 && b.totalSuccess === 0) return -1;
    if (b.totalSuccess > 0 && a.totalSuccess === 0) return 1;
    // Both have success: sort by avgMs
    if (a.totalSuccess > 0 && b.totalSuccess > 0) return a.avgMs - b.avgMs;
    // Both untested: sort by score
    return a.score - b.score;
  });

  const topTier = available.slice(0, Math.max(5, Math.ceil(available.length * 0.1)));
  const pick = topTier[roundRobinIndex % topTier.length];
  roundRobinIndex++;
  return pick;
}

// ── Fetch via impit (browser TLS fingerprint) ───────────────
async function fetchViaImpit(
  targetUrl: string,
  proxy: ProxyEntry,
  headers: Record<string, string>,
): Promise<{ status: number; contentType: string | null; body: ArrayBuffer; text?: string; latencyMs: number }> {
  const proxyUrl = buildProxyUrl(proxy);
  const start = Date.now();

  const impit = new Impit({
    browser: 'chrome',
    proxyUrl,
    timeout: REQUEST_TIMEOUT_MS,
  });

  const res = await impit.fetch(targetUrl, {
    headers,
    redirect: 'follow',
  });

  const status = res.status;
  const contentType = res.headers.get('content-type');
  const body = await res.arrayBuffer();
  const latencyMs = Date.now() - start;

  if ((status === 403 || status === 503) && contentType?.includes('text/html')) {
    const text = new TextDecoder().decode(body);
    return { status, contentType, body, text, latencyMs };
  }

  return { status, contentType, body, latencyMs };
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
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
  'Accept-Language': 'es-419,es;q=0.9,en;q=0.8',
  DNT: '1',
  'Upgrade-Insecure-Requests': '1',
};

// ── Stats endpoint ──────────────────────────────────────────
app.get('/__stats', (c) => {
  const all = Array.from(proxyPool.values())
    .sort((a, b) => {
      if (a.totalSuccess > 0 && b.totalSuccess === 0) return -1;
      if (b.totalSuccess > 0 && a.totalSuccess === 0) return 1;
      if (a.totalSuccess > 0 && b.totalSuccess > 0) return a.avgMs - b.avgMs;
      return a.score - b.score;
    })
    .map(p => ({
      proxy: p.label,
      score: p.score,
      avgMs: p.avgMs || null,
      success: p.totalSuccess,
      fail: p.totalFail,
      cooldown: p.cooldownUntil > Date.now()
        ? `${Math.ceil((p.cooldownUntil - Date.now()) / 1000)}s`
        : null,
      dead: p.score >= DEAD_THRESHOLD,
    }));

  return c.json({
    total: proxyPool.size,
    engine: 'impit (Chrome TLS fingerprint)',
    maxLatency: `${MAX_LATENCY_MS}ms`,
    available: all.filter(p => !p.cooldown && !p.dead).length,
    proven: all.filter(p => p.success > 0 && !p.dead).length,
    onCooldown: all.filter(p => p.cooldown).length,
    dead: all.filter(p => p.dead).length,
    top10: all.slice(0, 10),
  });
});

// ── Reload proxies endpoint ─────────────────────────────────
app.post('/__reload', async (c) => {
  purgeDead();
  const fresh = await fetchFreshProxies();
  const added = addToPool(fresh);
  return c.json({ ok: true, added, total: proxyPool.size });
});

// ── Main route — ONLY through proxies ───────────────────────
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

  const maxAttempts = Math.min(proxyPool.size, 10);
  let lastError = '';

  for (let i = 0; i < maxAttempts; i++) {
    const state = getNextProxy();
    if (!state) break;

    const { entry, label } = state;

    try {
      console.log(`[${i + 1}/${maxAttempts}] ${c.req.method} ${url.pathname} -> ${label} (score:${state.score}, avg:${state.avgMs}ms)`);
      const result = await fetchViaImpit(targetUrl, entry, headers);

      if (isCloudflareBlock(result.text)) {
        console.log(`  ! Cloudflare via ${label} (${result.latencyMs}ms)`);
        state.score += 5;
        lastError = `cloudflare via ${label}`;
        continue;
      }

      if (result.status === 503) {
        state.totalFail++;
        state.score += 10;
        state.cooldownUntil = Date.now() + COOLDOWN_MS;
        lastError = `503 via ${label}`;
        continue;
      }

      // Update latency tracking (exponential moving average)
      state.totalSuccess++;
      state.score = Math.max(0, state.score - 1);
      state.avgMs = state.avgMs === 0
        ? result.latencyMs
        : Math.round(state.avgMs * 0.7 + result.latencyMs * 0.3);

      // Penalize slow proxies (over MAX_LATENCY_MS) so faster ones get picked next
      if (result.latencyMs > MAX_LATENCY_MS) {
        state.score += 3;
      }

      console.log(`  OK ${result.status} via ${label} (${result.latencyMs}ms)`);

      const respHeaders = new Headers();
      if (result.contentType) respHeaders.set('Content-Type', result.contentType);
      respHeaders.set('X-Proxy-Used', label);
      respHeaders.set('X-Proxy-Latency', `${result.latencyMs}ms`);

      return new Response(result.body, {
        status: result.status,
        headers: respHeaders,
      });
    } catch (err: any) {
      state.totalFail++;
      state.score += 20;
      state.cooldownUntil = Date.now() + ERROR_COOLDOWN_MS;
      const shortErr = err.message.split('\n')[0];
      console.log(`  X ${label}: ${shortErr}`);
      lastError = `${label}: ${shortErr}`;
      continue;
    }
  }

  return c.json({ error: 'All attempts failed', last: lastError }, 502);
});

export default app;
