import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { Impit } from 'impit';

const app = new Hono();
app.use('*', cors());

const PROXIES = [
  "195.225.48.97:55774:SOCKS4",
  "186.251.255.13:31337:SOCKS4",
  "36.91.117.59:5678:SOCKS4",
  "103.76.190.210:58275:SOCKS5",
  "118.174.228.102:8080:SOCKS4",
  "203.34.28.99:80:SOCKS4",
  "190.85.158.46:3629:SOCKS4",
  "115.74.159.117:1080:SOCKS4",
  "31.148.99.242:44044:SOCKS5",
  "85.198.108.224:15987:SOCKS4",
  "54.38.176.200:64716:SOCKS4",
  "178.62.144.31:652:SOCKS4",
  "98.6.220.90:8899:SOCKS4",
  "110.34.166.187:4153:SOCKS4",
  "173.212.209.216:9225:SOCKS4",
  "162.214.197.102:44916:SOCKS4",
  "93.115.144.237:5678:SOCKS4",
  "193.203.61.35:8443:SOCKS5",
  "5.252.177.252:21754:SOCKS5",
  "85.238.104.216:8088:SOCKS4",
  "171.235.179.167:44905:SOCKS4",
  "138.97.117.181:35010:SOCKS4",
  "74.208.47.168:41786:SOCKS4",
  "200.29.8.18:5678:SOCKS4",
  "175.100.87.209:5678:SOCKS4",
  "84.53.247.204:53281:SOCKS4",
  "185.182.194.135:32645:SOCKS4",
  "89.22.113.189:50563:SOCKS4",
  "5.78.83.123:8080:SOCKS4",
  "43.153.172.76:443:SOCKS5",
  "103.233.103.241:4153:SOCKS4",
  "188.245.189.170:57842:SOCKS4",
  "138.94.92.26:7497:SOCKS5",
  "43.159.29.119:20487:SOCKS4",
  "178.245.159.142:3128:SOCKS5",
  "103.14.27.67:10467:SOCKS4",
  "162.240.147.147:34552:SOCKS4",
  "45.3.36.116:9090:SOCKS4",
  "81.12.104.36:3629:SOCKS4",
  "171.249.152.75:5678:SOCKS4",
  "36.92.111.49:52471:SOCKS5",
  "77.103.240.3:8888:SOCKS4",
  "188.75.186.152:4145:SOCKS4",
  "43.131.242.2:15673:SOCKS5",
  "1.10.133.19:8080:SOCKS4",
  "94.236.153.96:4145:SOCKS4",
  "76.31.172.96:8080:SOCKS4",
  "119.82.242.60:4145:SOCKS4",
  "62.113.115.94:16072:SOCKS5",
  "51.15.201.113:15713:SOCKS5",
  "81.12.104.38:3629:SOCKS4",
  "180.127.35.6:8989:SOCKS4",
  "103.234.27.113:9990:SOCKS4",
  "43.153.52.178:443:SOCKS5",
  "64.92.125.145:59423:SOCKS4",
  "103.250.73.178:8444:SOCKS5",
  "221.200.220.159:1080:SOCKS5",
  "110.78.149.12:4145:SOCKS4",
  "115.69.214.51:5678:SOCKS4",
  "161.97.163.52:52125:SOCKS4",
  "119.18.152.30:8080:SOCKS4",
  "162.247.243.29:80:SOCKS4",
  "89.144.34.231:13800:SOCKS4",
  "157.230.24.95:12950:SOCKS4",
  "211.174.99.161:4153:SOCKS4",
  "69.163.160.197:1645:SOCKS4",
  "61.28.230.231:8080:SOCKS4",
  "157.185.170.32:26589:SOCKS5",
  "104.207.48.26:3128:SOCKS4",
  "178.221.41.10:3629:SOCKS4",
  "194.87.58.103:80:SOCKS4",
  "185.5.246.222:4153:SOCKS5",
  "116.212.142.146:5678:SOCKS4",
  "202.146.228.254:8088:SOCKS4",
  "138.201.130.184:8080:SOCKS5",
  "81.162.243.249:8080:SOCKS4",
  "36.94.110.17:1080:SOCKS4",
  "173.67.12.235:1664:SOCKS4",
  "203.24.109.230:80:SOCKS4",
  "14.69.80.246:8080:SOCKS4",
  "154.6.96.192:3128:SOCKS4",
  "95.67.146.66:7788:SOCKS4",
  "165.225.61.26:10089:SOCKS4",
  "80.191.46.59:1080:SOCKS4",
  "79.151.16.40:5678:SOCKS4",
  "190.61.43.58:8080:SOCKS4",
  "103.51.44.253:4145:SOCKS4",
  "51.68.39.62:58347:SOCKS5",
  "162.19.107.54:55824:SOCKS4",
  "119.46.2.244:4145:SOCKS4",
  "178.252.197.64:4153:SOCKS4",
  "178.45.93.176:7788:SOCKS5",
  "92.205.107.162:8064:SOCKS4",
  "103.210.35.98:4145:SOCKS4",
  "41.223.233.94:3629:SOCKS4",
  "110.78.147.107:4145:SOCKS4",
  "103.23.237.71:5678:SOCKS4",
  "147.45.43.142:32370:SOCKS5",
  "173.212.237.43:53292:SOCKS4",
  "186.194.234.18:4153:SOCKS4",
];

