/**
 * InCloud Pro — Cloudflare Worker
 * ------------------------------------------------------------------
 * The Telegram bot token and chat ID live ONLY here (as Worker secrets).
 * The HTML app never sees them.
 *
 * Endpoints
 *   GET  /f/<file_id>[?dl=1&name=x.jpg]  stream a file from Telegram (CORS-enabled, Range supported)
 *   POST /send?field=photo|audio|video|document   upload (multipart)       — needs Firebase login
 *   POST /del?mid=<message_id>                    delete from Telegram     — needs Firebase login
 *   POST /share   {fids:[...]}                    create ONE short link    — needs login + KV binding "SHARES"
 *   GET  /share/<id>                              list of file ids for a short link (JSON)
 *   GET  /s/<id>  or  /s?auto=1#fid1,fid2,...     share page: downloads all photos as a ZIP
 *
 * Secrets (Settings → Variables and Secrets, type "Secret")
 *   BOT_TOKEN   Telegram bot token from @BotFather
 *   CHAT_ID     the chat that stores your files (the user who pressed Start on the bot)
 *
 * Plain variables (all optional)
 *   FIREBASE_PROJECT_ID  default: tournament-app-add70
 *   ALLOWED_ORIGINS      "*" (default) or comma list, e.g. "https://myapp.com,https://localhost,capacitor://localhost"
 *   ADMIN_UIDS           comma list of Firebase UIDs that may delete any file
 *   SHARE_TTL_DAYS       how long a short share link lives (default 30)
 *
 * Optional binding
 *   KV namespace bound as  SHARES  → short share links (/s/<id>) and no huge URLs
 */

const TG_API = 'https://api.telegram.org';
const DEFAULT_PROJECT_ID = 'tournament-app-add70';
const MAX_UPLOAD = 50 * 1024 * 1024;               // Telegram Bot API upload limit
const FID_RE = /^[A-Za-z0-9_-]{20,255}$/;          // Telegram file_id shape
const ID_RE = /^[A-Za-z0-9_-]{8,40}$/;
const SEND_METHODS = { photo: 'sendPhoto', audio: 'sendAudio', video: 'sendVideo', document: 'sendDocument' };

const MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', oga: 'audio/ogg',
  opus: 'audio/ogg', wav: 'audio/wav', flac: 'audio/flac', pdf: 'application/pdf', zip: 'application/zip',
};

const te = new TextEncoder();
const td = new TextDecoder();

/* ───────────────────────── entry ───────────────────────── */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    try {
      const p = url.pathname.replace(/\/+$/, '') || '/';
      const m = request.method;

      if (p === '/') return json({ ok: true, service: 'InCloud Pro worker' }, 200, cors);

      if (p === '/s' || p.startsWith('/s/')) {
        if (m !== 'GET' && m !== 'HEAD') return json({ ok: false, description: 'Method not allowed' }, 405, cors);
        return sharePage();
      }
      if (p.startsWith('/share/') && m === 'GET') return shareData(env, p.slice(7), cors);

      if (!env.BOT_TOKEN || !env.CHAT_ID) {
        return json({ ok: false, description: 'Server is not configured yet (BOT_TOKEN / CHAT_ID missing).' }, 500, cors);
      }

      if (p.startsWith('/f/') && (m === 'GET' || m === 'HEAD')) return fileProxy(request, env, url, p.slice(3), cors);
      if (p === '/send' && m === 'POST') return handleSend(request, env, url, cors);
      if (p === '/del' && m === 'POST') return handleDel(request, env, url, cors);
      if (p === '/share' && m === 'POST') return shareCreate(request, env, url, cors);

      return json({ ok: false, description: 'Not found' }, 404, cors);
    } catch (e) {
      console.error('worker error:', e && e.message);
      return json({ ok: false, description: 'Server error. Please try again.' }, 500, cors);
    }
  },
};

/* ───────────────────────── helpers ───────────────────────── */
function corsHeaders(request, env) {
  const origin = request.headers.get('Origin');
  const list = String(env.ALLOWED_ORIGINS || '*').split(',').map((s) => s.trim()).filter(Boolean);
  const h = {
    'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, Range',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Content-Type, Accept-Ranges',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
  if (list.includes('*')) h['Access-Control-Allow-Origin'] = '*';
  else if (origin && list.includes(origin)) h['Access-Control-Allow-Origin'] = origin;
  return h;
}

function json(data, status, cors) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...cors },
  });
}

