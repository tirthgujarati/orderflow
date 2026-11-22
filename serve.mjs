// Local web server + always-on recorder for the order-flow app (no dependencies).
//   node serve.mjs [port=8090] [--record binance:XAUUSDT,binance:XAGUSDT]
// Laptop: http://localhost:8090      Phone on the same Wi-Fi: the http://192.168.x.x:8090 address printed below
// While this runs, the recorder keeps the order book and trades of the recorded markets (and of any market the app opens),
// so the heatmap and footprint have history for the time the phone or browser was closed. Keep the laptop awake.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SPOT_OK, swissquoteUrl, parseSwissquote, DUKA_PATH } from './feeds.js';
import { existsSync, statSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { MARKETS } from './core.js';
import { createRecorder } from './recorder.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2), ri = args.indexOf('--record');
const PORT = +(args.find(a => /^\d+$/.test(a)) || process.env.PORT || 8090);
const RECORD = ri >= 0 ? args[ri + 1].split(',') : ['binance:XAUUSDT', 'binance:XAGUSDT'];
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.css': 'text/css' };
const ALLOWED = new Set(['index.html', 'app.js', 'engine.js', 'core.js', 'feeds.js', 'lzma.js', 'sw.js', 'manifest.json', 'icon.svg', 'mockup.html', 'mockup-laptop.png', 'mockup-phone.png']);

const rec = createRecorder(join(ROOT, 'data', 'rec'));
for (const k of RECORD) if (MARKETS[k]) rec.start(k);

// /spot?i=XAU/USD -> {bid, ask, ts}: live spot quote from Swissquote, fetched here because its server does not let web pages
// read it directly. Only the instruments in SPOT_OK are allowed, at most one upstream request per instrument per 500 ms.
const spotCache = new Map();
async function spot(inst) {
  const c = spotCache.get(inst); if (c && Date.now() - c.at < 500) return c.q;
  const q = parseSwissquote(await (await fetch(swissquoteUrl(inst), { signal: AbortSignal.timeout(4000) })).json());
  spotCache.set(inst, { at: Date.now(), q }); return q;
}
// /duka?p=XAUUSD/2026/10/20/BID_candles_min_1.bi5 -> Dukascopy spot history file (fetched here: Dukascopy does not let web
// pages read it). Cached in data/duka; finished days are kept, today is refreshed after 10 minutes. One request at a time,
// 1.5 s apart, with retries: Dukascopy blocks clients that ask too fast.
const sleep = ms => new Promise(r => setTimeout(r, ms));
let dukaChain = Promise.resolve();
function duka(p) {
  const file = join(ROOT, 'data', 'duka', p.replace(/\//g, '_')), m = /(\d{4})\/(\d{2})\/(\d{2})/.exec(p);
  const done = Date.UTC(+m[1], +m[2], +m[3]) + 864e5 + 3 * 3600e3 < Date.now();
  if (existsSync(file) && (done || Date.now() - statSync(file).mtimeMs < 600000)) return Promise.resolve(readFileSync(file));
  const run = async () => {
    for (let i = 0; i < 5; i++) {
      const r = await fetch('https://datafeed.dukascopy.com/datafeed/' + p, { headers: { 'user-agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(20000) }).catch(() => null);
      if (r && r.ok) { const b = Buffer.from(await r.arrayBuffer()); mkdirSync(join(ROOT, 'data', 'duka'), { recursive: true }); writeFileSync(file, b); return b; }
      if (r && r.status === 404) return null;
      await sleep(10000 * 2 ** i);
    }
    if (existsSync(file)) return readFileSync(file);
    throw new Error('Dukascopy not reachable');
  };
  const job = dukaChain.then(run); dukaChain = job.catch(() => {}).then(() => sleep(3000)); return job;
}
const send = (res, code, body, type = 'application/json') => { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' }); res.end(body); };

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x'), q = url.searchParams;
  if (url.pathname === '/spot') {
    const inst = q.get('i');
    if (!SPOT_OK.has(inst)) return send(res, 400, 'unknown instrument', 'text/plain');
    try { return send(res, 200, JSON.stringify(await spot(inst))); } catch (e) { return send(res, 502, JSON.stringify({ error: e.message })); }
  }
  if (url.pathname === '/debug/snap' && req.method === 'POST') {   // save a panel picture for checking; this computer only
    const ra = req.socket.remoteAddress || ''; if (!/^(::1|127\.0\.0\.1|::ffff:127\.0\.0\.1)$/.test(ra)) return send(res, 403, 'local only', 'text/plain');
    const name = (q.get('name') || 'snap').replace(/[^a-z0-9-]/gi, ''), chunks = [];
    for await (const c of req) chunks.push(c);
    const { mkdirSync, writeFileSync } = await import('node:fs'); mkdirSync(join(ROOT, 'data'), { recursive: true });
    writeFileSync(join(ROOT, 'data', `snap-${name}.png`), Buffer.concat(chunks)); return send(res, 200, 'saved', 'text/plain');
  }
  if (url.pathname === '/duka') {
    const p = q.get('p'); if (!p || !DUKA_PATH.test(p)) return send(res, 400, 'bad path', 'text/plain');
    try { const b = await duka(p); return b ? send(res, 200, b, 'application/octet-stream') : send(res, 404, 'none', 'text/plain'); }
    catch (e) { return send(res, 502, e.message, 'text/plain'); }
  }
  if (url.pathname.startsWith('/rec/')) {
    const key = q.get('key');
    if (url.pathname === '/rec/info') return send(res, 200, JSON.stringify(rec.info()));
    if (!MARKETS[key]) return send(res, 400, 'unknown market', 'text/plain');
    if (!rec.has(key)) { rec.start(key); return send(res, 404, 'not recorded yet: recording starts now', 'text/plain'); }   // record what the app looks at
    if (url.pathname === '/rec/heat') { const b = rec.heat(key, +q.get('from') || 0, +q.get('to') || Date.now(), +q.get('n') || 1000); return b ? send(res, 200, b, 'application/octet-stream') : send(res, 404, 'none', 'text/plain'); }
    if (url.pathname === '/rec/trades') { const b = rec.trades(key, +q.get('from') || 0, +q.get('to') || 0); return b ? send(res, 200, b, 'application/octet-stream') : send(res, 404, 'none', 'text/plain'); }
    return send(res, 404, 'not found', 'text/plain');
  }
  let p = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
  p = normalize(p).replace(/\\/g, '/');
  if (!ALLOWED.has(p)) return send(res, 404, 'not found', 'text/plain');
  try { res.writeHead(200, { 'content-type': TYPES[extname(p)] || 'application/octet-stream', 'cache-control': 'no-cache' }); res.end(await readFile(join(ROOT, p))); }
  catch { send(res, 404, 'not found', 'text/plain'); }
}).listen(PORT, '0.0.0.0', () => {
  console.log(`Order Flow running:  http://localhost:${PORT}   (recording ${RECORD.join(', ')})`);
  for (const list of Object.values(networkInterfaces())) for (const a of list || []) if (a.family === 'IPv4' && !a.internal) console.log(`  phone (same Wi-Fi): http://${a.address}:${PORT}`);
});