// Parsear "ip:port:TYPE" → "socks4://ip:port"
const proxyUrls = PROXIES.map((p) => {
  const [host, port, type] = p.split(':');
  return `${type.toLowerCase()}://${host}:${port}`;
});

let proxyIndex = 0;
function getNextProxy(): string {
  const url = proxyUrls[proxyIndex % proxyUrls.length];
  proxyIndex++;
  return url;
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:147.0) Gecko/20100101 Firefox/147.0';
const TARGET = process.env.TARGET_ORIGIN || 'https://m440.in';
const MAX_ATTEMPTS = 5;
const TIMEOUT_MS = 15_000;

function isBlocked(text: string): boolean {
  return (
    text.includes('you have been blocked') ||
    text.includes('Just a moment') ||
    text.includes('security verification') ||
    text.includes('challenge-platform') ||
    text.includes('cf-challenge')
  );
}

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
  let lastError = '';

  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const proxyUrl = getNextProxy();
    try {
      const impit = new Impit({ browser: 'firefox', proxyUrl, timeout: TIMEOUT_MS });
      const res = await impit.fetch(targetUrl, { headers, redirect: 'follow' });

      const body = await res.arrayBuffer();
      const text = new TextDecoder().decode(body);

      // Si Cloudflare bloqueó, intentar con otro proxy
      if ((res.status === 403 || res.status === 503) && isBlocked(text)) {
        console.log(`[${i + 1}/${MAX_ATTEMPTS}] blocked via ${proxyUrl}`);
        lastError = `blocked via ${proxyUrl}`;
        continue;
      }

      const latencyMs = Date.now() - start;
      const contentType = res.headers.get('content-type');
      console.log(`[OK] ${res.status} via ${proxyUrl} (${latencyMs}ms) ${url.pathname}`);

      const respHeaders = new Headers();
      if (contentType) respHeaders.set('Content-Type', contentType);
      respHeaders.set('X-Response-Time', `${latencyMs}ms`);
      respHeaders.set('X-Proxy-Used', proxyUrl);

      return new Response(body, { status: res.status, headers: respHeaders });
    } catch (err: any) {
      console.log(`[${i + 1}/${MAX_ATTEMPTS}] error ${proxyUrl}: ${err.message.split('\n')[0]}`);
      lastError = `${proxyUrl}: ${err.message.split('\n')[0]}`;
      continue;
    }
  }

  return c.json({ error: 'All proxy attempts failed', last: lastError }, 502);
});

export default {
  port: parseInt(process.env.PORT || '3000'),
  fetch: app.fetch,
};