const unauth = (cors) =>
  json({ ok: false, description: 'Please sign in again (your session expired).' }, 401, cors);

function pick(o, keys) {
  const out = {};
  for (const k of keys) if (o[k] !== undefined) out[k] = o[k];
  return out;
}

async function tgCall(env, method, payload) {
  const isForm = payload instanceof FormData;
  const res = await fetch(`${TG_API}/bot${env.BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: isForm ? undefined : { 'Content-Type': 'application/json' },
    body: isForm ? payload : JSON.stringify(payload),
  });
  try {
    return await res.json();
  } catch (e) {
    return { ok: false, description: 'Telegram returned an invalid response' };
  }
}

/* ───────────────────────── Firebase login check ───────────────────────── */
const JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
let jwks = { at: 0, keys: [] };
const keyCache = new Map();

async function getKey(kid, forceRefresh) {
  const now = Date.now();
  if (!forceRefresh && keyCache.has(kid)) return keyCache.get(kid);
  const stale = now - jwks.at > 3600e3;
  // refresh when stale, or when an unknown kid shows up (throttled to once a minute)
  if (stale || (forceRefresh && now - jwks.at > 60e3)) {
    const res = await fetch(JWKS_URL, { cf: { cacheTtl: 3600, cacheEverything: true } });
    if (res.ok) {
      jwks = { at: now, keys: (await res.json()).keys || [] };
      keyCache.clear();
    }
  }
  const jwk = jwks.keys.find((k) => k.kid === kid);
  if (!jwk) return null;
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  keyCache.set(kid, key);
  return key;
}

function b64uToBytes(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  s += '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function verifyFirebaseToken(token, env) {
  const projectId = env.FIREBASE_PROJECT_ID || DEFAULT_PROJECT_ID;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  let header, payload;
  try {
    header = JSON.parse(td.decode(b64uToBytes(parts[0])));
    payload = JSON.parse(td.decode(b64uToBytes(parts[1])));
  } catch (e) {
    return null;
  }
  if (header.alg !== 'RS256' || !header.kid) return null;
  const now = Math.floor(Date.now() / 1000);
  if (payload.aud !== projectId) return null;
  if (payload.iss !== 'https://securetoken.google.com/' + projectId) return null;
  if (!payload.sub || typeof payload.sub !== 'string') return null;
  if (!payload.exp || payload.exp <= now) return null;
  if (payload.iat && payload.iat > now + 300) return null;

  const key = (await getKey(header.kid, false)) || (await getKey(header.kid, true));
  if (!key) return null;
  const ok = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5', key, b64uToBytes(parts[2]), te.encode(parts[0] + '.' + parts[1])
  );
  return ok ? payload : null;
}

async function authUser(request, env) {
  const m = /^Bearer\s+(.+)$/i.exec(request.headers.get('Authorization') || '');
  if (!m) return null;
  const token = m[1].trim();
  const payload = await verifyFirebaseToken(token, env).catch(() => null);
  if (!payload) return null;
  return { uid: payload.user_id || payload.sub, token, payload };
}

const isAdmin = (env, uid) =>
  String(env.ADMIN_UIDS || '').split(',').map((s) => s.trim()).filter(Boolean).includes(uid);

/** Does this user own a g_photos / g_files document with this Telegram message id? (checked with the user's own token, so Firestore rules apply) */
async function ownsMessage(env, token, uid, mid) {
  const project = env.FIREBASE_PROJECT_ID || DEFAULT_PROJECT_ID;
  const endpoint = `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents:runQuery`;
  const ask = async (col) => {
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          structuredQuery: {
            from: [{ collectionId: col }],
            where: {
              compositeFilter: {
                op: 'AND',
                filters: [
                  { fieldFilter: { field: { fieldPath: 'mid' }, op: 'EQUAL', value: { integerValue: String(mid) } } },
                  { fieldFilter: { field: { fieldPath: 'uid' }, op: 'EQUAL', value: { stringValue: uid } } },
                ],
              },
            },
            limit: 1,
          },
        }),
      });
      const data = await res.json();
      return Array.isArray(data) && data.some((x) => x.document);
    } catch (e) {
      return false;
    }
  };
  const [a, b] = await Promise.all([ask('g_photos'), ask('g_files')]);
  return a || b;
}

/* ───────────────────────── GET /f/<file_id> ───────────────────────── */
const pathCache = new Map();

async function getTgPath(env, fid) {
  const hit = pathCache.get(fid);
  if (hit && hit.exp > Date.now()) return { ok: true, path: hit.path };
  const data = await tgCall(env, 'getFile', { file_id: fid });
  if (!data.ok || !data.result || !data.result.file_path) {
    const d = String(data.description || '');
    if (/too big/i.test(d)) return { ok: false, status: 413, description: 'This file is larger than 20 MB, which Telegram does not let bots download.' };
    if (/wrong file|invalid|not found/i.test(d)) return { ok: false, status: 404, description: 'File not found.' };
    return { ok: false, status: 502, description: 'Telegram could not provide this file right now.' };
  }
  if (pathCache.size > 800) pathCache.clear();
  pathCache.set(fid, { path: data.result.file_path, exp: Date.now() + 50 * 60 * 1000 });
  return { ok: true, path: data.result.file_path };
}

async function fileProxy(request, env, url, rawFid, cors) {
  let fid = '';
  try { fid = decodeURIComponent(rawFid); } catch (e) { /* ignore */ }
  if (!FID_RE.test(fid)) return json({ ok: false, description: 'Bad file id' }, 400, cors);

  const info = await getTgPath(env, fid);
  if (!info.ok) return json({ ok: false, description: info.description }, info.status, cors);

  const up = await fetch(`${TG_API}/file/bot${env.BOT_TOKEN}/${info.path}`, {
    headers: request.headers.get('Range') ? { Range: request.headers.get('Range') } : {},
  });
  if (!up.ok && up.status !== 206) {
    pathCache.delete(fid);
    return json({ ok: false, description: 'Could not download this file.' }, up.status === 404 ? 404 : 502, cors);
  }

  const ext = (info.path.split('.').pop() || '').toLowerCase();
  const h = new Headers(cors);
  h.set('Content-Type', MIME[ext] || 'application/octet-stream');   // never text/html → no script injection
  h.set('X-Content-Type-Options', 'nosniff');
  h.set('Content-Security-Policy', 'sandbox');
  h.set('Cache-Control', 'public, max-age=86400');
  h.set('Accept-Ranges', 'bytes');
  for (const k of ['Content-Length', 'Content-Range']) {
    const v = up.headers.get(k);
    if (v) h.set(k, v);
  }
  if (url.searchParams.get('dl') === '1') {
    const name = (url.searchParams.get('name') || 'file.' + ext).replace(/[\x00-\x1f"\\/]/g, '_').slice(0, 150);
    h.set('Content-Disposition', `attachment; filename="${name.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`);
  }
  return new Response(request.method === 'HEAD' ? null : up.body, { status: up.status, headers: h });
}

