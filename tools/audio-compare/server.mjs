import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { basename, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const track = process.argv[2] ? resolve(process.argv[2]) : null;
if (track) await stat(track);
const mounts = {
  '/compare/': resolve(root, 'tools/audio-compare'),
  '/utils/': resolve(root, 'utils'),
  '/vendor/': resolve(root, 'public/vendor'),
  '/fonts/': resolve(root, 'public/fonts'),
  '/rubberband/': resolve(root, 'node_modules/rubberband-wasm/dist'),
};
const mime = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
};
const server = createServer(async (request, response) => {
  try {
    const path = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    if (path === '/') {
      response.writeHead(302, { Location: '/compare/' }).end();
      return;
    }
    if (path === '/track-info') {
      response
        .writeHead(200, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ name: track ? basename(track) : null }));
      return;
    }
    if (path === '/benchmark-results') {
      const body = await readFile(resolve(root, 'docs/data/realtime-benchmark.json'));
      response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(body);
      return;
    }
    let file;
    if (path === '/track' && track) file = track;
    else {
      const prefix = Object.keys(mounts).find((item) => path.startsWith(item));
      if (!prefix) {
        response.writeHead(404).end();
        return;
      }
      const directory = mounts[prefix];
      file = resolve(directory, path.slice(prefix.length) || 'index.html');
      if (!file.startsWith(directory + sep)) {
        response.writeHead(403).end();
        return;
      }
    }
    const body = await readFile(file);
    response
      .writeHead(200, {
        'Content-Type': mime[extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-store',
      })
      .end(body);
  } catch {
    response.writeHead(404).end('File unavailable');
  }
});
server.listen(Number(process.env.PORT || 4178), '127.0.0.1', () => {
  console.log(`Audio comparison: http://127.0.0.1:${server.address().port}/compare/`);
});
