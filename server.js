'use strict';
// YouTube ad-filtering reverse proxy (zero dependencies, Node 18+)
// client -> this server -> youtube.com ; ads are pruned from API JSON + ad URLs are blocked.
const http = require('http');
const https = require('https');
const zlib = require('zlib');

const PORT = process.env.PORT || 8080;
// phone/tablet browsers get m.youtube.com, desktop/TV get www.youtube.com (same as real YouTube does)
function baseHost(req) {
  return /Mobi|Android|iPhone|iPad/i.test(req.headers['user-agent'] || '') ? 'm.youtube.com' : 'www.youtube.com';
}
const ALLOW = /^(?:[a-z0-9-]+\.)*(?:youtube\.com|googlevideo\.com|googleapis\.com|google\.com)$/i;
const COOKIE_OK = /(?:^|\.)(?:youtube\.com|google\.com|googleapis\.com)$/i;
const agent = new https.Agent({ keepAlive: true, maxSockets: 256 });

// ---- ad data to remove (keys) and ad "renderer" items to drop from lists ----
const AD_KEYS = ['adPlacements', 'playerAds', 'adSlots', 'adBreakHeartbeatParams', 'adBreakParams'];
const AD_RENDERERS = [
  'adSlotRenderer', 'promotedSparklesWebRenderer', 'promotedSparklesTextSearchRenderer',
  'compactPromotedVideoRenderer', 'searchPyvRenderer', 'displayAdRenderer', 'bannerPromoRenderer',
  'statementBannerRenderer', 'brandVideoSingleRenderer', 'brandVideoShelfRenderer',
  'inFeedAdLayoutRenderer', 'adLayoutRenderer', 'actionCompanionAdRenderer',
  'playerLegacyDesktopWatchAdsRenderer', 'videoMastheadAdV3Renderer'
];
const KEYSET = new Set(AD_KEYS);
const ADRSET = new Set(AD_RENDERERS);

function hasAd(o, d) {
  if (!o || typeof o !== 'object' || d > 2) return false;
  for (const k in o) {
    if (ADRSET.has(k)) return true;
    if (hasAd(o[k], d + 1)) return true;
  }
  return false;
}
function prune(o) {
  if (!o || typeof o !== 'object') return;
  if (Array.isArray(o)) {
    for (let i = o.length - 1; i >= 0; i--) {
      if (hasAd(o[i], 0)) o.splice(i, 1); else prune(o[i]);
    }
    return;
  }
  for (const k of Object.keys(o)) {
    if (KEYSET.has(k)) { delete o[k]; continue; }
    prune(o[k]);
  }
}

// ---- rewrite absolute URLs to point back at this proxy ----
const HOST_RE = /(https?:)?((?:\\?\/){2})((?:[a-z0-9-]+\.)*(?:youtube\.com|googlevideo\.com|googleapis\.com|google\.com))(?![a-z0-9.-])/gi;
function rewriteText(text, ME) {
  return text.replace(HOST_RE, (m, proto, sl, host) => {
    const h = host.toLowerCase();
    const S = sl.indexOf('\\') >= 0 ? '\\/' : '/';
    const base = (proto || '') + S + S + ME;
    if (h === 'www.youtube.com' || h === 'youtube.com' || h === 'm.youtube.com') return base;
    return base + S + '__p' + S + h;
  });
}

