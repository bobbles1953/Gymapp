// Minimal static file server for local development and tests (no dependencies).
// Usage: node scripts/serve.mjs [port]   (default 8080, or $PORT)
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png',
};
const BLOCKED = /^\/(node_modules|tests|scripts|\.git)(\/|$)/;

export function startServer(port = 0) {
  const server = createServer(async (req, res) => {
    try {
      let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (BLOCKED.test(path)) throw Object.assign(new Error('blocked'), { code: 'ENOENT' });
      if (path.endsWith('/')) path += 'index.html';
      const file = normalize(join(ROOT, path));
      if (!file.startsWith(ROOT)) throw Object.assign(new Error('outside root'), { code: 'ENOENT' });
      if (!(await stat(file)).isFile()) throw Object.assign(new Error('dir'), { code: 'ENOENT' });
      const body = await readFile(file);
      res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(body);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    }
  });
  return new Promise((r) => server.listen(port, '127.0.0.1', () => r(server)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.argv[2] || process.env.PORT || 8080);
  startServer(port).then((s) => console.log(`Gym Log at http://localhost:${s.address().port}/`));
}
