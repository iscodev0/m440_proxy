import { Hono } from 'hono';
import { cors } from 'hono/cors';

const app = new Hono();
app.use('*', cors());

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:147.0) Gecko/20100101 Firefox/147.0';
const TARGET_HOST = 'm440.in';
const TIMEOUT_MS = 15_000;

app.all('*', async (c) => {
  const url = new URL(c.req.url);
  const targetUrl = `https://${TARGET_HOST}${url.pathname}${url.search}`;
  const isJson =
    url.pathname.startsWith('/lasted') || url.pathname.startsWith('/api');

  const headers: Record<string, string> = {
    'User-Agent': UA,
    'Accept': isJson
      ? 'application/json, text/plain, */*'
      : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5',
    'Accept-Encoding': 'gzip, deflate, br, zstd',
    'Connection': 'keep-alive',
    'Sec-Fetch-Dest': isJson ? 'empty' : 'document',
    'Sec-Fetch-Mode': isJson ? 'cors' : 'navigate',
    'Sec-Fetch-Site': isJson ? 'same-origin' : 'none',
  };
  if (!isJson) headers['Upgrade-Insecure-Requests'] = '1';

  const start = Date.now();

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

    const res = await fetch(targetUrl, {
      method: c.req.method,
      headers,
      redirect: 'follow',
      signal: controller.signal,

    });

    clearTimeout(timeoutId);

    const body = await res.arrayBuffer();
    const latencyMs = Date.now() - start;
    const contentType = res.headers.get('content-type');

    console.log(`[OK] ${res.status} (${latencyMs}ms) ${url.pathname}`);

    const respHeaders = new Headers();
    if (contentType) respHeaders.set('Content-Type', contentType);
    respHeaders.set('X-Response-Time', `${latencyMs}ms`);

    return new Response(body, { status: res.status, headers: respHeaders });
  } catch (err: any) {
    const latencyMs = Date.now() - start;
    console.error(`[ERROR] (${latencyMs}ms) ${url.pathname}: ${err.message}`);
    return c.json({ error: 'Request failed', details: err.message }, 502);
  }
});

export default {
  port: parseInt(process.env.PORT || '3228'),
  fetch: app.fetch,
};
