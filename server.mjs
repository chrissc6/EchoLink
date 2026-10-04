import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(projectRoot, 'dist');
const port = Number(fs.readFileSync(path.join(projectRoot, 'server.port'), 'utf8').trim());
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('server.port must contain a valid TCP port.');
const types = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.mjs':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.json':'application/json', '.wasm':'application/wasm', '.onnx':'application/octet-stream', '.bin':'application/octet-stream', '.svg':'image/svg+xml' };
const server = http.createServer((req,res) => {
  res.setHeader('Cross-Origin-Opener-Policy','same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy','require-corp');
  res.setHeader('Cross-Origin-Resource-Policy','same-origin');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self' 'wasm-unsafe-eval' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; font-src 'self' data:; media-src 'self' blob:");
  const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const requested = path.resolve(root, `.${pathname}`);
  if (requested !== root && !requested.startsWith(root + path.sep)) { res.writeHead(403).end('Forbidden'); return; }
  let file = requested;
  if (pathname === '/' || !path.extname(file)) file = path.join(root,'index.html');
  fs.stat(file,(err,stat) => {
    if (err || !stat.isFile()) { res.writeHead(404).end('Not found. Run npm run build first.'); return; }
    const isHtml = path.extname(file) === '.html';
    res.writeHead(200,{'Content-Type':types[path.extname(file)] || 'application/octet-stream','Content-Length':stat.size,'Cache-Control':isHtml ? 'no-cache' : 'public, max-age=31536000, immutable'});
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
});
server.listen(port,'127.0.0.1',() => console.log(`EchoLink is ready at http://127.0.0.1:${port} — press Ctrl+C to stop.`));