// ---- script injected into every HTML page ----
const CLIENT = String.raw`(function(){
var KEYS=${JSON.stringify(AD_KEYS)}.reduce(function(a,k){a[k]=1;return a},{});
var ADR=${JSON.stringify(AD_RENDERERS)}.reduce(function(a,k){a[k]=1;return a},{});
function hasAd(o,d){if(!o||typeof o!=='object'||d>2)return false;for(var k in o){if(ADR[k])return true;if(hasAd(o[k],d+1))return true}return false}
function prune(o){if(!o||typeof o!=='object')return;if(Array.isArray(o)){for(var i=o.length-1;i>=0;i--){if(hasAd(o[i],0))o.splice(i,1);else prune(o[i])}return}for(var k in o){if(KEYS[k]){delete o[k];continue}prune(o[k])}}
var HOSTRE=/^https?:\/\/((?:[a-z0-9-]+\.)*(?:youtube\.com|googlevideo\.com|googleapis\.com|google\.com))(?=[\/?#:]|$)/i;
var ADB=/^https?:\/\/[^\/]*(doubleclick\.net|googlesyndication\.com|googleadservices\.com|adservice\.google\.|pagead2\.)/i;
function fix(u){try{
 if(typeof u!=='string')return u;
 if(u.slice(0,2)==='//')u='https:'+u;
 if(ADB.test(u))return location.origin+'/__blocked';
 var m=u.match(HOSTRE);if(!m)return u;
 var h=m[1].toLowerCase(),rest=u.slice(m[0].length);
 if(h==='www.youtube.com'||h==='youtube.com'||h==='m.youtube.com')return location.origin+rest;
 return location.origin+'/__p/'+h+rest;
}catch(e){return u}}
var of=window.fetch;
window.fetch=function(i,o){
 if(typeof i==='string')i=fix(i);
 else if(typeof URL!=='undefined'&&i instanceof URL)i=fix(i.href);
 else if(typeof Request!=='undefined'&&i instanceof Request){var nu=fix(i.url);if(nu!==i.url){try{i=new Request(nu,i)}catch(e){}}}
 return of.call(this,i,o)};
var oo=XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open=function(m,u){arguments[1]=fix(String(u));return oo.apply(this,arguments)};
if(navigator.sendBeacon){var ob=navigator.sendBeacon.bind(navigator);navigator.sendBeacon=function(u,d){return ob(fix(String(u)),d)}}
function trap(n){var v;try{Object.defineProperty(window,n,{configurable:true,get:function(){return v},set:function(x){try{prune(x)}catch(e){}v=x}})}catch(e){}}
trap('ytInitialPlayerResponse');trap('ytInitialData');
var op=JSON.parse;
JSON.parse=function(){var r=op.apply(this,arguments);try{if(r&&typeof r==='object'&&(r.adPlacements||r.playerAds||r.adSlots))prune(r)}catch(e){}return r};
var _go=0;
function ping(m){try{(new Image()).src='/__hi?m='+encodeURIComponent(m)}catch(e){}}
function navOK(){try{var t=Date.now(),a=JSON.parse(sessionStorage.getItem('__nav')||'[]').filter(function(x){return t-x<4000});a.push(t);sessionStorage.setItem('__nav',JSON.stringify(a));return a.length<4}catch(e){return true}}
function K(){try{var p=new URLSearchParams(location.search);return location.pathname+'|'+(p.get('v')||'')+'|'+(p.get('search_query')||'')}catch(e){return location.pathname}}
var _k=K();
function go(u,why){_go=1;ping(why+' '+u);setTimeout(function(){_go=0},2000);location.assign(u)}
ping('start '+location.pathname+location.search.slice(0,40));
// 1) link clicks: do a normal page load instead of YouTube's in-page navigation (which stays blank behind the proxy)
window.addEventListener('click',function(e){try{
 if(e.button||e.metaKey||e.ctrlKey||e.shiftKey||e.altKey)return;
 var path=e.composedPath?e.composedPath():[e.target],a=null;
 for(var i=0;i<path.length;i++){var el=path[i];if(el&&el.tagName==='A'&&el.href){a=el;break}}
 if(!a||(a.target&&a.target!=='_self')||a.hasAttribute('download'))return;
 var n=new URL(a.href,location.href);
 if(n.origin!==location.origin||(n.pathname+n.search)===(location.pathname+location.search))return;
 e.preventDefault();e.stopImmediatePropagation();go(n.href,'click');
}catch(x){}},true);
// 1b) search form: same thing (YouTube cancels the submit and then does its own request, which can fail)
window.addEventListener('submit',function(e){try{
 var f=e.target;if(!f||f.tagName!=='FORM'||String(f.getAttribute('method')||'get').toLowerCase()!=='get')return;
 var n=new URL(f.getAttribute('action')||location.href,location.href);
 if(n.origin!==location.origin||n.pathname!=='/results')return;
 var p=new URLSearchParams();new FormData(f).forEach(function(v,k){if(typeof v==='string')p.append(k,v)});
 n.search=p.toString();
 if((n.pathname+n.search)===(location.pathname+location.search))return;
 e.preventDefault();e.stopImmediatePropagation();go(n.href,'submit');
}catch(x){}},true);
// 2) pushState (search box, buttons ...): same thing
var _ps=history.pushState;
history.pushState=function(st,ti,u){
 try{if(u){u=fix(String(u));arguments[2]=u;var n=new URL(u,location.href);
  if(n.origin===location.origin&&(n.pathname+n.search)!==(location.pathname+location.search)&&navOK()){go(n.href,'push');return}}}catch(e){}
 return _ps.apply(this,arguments)};
var _rs=history.replaceState;
history.replaceState=function(st,ti,u){try{if(u)arguments[2]=fix(String(u))}catch(e){}return _rs.apply(this,arguments)};
// 3) safety net, any other way YouTube changes the page address (page, video id or search text): reload = same as manual refresh
setInterval(function(){if(_go)return;var k=K();if(k!==_k){_k=k;if(navOK()){_go=1;ping('reload '+location.pathname);location.reload()}}},250);
})();`;

