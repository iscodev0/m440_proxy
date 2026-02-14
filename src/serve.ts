import app from './index';

const port = parseInt(process.env.PORT || '3110');


Bun.serve({
  port,
  fetch: app.fetch,
});

console.log(`m440-proxy running on http://localhost:${port}`);
