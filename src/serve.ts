import app from './index';

const port = parseInt(process.env.PORT || '3118');


Bun.serve({
  port,
  fetch: app.fetch,
  idleTimeout: 120, // seconds — proxies can be slow
});

console.log(`m440-proxy running on http://localhost:${port}`);