const DROP_RES = new Set([
  'content-security-policy', 'content-security-policy-report-only', 'x-frame-options',
  'strict-transport-security', 'cross-origin-opener-policy', 'cross-origin-embedder-policy',
  'cross-origin-resource-policy', 'report-to', 'nel', 'alt-svc', 'connection', 'keep-alive',
  'transfer-encoding', 'upgrade'
]);
const DROP_REQ = new Set([
  'host', 'connection', 'accept-encoding', 'x-real-ip', 'forwarded', 'via', 'cf-connecting-ip',
  'cdn-loop', 'x-request-id', 'content-length'
]);
const KEEP_RES = new Set(['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control', 'expires',
  'last-modified', 'etag', 'location', 'set-cookie', 'content-disposition', 'content-language', 'content-encoding', 'vary', 'age',
  'retry-after', 'x-content-type-options', 'access-control-allow-origin', 'access-control-allow-credentials',
  'access-control-allow-headers', 'access-control-allow-methods', 'access-control-expose-headers']);
const TEXTUAL = /^(?:text\/(?:html|css|xml|javascript)|application\/(?:javascript|x-javascript|ecmascript|json))/i;

const cache = new Map(); // small cache for static /s/ files (player js, css)
function cacheSet(k, v) {
  if (cache.size >= 60) cache.delete(cache.keys().next().value);
  cache.set(k, v);
}

function buildHeaders(req, host, ME, bodyLen) {
  const h = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (DROP_REQ.has(k) || k.startsWith('sec-fetch-') || k.startsWith('cf-') || k === 'true-client-ip' || k.startsWith('x-forwarded') || k.startsWith('x-envoy')) continue;
    h[k] = v;
  }
  h.host = host;
  h['accept-encoding'] = 'identity';
  if (bodyLen !== undefined) h['content-length'] = String(bodyLen);
  else if (req.headers['content-length']) h['content-length'] = req.headers['content-length'];
  const base = baseHost(req);
  if (h.origin) h.origin = 'https://' + base;
  if (h.referer) {
    let r = h.referer;
    if (r.includes('://' + ME + '/__p/')) r = r.replace('://' + ME + '/__p/', '://');
    else r = r.replace('://' + ME, '://' + base);
    h.referer = r;
  }
  if (COOKIE_OK.test(host)) {
    let c = h.cookie || '';
    if (!/(?:^|;\s*)SOCS=/.test(c)) c += (c ? '; ' : '') + 'SOCS=CAI'; // skip consent page
    h.cookie = c;
  } else {
    delete h.cookie;
  }
  return h;
}

