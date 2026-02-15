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
  proven: boolean;      // passed warmup test
  avgMs: number;        // real latency from warmup
  score: number;        // penalty score
  cooldownUntil: number;
  totalSuccess: number;
  totalFail: number;
  lastTestedAt: number; // last warmup test timestamp
}

const MAX_LATENCY_MS = 1200;       // preferred latency for proxy selection
const WARMUP_ACCEPT_MS = 12_000;   // accept proxies up to 12s in warmup (HTTPS proxy handshake overhead)
const WARMUP_TIMEOUT_MS = 20_000;  // give proxies time for HTTPS handshake + CF
const REQUEST_TIMEOUT_MS = 15_000;
const COOLDOWN_MS = 30_000;
const ERROR_COOLDOWN_MS = 60_000;
const DEAD_THRESHOLD = 50;
const RETEST_INTERVAL_MS = 3 * 60_000; // re-test proven proxies every 3 min
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
        entry: p, label, proven: false, avgMs: 0, score: 0,
        cooldownUntil: 0, totalSuccess: 0, totalFail: 0, lastTestedAt: 0,
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

// ── Load proxies from local files ────────────────────────────
import { readFileSync } from 'fs';
import { join, dirname } from 'path';

function loadProxiesFromFiles(): ProxyEntry[] {
  const entries: ProxyEntry[] = [];
  const srcDir = join(dirname(Bun.main), '.');

  // Load iphttps.txt — format: ip:port (all http type)
  try {
    const txt = readFileSync(join(srcDir, 'iphttps.txt'), 'utf-8');
    for (const line of txt.split('\n')) {
      const match = line.trim().match(/^(\d+\.\d+\.\d+\.\d+):(\d+)$/);
      if (match) {
        entries.push({ type: 'http', host: match[1], port: parseInt(match[2]) });
      }
    }
    console.log(`[Load] iphttps.txt: ${entries.length} proxies`);
  } catch (e: any) {
    console.log(`[Load] iphttps.txt not found: ${e.message}`);
  }

  // Load ips_proxy_list.csv — format: ip,...,port,protocols,...
  const beforeCsv = entries.length;
  try {
    const csv = readFileSync(join(srcDir, 'ips_proxy_list.csv'), 'utf-8');
    const lines = csv.split('\n');
    for (let i = 1; i < lines.length; i++) { // skip header
      const cols = lines[i].split(',').map(c => c.replace(/"/g, '').trim());
      if (cols.length < 9) continue;
      const ip = cols[0];
      const port = cols[7];
      const proto = cols[8] as ProxyEntry['type'];
      if (!ip || !port || !['http', 'https', 'socks4', 'socks5'].includes(proto)) continue;
      entries.push({ type: proto, host: ip, port: parseInt(port) });
    }
    console.log(`[Load] ips_proxy_list.csv: ${entries.length - beforeCsv} proxies`);
  } catch (e: any) {
    console.log(`[Load] ips_proxy_list.csv not found: ${e.message}`);
  }

  return entries;
}

// ── Warmup: test proxies in background ──────────────────────
const WARMUP_TARGET = 'https://m440.in/lasted';

function isCloudflareBlock(text?: string): boolean {
  if (!text) return false;
  return text.includes('you have been blocked') ||
    text.includes('block_headline') ||
    text.includes('security verification') ||
    text.includes('cf-challenge') ||
    text.includes('challenge-platform') ||
    text.includes('Just a moment');
}

async function testProxy(state: ProxyState, verbose = false): Promise<boolean> {
  const proxyUrl = buildProxyUrl(state.entry);
  const start = Date.now();
  try {
    const impit = new Impit({ browser: 'chrome', proxyUrl, timeout: WARMUP_TIMEOUT_MS });
    const res = await impit.fetch(WARMUP_TARGET, {
      headers: { 'Accept': 'application/json, text/plain, */*' },
      redirect: 'follow',
    });

    const latencyMs = Date.now() - start;
    state.lastTestedAt = Date.now();

    // Read body once
    const body = await res.text();

    if ((res.status === 403 || res.status === 503) && isCloudflareBlock(body)) {
      if (verbose) console.log(`  [test] ${state.label}: cloudflare (${latencyMs}ms)`);
      state.score += 10;
      if (state.score >= 20) state.proven = false;
      return false;
    }

    if (res.status !== 200) {
      if (verbose) console.log(`  [test] ${state.label}: status ${res.status} (${latencyMs}ms)`);
      state.score += 5;
      if (state.score >= 20) state.proven = false;
      return false;
    }

    if (!body.startsWith('{"data"')) {
      if (verbose) console.log(`  [test] ${state.label}: invalid body (${latencyMs}ms)`);
      state.score += 5;
      if (state.score >= 20) state.proven = false;
      return false;
    }

    // Check latency — accept up to WARMUP_ACCEPT_MS (cold start overhead)
    if (latencyMs > WARMUP_ACCEPT_MS) {
      if (verbose) console.log(`  [test] ${state.label}: too slow ${latencyMs}ms > ${WARMUP_ACCEPT_MS}ms`);
      state.score += 3;
      return false;
    }

    state.proven = true;
    state.avgMs = state.avgMs === 0 ? latencyMs : Math.round(state.avgMs * 0.7 + latencyMs * 0.3);
    state.score = Math.max(0, state.score - 2);
    return true;
  } catch (err: any) {
    const latencyMs = Date.now() - start;
    if (verbose) console.log(`  [test] ${state.label}: ${err.message.split('\n')[0]} (${latencyMs}ms)`);
    state.lastTestedAt = Date.now();
    state.score += 20;
    state.cooldownUntil = Date.now() + ERROR_COOLDOWN_MS;
    return false;
  }
}

let warmupRunning = false;

async function warmupLoop() {
  while (true) {
    warmupRunning = true;
    const now = Date.now();
    const all = Array.from(proxyPool.values());

    // 1. Re-test proven proxies that haven't been tested recently (parallel)
    const staleProven = all.filter(p => p.proven && now - p.lastTestedAt > RETEST_INTERVAL_MS);
    if (staleProven.length > 0) {
      const results = await Promise.allSettled(staleProven.map(p => testProxy(p)));
      results.forEach((r, i) => {
        if (r.status === 'fulfilled' && !r.value) {
          console.log(`[Warmup] ${staleProven[i].label} lost proven status`);
        }
      });
    }

    // 2. Test untested proxies in parallel batches of 20
    const untested = all.filter(p =>
      !p.proven && p.score < DEAD_THRESHOLD && p.cooldownUntil <= now && p.lastTestedAt === 0
    ).slice(0, 60);

    let newProven = 0;
    for (let i = 0; i < untested.length; i += 20) {
      const chunk = untested.slice(i, i + 20);
      const results = await Promise.allSettled(chunk.map(p => testProxy(p, true)));
      for (let j = 0; j < results.length; j++) {
        const r = results[j];
        if (r.status === 'fulfilled' && r.value) {
          newProven++;
          console.log(`[Warmup] + ${chunk[j].label} (${chunk[j].avgMs}ms)`);
        }
      }
    }

    const provenCount = all.filter(p => p.proven).length;
    if (newProven > 0 || untested.length > 0) {
      console.log(`[Warmup] Tested ${untested.length}, +${newProven} proven. Total proven: ${provenCount}/${proxyPool.size}`);
    }

    // 3. Purge dead
    const dead: string[] = [];
    for (const [label, state] of proxyPool) {
      if (state.score >= DEAD_THRESHOLD) dead.push(label);
    }
    for (const label of dead) proxyPool.delete(label);
    if (dead.length > 0) console.log(`[Pool] Purged ${dead.length} dead`);

    warmupRunning = false;
    // Wait before next batch (short if we still have untested proxies)
    const hasUntested = Array.from(proxyPool.values()).some(p => !p.proven && p.score < DEAD_THRESHOLD && p.lastTestedAt === 0);
    await sleep(hasUntested ? 2_000 : 30_000);
  }
}

// ── Initialize ──────────────────────────────────────────────
function initPool() {
  const envList = process.env.PROXY_LIST;
  if (envList) {
    const proxies = parseProxyList(envList);
    addToPool(proxies);
    console.log(`[Pool] ${proxyPool.size} proxies from PROXY_LIST env`);
  }
  const fileProxies = loadProxiesFromFiles();
  addToPool(fileProxies);
  console.log(`[Pool] ${proxyPool.size} total proxies loaded — server ready`);
}

initPool();
warmupLoop().catch(() => {});

// ── Proxy selection ──────────────────────────────────────────
let roundRobinIndex = 0;
let fallbackIndex = 0;

function getNextProxy(): ProxyState | null {
  const now = Date.now();
  const proven = Array.from(proxyPool.values()).filter(
    p => p.proven && p.cooldownUntil <= now && p.score < DEAD_THRESHOLD
  );

  if (proven.length > 0) {
    proven.sort((a, b) => a.avgMs - b.avgMs);
    const topTier = proven.slice(0, Math.max(3, Math.ceil(proven.length * 0.3)));
    const pick = topTier[roundRobinIndex % topTier.length];
    roundRobinIndex++;
    return pick;
  }

  // Fallback: pick untested or low-score proxies when no proven available
  const fallback = Array.from(proxyPool.values()).filter(
    p => !p.proven && p.cooldownUntil <= now && p.score < DEAD_THRESHOLD
  );
  if (fallback.length === 0) return null;

  // Prefer untested first, then lowest score
  fallback.sort((a, b) => {
    if (a.lastTestedAt === 0 && b.lastTestedAt !== 0) return -1;
    if (a.lastTestedAt !== 0 && b.lastTestedAt === 0) return 1;
    return a.score - b.score;
  });

  const pick = fallback[fallbackIndex % Math.min(fallback.length, 20)];
  fallbackIndex++;
  return pick;
}

// ── Fetch via impit ─────────────────────────────────────────
async function fetchViaImpit(
  targetUrl: string,
  proxy: ProxyEntry,
  headers: Record<string, string>,
): Promise<{ status: number; contentType: string | null; body: ArrayBuffer; text?: string; latencyMs: number }> {
  const proxyUrl = buildProxyUrl(proxy);
  const start = Date.now();

  const impit = new Impit({ browser: 'chrome', proxyUrl, timeout: REQUEST_TIMEOUT_MS });
  const res = await impit.fetch(targetUrl, { headers, redirect: 'follow' });

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

// ── Browser headers ─────────────────────────────────────────
const BROWSER_HEADERS: Record<string, string> = {
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'es-419,es;q=0.9,en;q=0.8',
  DNT: '1',
  'Upgrade-Insecure-Requests': '1',
};

// ── Stats endpoint ──────────────────────────────────────────
app.get('/__stats', (c) => {
  const all = Array.from(proxyPool.values());
  const provenList = all
    .filter(p => p.proven)
    .sort((a, b) => a.avgMs - b.avgMs)
    .map(p => ({ proxy: p.label, avgMs: p.avgMs, success: p.totalSuccess, fail: p.totalFail }));

  return c.json({
    total: proxyPool.size,
    proven: provenList.length,
    dead: all.filter(p => p.score >= DEAD_THRESHOLD).length,
    untested: all.filter(p => p.lastTestedAt === 0 && p.score < DEAD_THRESHOLD).length,
    maxLatency: `${MAX_LATENCY_MS}ms`,
    warmupRunning,
    provenProxies: provenList,
  });
});

// ── Reload endpoint ─────────────────────────────────────────
app.post('/__reload', (c) => {
  // Reset scores and re-test all
  for (const [, state] of proxyPool) {
    state.score = 0;
    state.cooldownUntil = 0;
    state.lastTestedAt = 0;
    state.proven = false;
  }
  return c.json({ ok: true, total: proxyPool.size });
});

// ── Main route — ONLY proven proxies ────────────────────────
app.all('*', async (c) => {
  const target = c.env?.TARGET_ORIGIN || process.env.TARGET_ORIGIN || 'https://m440.in';
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

  const provenCount = Array.from(proxyPool.values()).filter(p => p.proven).length;
  const available = provenCount > 0 ? provenCount : Array.from(proxyPool.values()).filter(p => p.score < DEAD_THRESHOLD && p.cooldownUntil <= Date.now()).length;
  const maxAttempts = Math.min(Math.max(available, 3), 5);

  let lastError = '';

  for (let i = 0; i < maxAttempts; i++) {
    const state = getNextProxy();
    if (!state) break;

    const { entry, label } = state;

    try {
      console.log(`[${i + 1}/${maxAttempts}] ${c.req.method} ${url.pathname} -> ${label} (${state.avgMs}ms)`);
      const result = await fetchViaImpit(targetUrl, entry, headers);

      if (isCloudflareBlock(result.text)) {
        console.log(`  ! Cloudflare via ${label}`);
        state.proven = false; // lost trust
        state.score += 10;
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

      // Success — update latency
      state.totalSuccess++;
      state.score = Math.max(0, state.score - 1);
      state.avgMs = Math.round(state.avgMs * 0.7 + result.latencyMs * 0.3);

      console.log(`  OK ${result.status} via ${label} (${result.latencyMs}ms)`);

      const respHeaders = new Headers();
      if (result.contentType) respHeaders.set('Content-Type', result.contentType);
      respHeaders.set('X-Proxy-Used', label);
      respHeaders.set('X-Proxy-Latency', `${result.latencyMs}ms`);

      return new Response(result.body, { status: result.status, headers: respHeaders });
    } catch (err: any) {
      state.totalFail++;
      state.proven = false; // lost trust
      state.score += 20;
      state.cooldownUntil = Date.now() + ERROR_COOLDOWN_MS;
      console.log(`  X ${label}: ${err.message.split('\n')[0]}`);
      lastError = `${label}: ${err.message.split('\n')[0]}`;
      continue;
    }
  }

  return c.json({ error: 'All attempts failed', last: lastError, provenAvailable: provenCount }, 502);
});

export default app;
