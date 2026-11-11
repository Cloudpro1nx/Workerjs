/**
 * In Cloud Pro – Cloudflare Worker
 *
 * Routes
 *   POST /send?field=photo&ep=sendPhoto[&async=1]   upload to Telegram
 *   GET  /job?id=...                                result of a background upload
 *   POST /del?mid=...                               delete a Telegram message
 *   GET  /f/<file_id>                               stream a file back from Telegram
 *
 * Settings (Worker > Settings > Variables and Secrets)
 *   BOT_TOKEN         secret  Telegram bot token
 *   CHAT_ID           text    (optional) defaults to 6915123052
 *   ADMIN_KEY         secret  key typed into the admin panel
 *   FIREBASE_API_KEY  text    (optional) defaults to your firebaseConfig apiKey
 *   JOBS              KV namespace binding (needed only for background uploads)
 *
 * Background upload: with &async=1 the Worker buffers the file, answers {queued:true,job}
 * immediately, then ctx.waitUntil() sends it to Telegram. The app collects the reply
 * from /job. Without the JOBS binding (or without async=1) it works the old way and
 * waits for Telegram, so the admin panel and every other caller keep working.
 */
const FIELD = { sendPhoto: 'photo', sendAudio: 'audio', sendVideo: 'video', sendDocument: 'document' };
const ASYNC_MAX = 20 * 1024 * 1024; // bigger files are sent while the request waits (waitUntil has a ~30 s limit)
const TYPES = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mp3: 'audio/mpeg', m4a: 'audio/mp4',
  ogg: 'audio/ogg', wav: 'audio/wav', pdf: 'application/pdf' };

const cors = () => ({
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, X-Admin-Key, Content-Type',
  'Access-Control-Max-Age': '86400',
});
const json = (o, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...cors(), 'Content-Type': 'application/json' } });

async function authorized(request, env) {
  const ak = request.headers.get('X-Admin-Key');
  if (ak && env.ADMIN_KEY && ak === env.ADMIN_KEY) return true;
  const m = /^Bearer (.+)$/.exec(request.headers.get('Authorization') || '');
  if (!m || !env.FIREBASE_API_KEY) return false;
  try {
    const r = await fetch('https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + env.FIREBASE_API_KEY, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken: m[1] }),
    });
    const j = await r.json();
    return r.ok && Array.isArray(j.users) && j.users.length > 0;
  } catch (e) { return false; }
}

async function toTelegram(env, ep, form) {
  const url = `https://api.telegram.org/bot${env.BOT_TOKEN}/${ep}`;
  let r = await fetch(url, { method: 'POST', body: form });
  let j = await r.json();
  if (j && j.error_code === 429) { // rate limited: wait once and retry
    const wait = Math.min(10, (j.parameters && j.parameters.retry_after) || 2);
    await new Promise(res => setTimeout(res, wait * 1000));
    r = await fetch(url, { method: 'POST', body: form });
    j = await r.json();
  }
  return j;
}

async function handleSend(request, env, ctx, url) {
  if (!(await authorized(request, env))) return json({ ok: false, description: 'Unauthorized (401)' }, 401);
  const ep = url.searchParams.get('ep'), field = url.searchParams.get('field');
  if (!FIELD[ep] || FIELD[ep] !== field) return json({ ok: false, description: 'Bad request' }, 400);

  const inc = await request.formData();
  const file = inc.get(field);
  if (!file || typeof file === 'string') return json({ ok: false, description: 'No file received' }, 400);

  const out = new FormData();
  out.append('chat_id', env.CHAT_ID);
  out.append(field, file, file.name || 'upload');
  const cap = inc.get('caption');
  if (cap) out.append('caption', String(cap).slice(0, 1000));

  const background = url.searchParams.get('async') === '1' && env.JOBS && file.size <= ASYNC_MAX;
  if (!background) return json(await toTelegram(env, ep, out)); // old behaviour: wait for Telegram

  const id = crypto.randomUUID() + crypto.randomUUID().slice(0, 8);
  ctx.waitUntil((async () => {
    let res;
    try { res = await toTelegram(env, ep, out); }
    catch (e) { res = { ok: false, description: 'Telegram upload failed: ' + (e && e.message || e) }; }
    await env.JOBS.put('job:' + id, JSON.stringify(res), { expirationTtl: 300 });
  })());
  return json({ ok: true, queued: true, job: id }); // instant answer, Telegram keeps working in the background
}

async function handleJob(env, url) {
  const id = url.searchParams.get('id') || '';
  if (!env.JOBS || !/^[0-9a-f-]{20,60}$/.test(id)) return json({ state: 'pending' });
  const v = await env.JOBS.get('job:' + id);
  return v ? json({ state: 'done', res: JSON.parse(v) }) : json({ state: 'pending' });
}

async function handleDel(request, env, url) {
  if (!(await authorized(request, env))) return json({ ok: false, description: 'Unauthorized (401)' }, 401);
  const mid = parseInt(url.searchParams.get('mid'), 10);
  if (!mid) return json({ ok: false, description: 'Bad request' }, 400);
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/deleteMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: env.CHAT_ID, message_id: mid }),
  });
  return json(await r.json());
}

async function handleFile(request, env, fid) {
  const g = await (await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/getFile?file_id=${encodeURIComponent(fid)}`)).json();
  if (!g.ok) return json(g, 404);
  const h = {};
  const range = request.headers.get('Range');
  if (range) h.Range = range;
  const up = await fetch(`https://api.telegram.org/file/bot${env.BOT_TOKEN}/${g.result.file_path}`, { headers: h });
  const ext = (g.result.file_path.split('.').pop() || '').toLowerCase();
  const headers = { ...cors(), 'Content-Type': TYPES[ext] || 'application/octet-stream',
    'Cache-Control': 'public, max-age=86400', 'Accept-Ranges': 'bytes' };
  ['Content-Length', 'Content-Range'].forEach(k => { const v = up.headers.get(k); if (v) headers[k] = v; });
  return new Response(up.body, { status: up.status, headers });
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors() });
    // built-in defaults, so only BOT_TOKEN and ADMIN_KEY must be set as secrets
    env = { ...env, CHAT_ID: env.CHAT_ID || '6915123052', FIREBASE_API_KEY: env.FIREBASE_API_KEY || 'AIzaSyC6o__xNIM61kBrP7jfzMy8hKCeQc7Iv2E' };
    const url = new URL(request.url);
    try {
      if (url.pathname === '/send' && request.method === 'POST') return await handleSend(request, env, ctx, url);
      if (url.pathname === '/job' && request.method === 'GET') return await handleJob(env, url);
      if (url.pathname === '/del' && request.method === 'POST') return await handleDel(request, env, url);
      if (url.pathname.startsWith('/f/') && request.method === 'GET')
        return await handleFile(request, env, decodeURIComponent(url.pathname.slice(3)));
      return json({ ok: false, description: 'Not found' }, 404);
    } catch (e) {
      return json({ ok: false, description: String((e && e.message) || e) }, 500);
    }
  },
};