function handleResponse(pr, req, res, host, ME, path) {
  const ct = String(pr.headers['content-type'] || '');
  if (!path.startsWith('/videoplayback')) note('RES', pr.statusCode, host + path.slice(0, pr.statusCode >= 400 ? 170 : 50), ct.slice(0, 28), 'hdrBytes=' + JSON.stringify(pr.headers).length + '->' + Object.entries(pr.headers).filter(([k, v]) => KEEP_RES.has(k)).reduce((a, [k, v]) => a + k.length + JSON.stringify(v).length, 0) + (pr.headers.location ? ' LOC=' + String(pr.headers.location).slice(0, 90) : ''));
  const out = {};
  for (const [k, v] of Object.entries(pr.headers)) if (KEEP_RES.has(k) && JSON.stringify(v).length < 4200) out[k] = v;
  if (out.location) out.location = rewriteText(String(out.location), ME);
  if (out['set-cookie']) out['set-cookie'] = [].concat(out['set-cookie']).map(c => c.replace(/;\s*domain=[^;]*/i, ''));
  if (out['access-control-allow-origin']) {
    out['access-control-allow-origin'] = 'https://' + ME;
    out['access-control-allow-credentials'] = 'true';
  }

  const noBody = req.method === 'HEAD' || pr.statusCode === 204 || pr.statusCode === 304;
  if (noBody || !TEXTUAL.test(ct)) {
    res.writeHead(pr.statusCode, out);
    pr.pipe(res);
    return;
  }

  const chunks = [];
  pr.on('data', c => chunks.push(c));
  pr.on('end', () => { try {
    let text = Buffer.concat(chunks).toString('utf8');
    const isJson = /json/i.test(ct);
    if (isJson && /\/youtubei\/|\/api\//.test(path)) {
      try { const j = JSON.parse(text); prune(j); text = JSON.stringify(j); } catch (e) { /* leave as is */ }
    }
    text = rewriteText(text, ME);
    if (/text\/html/i.test(ct)) {
      const tag = '<script>' + CLIENT + '</script>';
      text = /<head[^>]*>/i.test(text) ? text.replace(/<head[^>]*>/i, m => m + tag) : tag + text;
    }
    let body = Buffer.from(text, 'utf8');
    out['content-length'] = body.length;
    delete out.etag;
    delete out['content-encoding'];
    if (pr.statusCode === 200 && path.startsWith('/s/')) cacheSet(ME + host + path, { status: 200, out: Object.assign({}, out), body });
    const rawLen = body.length;
    // gzip big text for the client (YouTube HTML is ~350KB; phone data is slow)
    if (body.length > 1024 && /\bgzip\b/i.test(String(req.headers['accept-encoding'] || ''))) {
      body = zlib.gzipSync(body, { level: 6 });
      out['content-encoding'] = 'gzip';
      out['content-length'] = body.length;
      out.vary = 'Accept-Encoding';
    }
    res.writeHead(pr.statusCode, out);
    res.end(body);
    note('SENT', pr.statusCode, 'body=' + rawLen, body.length !== rawLen ? 'gz=' + body.length : '');
  } catch (e) { note('[HANDLE ERROR]', e.message); if (!res.headersSent) { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('handle error: ' + e.message); } else res.destroy(); } });
  pr.on('error', e => { note('[UPSTREAM BODY ERROR]', e.message); res.destroy(); });
}


// ---- never crash, always log (blitz logs tab will show these) ----
const LOGS = [];
function note(...a) {
  const line = new Date().toISOString().slice(11, 23) + ' ' + a.join(' ');
  LOGS.push(line); if (LOGS.length > 120) LOGS.shift();
  console.log(line);
}
process.on('uncaughtException', e => note('[UNCAUGHT]', String(e && e.stack || e).replace(/\n/g, ' | ')));
process.on('unhandledRejection', e => note('[UNHANDLED]', String(e && e.stack || e).replace(/\n/g, ' | ')));