/* ───────────────────────── POST /send ───────────────────────── */
async function handleSend(request, env, url, cors) {
  const user = await authUser(request, env);
  if (!user) return unauth(cors);

  const field = url.searchParams.get('field') || 'document';
  const method = SEND_METHODS[field];
  if (!method) return json({ ok: false, description: 'Bad upload type' }, 400, cors);

  const len = Number(request.headers.get('Content-Length') || 0);
  if (len > MAX_UPLOAD + 1024 * 1024) return json({ ok: false, description: 'File is too large (max 50 MB).' }, 413, cors);

  let form;
  try { form = await request.formData(); } catch (e) {
    return json({ ok: false, description: 'Could not read the upload.' }, 400, cors);
  }
  const file = form.get(field);
  if (!file || typeof file === 'string') return json({ ok: false, description: 'No file received.' }, 400, cors);
  if (file.size > MAX_UPLOAD) return json({ ok: false, description: 'File is too large (max 50 MB).' }, 413, cors);

  // Build a fresh form: chat_id is set here, never taken from the browser.
  const fd = new FormData();
  fd.append('chat_id', String(env.CHAT_ID));
  fd.append(field, file, file.name || 'file');
  const caption = String(form.get('caption') || '').slice(0, 1000);
  if (caption) fd.append('caption', caption);

  const data = await tgCall(env, method, fd);
  if (!data.ok) {
    return json({ ok: false, description: String(data.description || 'Telegram rejected the upload') }, 502, cors);
  }

  // Return only what the app needs — no chat info, no bot info.
  const r = data.result || {};
  const slim = { message_id: r.message_id };
  if (Array.isArray(r.photo)) slim.photo = r.photo.map((x) => pick(x, ['file_id', 'file_size', 'width', 'height']));
  for (const k of ['document', 'audio', 'video', 'voice']) {
    if (r[k]) slim[k] = pick(r[k], ['file_id', 'file_name', 'file_size', 'mime_type', 'duration', 'width', 'height']);
  }
  return json({ ok: true, result: slim }, 200, cors);
}

