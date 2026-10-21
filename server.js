'use strict';
// YouTube ad-filtering reverse proxy (zero dependencies, Node 18+)
// client -> this server -> youtube.com ; ads are pruned from API JSON + ad URLs are blocked.
const http = require('http');
const https = require('https');

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
const TEXTUAL = /^(?:text\/(?:html|css|xml|javascript)|application\/(?:javascript|x-javascript|ecmascript|json))/i;

const cache = new Map(); // small cache for static /s/ files (player js, css)
function cacheSet(k, v) {
  if (cache.size >= 60) cache.delete(cache.keys().next().value);
  cache.set(k, v);
}

function buildHeaders(req, host, ME, bodyLen) {
  const h = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (DROP_REQ.has(k) || k.startsWith('sec-fetch-') || k.startsWith('x-forwarded') || k.startsWith('x-envoy')) continue;
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
  const out = {};
  for (const [k, v] of Object.entries(pr.headers)) if (!DROP_RES.has(k)) out[k] = v;
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
  pr.on('end', () => {
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
    const body = Buffer.from(text, 'utf8');
    out['content-length'] = body.length;
    delete out.etag;
    if (pr.statusCode === 200 && path.startsWith('/s/')) cacheSet(ME + host + path, { status: 200, out, body });
    res.writeHead(pr.statusCode, out);
    res.end(body);
  });
  pr.on('error', () => res.destroy());
}

const server = http.createServer((req, res) => {
  const ME = req.headers.host;
  const url = req.url;

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

  const send = (bodyBuf) => {
    const headers = buildHeaders(req, host, ME, bodyBuf ? bodyBuf.length : undefined);
    const pq = https.request({ host, port: 443, method: req.method, path, headers, agent, servername: host }, pr => handleResponse(pr, req, res, host, ME, path));
    pq.on('error', e => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
      res.end('proxy error: ' + e.message);
    });
    res.on('close', () => pq.destroy());
    if (bodyBuf) pq.end(bodyBuf);
    else if (req.method === 'GET' || req.method === 'HEAD') pq.end();
    else req.pipe(pq);
  };

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
server.listen(PORT, () => console.log('ytproxy listening on ' + PORT));
