/**
 * In Cloud Pro – Multi-Bot Cloudflare Worker (5 Bots High-Availability & Parallel Backup)
 */
const FIELD = { sendPhoto: 'photo', sendAudio: 'audio', sendVideo: 'video', sendDocument: 'document' };
const ASYNC_MAX = 20 * 1024 * 1024;
const TYPES = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mp3: 'audio/mpeg', m4a: 'audio/mp4',
  ogg: 'audio/ogg', wav: 'audio/wav', pdf: 'application/pdf' };

// আপনার দেওয়া ৫টি বটের তালিকা (১টি আগের + ৪টি নতুন)
const BOT_TOKENS = [
  '9220212334:AAHS_ro1arDHsbGrFgwxhcukmrAxNkntAK0', // Bot 1 (Original)
  '9009329678:AAF_9km1mNn3eHeoRuK7tME1AtamexvCW9Y', // Bot 2
  '9000032855:AAFQATa3LR3lpUEjE6Fp1DNIVt1thAv7c4g', // Bot 3
  '9000032855:AAFQATa3LR3lpUEjE6Fp1DNIVt1thAv7c4g', // Bot 4
  '9003459592:AAFIAVc4jMQhn_MYtvl5dQkAORcI73GLyFc'  // Bot 5
];

let roundRobinIndex = 0;
function getNextBotToken() {
  const token = BOT_TOKENS[roundRobinIndex];
  roundRobinIndex = (roundRobinIndex + 1) % BOT_TOKENS.length;
  return token;
}

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

// একক কোনো টেলিগ্রাম বটে রিকোয়েস্ট পাঠানোর ফাংশন
async function sendToSingleBot(token, ep, form) {
  const url = `https://api.telegram.org/bot${token}/${ep}`;
  let r = await fetch(url, { method: 'POST', body: form });
  let j = await r.json();
  if (j && j.error_code === 429) {
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

  const cap = inc.get('caption');

  // প্রাইমারি আপলোডের জন্য রাউন্ড-রবিন থেকে একটি বট বেছে নেওয়া
  const primaryToken = getNextBotToken();
  const primaryForm = new FormData();
  primaryForm.append('chat_id', env.CHAT_ID);
  primaryForm.append(field, file, file.name || 'upload');
  if (cap) primaryForm.append('caption', String(cap).slice(0, 1000));

  // প্রথম বটের রেসপন্সের জন্য অপেক্ষা করা যাতে ইউজার তাৎক্ষণিক রেসপন্স পায়
  let primaryResult = await sendToSingleBot(primaryToken, ep, primaryForm);

  // ব্যাকগ্রাউন্ডে বাকি বটগুলোর কাছেও ফাইলটি পাঠিয়ে ব্যাকআপ নিশ্চিত করা (Fault Tolerance & Multi-Bot Backup)
  ctx.waitUntil((async () => {
    try {
      const backupPromises = BOT_TOKENS.filter(t => t !== primaryToken).map(token => {
        const backupForm = new FormData();
        backupForm.append('chat_id', env.CHAT_ID);
        backupForm.append(field, file, file.name || 'upload');
        if (cap) backupForm.append('caption', String(cap).slice(0, 1000));
        return sendToSingleBot(token, ep, backupForm).catch(() => null);
      });
      await Promise.all(backupPromises);
    } catch (e) {
      // ব্যাকআপ ফেইল করলেও প্রাইমারি সফল হলে যেন অ্যাপে সমস্যা না হয়
    }
  })());

  return json(primaryResult);
}

async function handleDel(request, env, url) {
  if (!(await authorized(request, env))) return json({ ok: false, description: 'Unauthorized (401)' }, 401);
  const mid = parseInt(url.searchParams.get('mid'), 10);
  if (!mid) return json({ ok: false, description: 'Bad request' }, 400);

  // ডিলিটের সময় সবকটি বট থেকেই মেসেজ মুছে ফেলার চেষ্টা করা
  await Promise.all(BOT_TOKENS.map(token => 
    fetch(`https://api.telegram.org/bot${token}/deleteMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: env.CHAT_ID, message_id: mid }),
    }).catch(() => null)
  ));

  return json({ ok: true });
}

async function handleFile(request, env, fid) {
  // ফাইল রিট্রিভ বা স্ট্রিম করার সময় যেকোনো একটি সচল বট টোকেন ব্যবহার করা
  let up = null;
  let successExt = '';
  
  for (const token of BOT_TOKENS) {
    try {
      const g = await (await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${encodeURIComponent(fid)}`)).json();
      if (g.ok) {
        const h = {};
        const range = request.headers.get('Range');
        if (range) h.Range = range;
        up = await fetch(`https://api.telegram.org/file/bot${token}/${g.result.file_path}`, { headers: h });
        if (up.ok) {
          successExt = (g.result.file_path.split('.').pop() || '').toLowerCase();
          break;
        }
      }
    } catch (e) {
      continue; // একটি বটে না পেলে পরবর্তী বটের কাছে ট্রাই করবে
    }
  }

  if (!up || !up.ok) return json({ ok: false, description: 'File not found on any bot' }, 404);

  const headers = { ...cors(), 'Content-Type': TYPES[successExt] || 'application/octet-stream',
    'Cache-Control': 'public, max-age=86400', 'Accept-Ranges': 'bytes' };
  ['Content-Length', 'Content-Range'].forEach(k => { const v = up.headers.get(k); if (v) headers[k] = v; });
  return new Response(up.body, { status: up.status, headers });
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors() });
    
    env = { 
      ...env, 
      CHAT_ID: env.CHAT_ID || '6915123052', 
      FIREBASE_API_KEY: env.FIREBASE_API_KEY || 'AIzaSyC6o__xNIM61kBrP7jfzMy8hKCeQc7Iv2E' 
    };

    const url = new URL(request.url);
    try {
      if (url.pathname === '/send' && request.method === 'POST') return await handleSend(request, env, ctx, url);
      if (url.pathname === '/del' && request.method === 'POST') return await handleDel(request, env, url);
      if (url.pathname.startsWith('/f/') && request.method === 'GET')
        return await handleFile(request, env, decodeURIComponent(url.pathname.slice(3)));
      return json({ ok: false, description: 'Not found' }, 404);
    } catch (e) {
      return json({ ok: false, description: String((e && e.message) || e) }, 500);
    }
  },
};
                   