// ---- /__diag : open in browser, shows WHY upstream fails (always HTTP 200 so Cloudflare shows the text) ----
function probe(host) {
  return new Promise(resolve => {
    const t0 = Date.now();
    const r = https.request({ host, port: 443, method: 'GET', path: '/', timeout: 12000,
      headers: { host, 'user-agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36', 'accept-encoding': 'identity' } }, pr => {
      pr.resume();
      resolve({ host, ok: true, status: pr.statusCode, location: pr.headers.location || null, ms: Date.now() - t0 });
    });
    r.on('timeout', () => r.destroy(new Error('timeout 12s')));
    r.on('error', e => resolve({ host, ok: false, error: e.message, code: e.code, ms: Date.now() - t0 }));
    r.end();
  });
}

const server = http.createServer((req, res) => {
  const ME = req.headers.host;
  const url = req.url;
  if (!url.startsWith('/__') && !url.startsWith('/videoplayback')) note('REQ', req.method, url.slice(0, 70), '|', (req.headers['user-agent'] || '').slice(0, 45));

  if (url === '/__diag') {
    Promise.all([probe('www.youtube.com'), probe('m.youtube.com'), probe('googleapis.com')]).then(r => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ version: 'diag-9', recent_logs: LOGS.slice(-40), node: process.version, env_PORT: process.env.PORT || null, listening: LISTEN_PORTS, your_host_header: req.headers.host, probes: r }, null, 2));
    });
    return;
  }
  if (url.startsWith('/__try')) {
    const q = new URL(url, 'http://x').searchParams;
    const th = (q.get('h') || baseHost(req)).toLowerCase(), tp = q.get('p') || '/';
    if (!ALLOW.test(th)) { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('blocked host'); }
    const t0 = Date.now();
    const done = o => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o, null, 2)); };
    const r = https.request({ host: th, port: 443, method: 'GET', path: tp, agent, timeout: 20000, servername: th, headers: buildHeaders(req, th, ME) }, pr => {
      const ch = [];
      pr.on('data', c => ch.push(c));
      pr.on('error', e => done({ stage: 'upstream body error', error: e.message }));
      pr.on('end', () => {
        try {
          const raw = Buffer.concat(ch).toString('utf8');
          const hdrs = {}; let total = 0;
          for (const [k, v] of Object.entries(pr.headers)) { const l = JSON.stringify(v).length; total += k.length + l; hdrs[k] = l; }
          const kept = Object.keys(pr.headers).filter(k => KEEP_RES.has(k));
          done({ host: th, path: tp, status: pr.statusCode, ms: Date.now() - t0, content_type: pr.headers['content-type'] || null,
            content_encoding: pr.headers['content-encoding'] || null, upstream_header_bytes: total, header_value_sizes: hdrs,
            headers_we_would_send: kept, body_bytes: Buffer.byteLength(raw), rewritten_bytes: Buffer.byteLength(rewriteText(raw, ME)),
            sent_request_headers: Object.keys(buildHeaders(req, th, ME)), body_start: raw.slice(0, 150) });
        } catch (e) { done({ stage: 'processing error', error: e.stack }); }
      });
    });
    r.on('timeout', () => r.destroy(new Error('timeout 20s')));
    r.on('error', e => done({ stage: 'upstream request error', error: e.message, code: e.code }));
    r.end();
    return;
  }
  if (url.startsWith('/__hi')) { note('[CLIENT]', decodeURIComponent(url.slice(8)).slice(0, 120)); res.writeHead(204); return res.end(); }
  if (url === '/__blocked') { res.writeHead(204); return res.end(); }
  if (url === '/' && /uptime check/i.test(req.headers['user-agent'] || '')) {
    res.writeHead(200, { 'content-type': 'text/plain' });
    return res.end('ok');
  }
  if (/^\/(?:pagead\/|api\/stats\/ads|ptracking|get_midroll_info)/.test(url)) { res.writeHead(204); return res.end(); }
  if (url.startsWith('/sw.js')) { res.writeHead(404); return res.end(); }

  let host = baseHost(req), path = url;
  const m = url.match(/^\/__p\/([^\/?#]+)(.*)$/);
  if (m) {
    host = m[1].toLowerCase();
    path = m[2] || '/';
    if (path[0] !== '/') path = '/' + path;
  }
  if (!ALLOW.test(host)) { res.writeHead(403); return res.end('blocked host'); }

  const hit = req.method === 'GET' ? cache.get(ME + host + path) : null;
  if (hit) { res.writeHead(hit.status, hit.out); return res.end(hit.body); }

  let pqCur = null;
  res.on('close', () => { if (!res.writableEnded) note('[CLIENT CLOSED EARLY]', host + path.slice(0, 60)); if (pqCur) pqCur.destroy(); });
  const MAINH = /^(?:www\.|m\.)?youtube\.com$/i;
  // run(): upstream request; if YouTube just bounces between www<->m for the SAME path we follow it here
  // (otherwise the rewritten redirect points back at this proxy and loops forever in the browser)
  const run = (h, hop, bodyBuf) => {
    const headers = buildHeaders(req, h, ME, bodyBuf ? bodyBuf.length : undefined);
    const upPath = ME ? path.split(ME).join(baseHost(req)) : path;
    const pq = https.request({ host: h, port: 443, method: req.method, path: upPath, headers, agent, servername: h }, pr => {
      const sc = pr.statusCode, loc = pr.headers.location;
      if (hop < 4 && loc && sc >= 301 && sc <= 308 && !bodyBuf && (req.method === 'GET' || req.method === 'HEAD')) {
        let u = null; try { u = new URL(loc, 'https://' + h); } catch (e) { /* ignore */ }
        if (u && MAINH.test(u.hostname) && u.hostname.toLowerCase() !== h && u.pathname === path.split('?')[0]) {
          note('FLIP', h, '->', u.hostname.toLowerCase(), path.slice(0, 50));
          pr.resume();
          return run(u.hostname.toLowerCase(), hop + 1, bodyBuf);
        }
      }
      pq.setTimeout(0);
      handleResponse(pr, req, res, h, ME, path);
    });
    pqCur = pq;
    pq.setTimeout(30000, () => pq.destroy(new Error('upstream timeout 30s (no response)')));
    pq.on('error', e => {
      note('[UPSTREAM ERROR]', req.method, h + path.slice(0, 60), '->', e.code || '', e.message);
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
      res.end('proxy error: ' + e.message);
    });
    if (bodyBuf) pq.end(bodyBuf);
    else if (req.method === 'GET' || req.method === 'HEAD') pq.end();
    else req.pipe(pq);
  };
  const send = (bodyBuf) => run(host, 0, bodyBuf);

  const isJsonReq = /json/i.test(req.headers['content-type'] || '');
  if (req.method !== 'GET' && req.method !== 'HEAD' && isJsonReq) {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const s = Buffer.concat(chunks).toString('utf8').split(ME).join(baseHost(req));
      send(Buffer.from(s, 'utf8'));
    });
  } else {
    send(null);
  }
});

server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;
const LISTEN_PORTS = [...new Set([Number(PORT), 8080])];
server.on('error', e => console.error('[server error]', e.message));
// listen on the platform PORT and on 8080 (whichever blitz routes to will work)
LISTEN_PORTS.forEach((pt, i) => {
  const srv = i === 0 ? server : http.createServer(server.listeners('request')[0]);
  if (i) { srv.keepAliveTimeout = 65000; srv.headersTimeout = 66000; srv.on('error', e => console.error('[extra port ' + pt + ']', e.message)); }
  srv.listen(pt, () => console.log('ytproxy listening on ' + pt));
});