/* ───────────────────────── POST /del ───────────────────────── */
async function handleDel(request, env, url, cors) {
  const user = await authUser(request, env);
  if (!user) return unauth(cors);

  const mid = Number(url.searchParams.get('mid'));
  if (!Number.isInteger(mid) || mid <= 0) return json({ ok: false, description: 'Bad message id' }, 400, cors);

  if (!isAdmin(env, user.uid) && !(await ownsMessage(env, user.token, user.uid, mid))) {
    return json({ ok: false, description: 'You can only delete your own files.' }, 403, cors);
  }

  const data = await tgCall(env, 'deleteMessage', { chat_id: env.CHAT_ID, message_id: mid });
  if (data.ok || /not found/i.test(String(data.description || ''))) return json({ ok: true }, 200, cors);
  return json({ ok: false, description: 'Could not delete from Telegram.' }, 502, cors);
}

/* ───────────────────────── short share links ───────────────────────── */
function randomId() {
  const b = crypto.getRandomValues(new Uint8Array(9));
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_');   // 12 chars, URL-safe
}

async function shareCreate(request, env, url, cors) {
  const user = await authUser(request, env);
  if (!user) return unauth(cors);
  if (!env.SHARES) return json({ ok: false, description: 'Short links are not enabled (bind a KV namespace named SHARES).' }, 501, cors);

  let body;
  try { body = await request.json(); } catch (e) { return json({ ok: false, description: 'Bad request' }, 400, cors); }
  const fids = Array.isArray(body && body.fids) ? [...new Set(body.fids.map(String))].filter((f) => FID_RE.test(f)) : [];
  if (!fids.length) return json({ ok: false, description: 'No photos selected.' }, 400, cors);
  if (fids.length > 500) return json({ ok: false, description: 'Too many photos for one link (max 500).' }, 400, cors);

  const days = Math.min(365, Math.max(1, Number(env.SHARE_TTL_DAYS) || 30));
  const id = randomId();
  await env.SHARES.put('s:' + id, JSON.stringify({ fids, uid: user.uid, t: Date.now() }), { expirationTtl: days * 86400 });
  return json({ ok: true, id, url: url.origin + '/s/' + id, expires_days: days }, 200, cors);
}

async function shareData(env, rawId, cors) {
  if (!env.SHARES || !ID_RE.test(rawId)) return json({ ok: false, description: 'This link has expired or does not exist.' }, 404, cors);
  const v = await env.SHARES.get('s:' + rawId);
  if (!v) return json({ ok: false, description: 'This link has expired or does not exist.' }, 404, cors);
  const d = JSON.parse(v);
  return json({ ok: true, fids: d.fids }, 200, cors);
}

/* ───────────────────────── share page (same origin → no CORS at all) ───────────────────────── */
function sharePage() {
  return new Response(SHARE_HTML, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'X-Robots-Tag': 'noindex',
      'Content-Security-Policy':
        "default-src 'self'; script-src 'unsafe-inline' https://cdnjs.cloudflare.com; style-src 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self'",
    },
  });
}

