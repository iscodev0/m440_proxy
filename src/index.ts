import { Hono } from 'hono';
import { cors } from 'hono/cors';

type Bindings = { TARGET_ORIGIN: string };

const app = new Hono<{ Bindings: Bindings }>();
app.use('*', cors());

// ── Helpers ─────────────────────────────────────────────────
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ── Detect curl-impersonate ─────────────────────────────────
let curlBin: string | null = null;

async function detectCurl(): Promise<void> {
  const candidates = [
    'curl_chrome116',
    'curl_chrome110',
    'curl_chrome104',
    'curl-impersonate-chrome',
    'curl_chrome131',
    'curl_chrome120',
  ];
  for (const bin of candidates) {
    try {
      const proc = Bun.spawn([bin, '--version'], { stdout: 'pipe', stderr: 'pipe' });
      const code = await proc.exited;
      if (code === 0) {
        curlBin = bin;
        console.log(`[TLS] Found ${bin} — Chrome TLS fingerprint enabled`);
        return;
      }
    } catch {}
  }
  console.log(`[TLS] WARNING: curl-impersonate not found. Using undici (will be challenged by Cloudflare on Linux)`);
  console.log(`[TLS] Install: apt-get install -y curl-impersonate-chrome`);
  console.log(`[TLS] Or see: https://github.com/lwthiker/curl-impersonate`);
}

await detectCurl();

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

function buildProxyUrl(entry: ProxyEntry): string {
  const auth = entry.username ? `${entry.username}:${entry.password || ''}@` : '';
  return `${entry.type}://${auth}${entry.host}:${entry.port}`;
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

// ── Fetch via curl-impersonate (Chrome TLS fingerprint) ─────
const META_SEPARATOR = '\n__CURL_META__';

async function fetchViaCurl(
  targetUrl: string,
  proxy: ProxyEntry,
  headers: Record<string, string>,
): Promise<{ status: number; contentType: string | null; body: Uint8Array; text?: string }> {
  if (!curlBin) throw new Error('curl-impersonate not available');

  // curl-impersonate supports HTTP, HTTPS, SOCKS4, SOCKS5 proxies
  const proxyUrl = buildProxyUrl(proxy);

  const args: string[] = [
    '-sS',
    '-x', proxyUrl,
    '--max-time', '30',
    '--compressed',
    '-L',  // follow redirects
    '-w', `${META_SEPARATOR}%{http_code}|%{content_type}`,
  ];

  for (const [key, value] of Object.entries(headers)) {
    args.push('-H', `${key}: ${value}`);
  }

  args.push(targetUrl);

  const proc = Bun.spawn([curlBin, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [rawOutput, stderrText] = await Promise.all([
    new Response(proc.stdout).arrayBuffer(),
    new Response(proc.stderr).text(),
  ]);

  const exitCode = await proc.exited;
  if (exitCode !== 0 && exitCode !== 22) { // 22 = HTTP error (still valid)
    throw new Error(`curl exit ${exitCode}: ${stderrText.trim()}`);
  }

  const output = Buffer.from(rawOutput);
  const metaIdx = output.lastIndexOf(META_SEPARATOR);

  let body: Uint8Array;
  let status = 200;
  let contentType: string | null = null;

  if (metaIdx >= 0) {
    body = new Uint8Array(output.buffer, output.byteOffset, metaIdx);
    const meta = output.subarray(metaIdx + META_SEPARATOR.length).toString('utf-8');
    const pipeIdx = meta.indexOf('|');
    status = parseInt(meta.substring(0, pipeIdx)) || 200;
    contentType = meta.substring(pipeIdx + 1).trim() || null;
  } else {
    body = new Uint8Array(output);
  }

  // Check for Cloudflare on 403/503
  if ((status === 403 || status === 503) && contentType?.includes('text/html')) {
    const text = new TextDecoder().decode(body);
    return { status, contentType, body, text };
  }

  return { status, contentType, body };
}

// ── Fallback: fetch via undici (for Windows/local dev) ──────
async function fetchViaUndici(
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
    const agent = new SocksProxyAgent(buildProxyUrl(proxy));
    const res = await undiciRequest(targetUrl, {
      method: 'GET', headers, dispatcher: agent as any,
    });
    status = res.statusCode;
    contentType = res.headers['content-type'] as string | null;
    body = res.body;
  } else {
    const dispatcher = new ProxyAgent(buildProxyUrl(proxy));
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

// ── Unified fetch: curl-impersonate preferred, undici fallback
async function fetchViaProxy(
  targetUrl: string,
  proxy: ProxyEntry,
  headers: Record<string, string>,
): Promise<{ status: number; contentType: string | null; body: any; text?: string }> {
  if (curlBin) {
    const result = await fetchViaCurl(targetUrl, proxy, headers);
    return { status: result.status, contentType: result.contentType, body: result.body, text: result.text };
  }
  return fetchViaUndici(targetUrl, proxy, headers);
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
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36',
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
  'Accept-Language': 'es-419,es;q=0.9,en;q=0.8',
  'Accept-Encoding': 'gzip, deflate, br',
  DNT: '1',
  'Sec-CH-UA': '"Chromium";v="116", "Not)A;Brand";v="24", "Google Chrome";v="116"',
  'Sec-CH-UA-Mobile': '?0',
  'Sec-CH-UA-Platform': '"Windows"',
  'Upgrade-Insecure-Requests': '1',
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

  return c.json({
    total: proxyPool.size,
    curlImpersonate: curlBin || 'not found (using undici)',
    available: all.filter(p => !p.cooldown && !p.dead).length,
    onCooldown: all.filter(p => p.cooldown).length,
    dead: all.filter(p => p.dead).length,
    proxies: all,
  });
});

// ── Reload proxies endpoint ─────────────────────────────────
app.post('/__reload', (c) => {
  loadProxies();
  return c.json({ ok: true, total: proxyPool.size });
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

  const maxAttempts = Math.min(proxyPool.size, 8);
  let lastError = '';
  let backoffMs = 1500;

  for (let i = 0; i < maxAttempts; i++) {
    const state = getNextProxy();
    if (!state) break;

    const { entry, label } = state;

    try {
      console.log(`[${i + 1}/${maxAttempts}] ${c.req.method} ${url.pathname} -> ${label} (score:${state.score})`);
      const result = await fetchViaProxy(targetUrl, entry, headers);

      if (isCloudflareBlock(result.text)) {
        console.log(`  ! Cloudflare challenge via ${label}`);
        state.score += 5;
        lastError = `cloudflare via ${label}`;
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

      return new Response(result.body as any, {
        status: result.status,
        headers: respHeaders,
      });
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

  return c.json({ error: 'All attempts failed', last: lastError }, 502);
});

export default app;
