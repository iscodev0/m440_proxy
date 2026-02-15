import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { Impit } from 'impit';

const app = new Hono();
app.use('*', cors());

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:147.0) Gecko/20100101 Firefox/147.0';
const TARGET = process.env.TARGET_ORIGIN || 'https://m440.in';

app.all('*', async (c) => {
  const url = new URL(c.req.url);
  const targetUrl = TARGET + url.pathname + url.search;
  const isJson =
    url.pathname.startsWith('/lasted') || url.pathname.startsWith('/api');

  const headers: Record<string, string> = {
    'User-Agent': UA,
    'Accept': isJson
      ? 'application/json, text/plain, */*'
      : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,es-VE;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br, zstd',
    'Sec-GPC': '1',
    'Connection': 'keep-alive',
    'Sec-Fetch-Dest': isJson ? 'empty' : 'document',
    'Sec-Fetch-Mode': isJson ? 'cors' : 'navigate',
    'Sec-Fetch-Site': isJson ? 'same-origin' : 'none',
    'Priority': 'u=0, i',
    'TE': 'trailers',
  };
  if (!isJson) headers['Upgrade-Insecure-Requests'] = '1';

  const start = Date.now();
  const impit = new Impit({ browser: 'firefox' });
  const res = await impit.fetch(targetUrl, {
    headers,
    redirect: 'follow',
  });

  const body = await res.arrayBuffer();
  const latencyMs = Date.now() - start;
  const contentType = res.headers.get('content-type');

  const respHeaders = new Headers();
  if (contentType) respHeaders.set('Content-Type', contentType);
  respHeaders.set('X-Response-Time', `${latencyMs}ms`);

  return new Response(body, { status: res.status, headers: respHeaders });
});

export default {
  port: parseInt(process.env.PORT || '3000'),
  fetch: app.fetch,
};