const SHARE_HTML = String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>InCloud photos</title>
<style>
:root{--bg:#0B0A09;--card:#16130F;--elev:#201B15;--line:rgba(255,255,255,.08);--p:#F97316;--p2:#FBBF24;--ok:#34D399;--bad:#F87171;--mut:#A8A29E}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:#FAFAF9;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;min-height:100vh}
.wrap{max-width:560px;margin:0 auto;padding:24px 16px 40px}
h1{font-size:22px;margin:0 0 4px}
#sub{color:var(--mut);font-size:14px;margin:0 0 16px}
.bar{height:10px;border-radius:99px;background:var(--elev);overflow:hidden}
.bar i{display:block;height:100%;width:0;background:linear-gradient(90deg,var(--p),var(--p2));transition:width .2s}
button{width:100%;margin-top:16px;border:0;border-radius:14px;padding:14px;font-size:15px;font-weight:700;color:#1a0e02;background:linear-gradient(135deg,var(--p),var(--p2));cursor:pointer}
button:disabled{opacity:.5;cursor:default}
#msg{font-size:13px;margin:12px 0 0;color:var(--ok);word-break:break-word}#msg.bad{color:var(--bad)}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-top:20px}
.grid img{width:100%;aspect-ratio:1;object-fit:cover;border-radius:10px;background:var(--elev)}
</style></head><body><div class="wrap">
<h1>InCloud photos</h1>
<p id="sub">Loading…</p>
<div class="bar"><i id="fill"></i></div>
<button id="go" disabled>Download ZIP</button>
<p id="msg"></p>
<div class="grid" id="grid"></div>
</div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js"></script>
<script>
(function(){
var FID=/^[A-Za-z0-9_-]{20,255}$/, MAXPART=120*1024*1024, CONC=3;
var EXT={'image/jpeg':'jpg','image/png':'png','image/webp':'webp','image/gif':'gif'};
var $=function(i){return document.getElementById(i)};
var fids=[],busy=false;
function say(t,bad){var m=$('msg');m.textContent=t||'';m.className=bad?'bad':''}
function prog(p,t){$('fill').style.width=Math.min(100,p)+'%';if(t)$('sub').textContent=t}
function sleep(ms){return new Promise(function(r){setTimeout(r,ms)})}
function save(blob,name){var a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(function(){URL.revokeObjectURL(a.href)},120000)}

async function load(){
  var m=location.pathname.match(/^\/s\/([A-Za-z0-9_-]+)/);
  if(m){
    var r=await fetch('/share/'+m[1]);var j=await r.json().catch(function(){return{}});
    if(!j.ok)throw new Error(j.description||'This link has expired or is invalid.');
    return j.fids;
  }
  var h=''; try{h=decodeURIComponent(location.hash.slice(1))}catch(e){}
  return h.split(',').filter(function(x){return FID.test(x)});
}

async function run(){
  if(busy||!fids.length)return;
  if(!window.JSZip){say('The ZIP library did not load. Check your internet and reload.',true);return}
  busy=true;$('go').disabled=true;say('');
  var N=fids.length,stamp=new Date().toISOString().slice(0,10);
  var zip=new JSZip(),bytes=0,cnt=0,part=0,bad=0,done=0,next=0,saving=Promise.resolve();

  function flush(){
    if(!cnt)return Promise.resolve();
    var z=zip,n=++part;zip=new JSZip();bytes=0;cnt=0;               // swap first so other workers keep going
    saving=saving.then(async function(){
      var blob=await z.generateAsync({type:'blob',compression:'STORE'});
      save(blob,'InCloud_photos_'+stamp+'_part'+n+'.zip');
      await sleep(700);
    });
    return saving;
  }
  async function worker(){
    while(next<N){
      var i=next++;
      try{
        var r=await fetch('/f/'+encodeURIComponent(fids[i]));
        if(!r.ok)throw new Error('HTTP '+r.status);
        var b=await r.blob();
        if(cnt&&bytes+b.size>MAXPART)await flush();
        var ext=EXT[(b.type||'').toLowerCase()]||'jpg';
        zip.file(String(i+1).padStart(3,'0')+'_photo.'+ext,b,{compression:'STORE'});
        bytes+=b.size;cnt++;
      }catch(e){bad++}
      done++;prog(done/N*90,'Photo '+done+' of '+N);
    }
  }
  try{
    var ws=[];for(var k=0;k<Math.min(CONC,N);k++)ws.push(worker());
    await Promise.all(ws);
    await flush();await saving;
    prog(100,N+' photo'+(N>1?'s':''));
    if(part){say('ZIP ready: '+part+' file'+(part>1?'s':'')+' saved'+(bad?' · '+bad+' photo'+(bad>1?'s':'')+' skipped':'')+'.',false)}
    else say('No photo could be downloaded.',true);
  }catch(e){say(e&&e.message?e.message:'Something went wrong.',true)}
  busy=false;$('go').disabled=false;$('go').textContent='Download ZIP again';
}

$('go').onclick=run;
load().then(function(list){
  fids=list;
  if(!fids.length){prog(0,'Nothing to download.');say('This link has no photos.',true);return}
  prog(0,fids.length+' photo'+(fids.length>1?'s':'')+' ready');
  $('go').disabled=false;
  var g=$('grid');
  fids.slice(0,60).forEach(function(f){var im=new Image();im.loading='lazy';im.decoding='async';im.alt='';im.src='/f/'+encodeURIComponent(f);g.appendChild(im)});
  if(new URLSearchParams(location.search).get('auto')==='1')run();
}).catch(function(e){prog(0,'Link problem');say(e&&e.message?e.message:'Could not open this link.',true)});
})();
</script></body></html>`;
