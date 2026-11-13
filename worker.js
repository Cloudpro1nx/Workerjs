/**
 * In Cloud Pro – Ultimate Enterprise High-Performance Worker (10 Bots & Dual Chat Edition)
 * Features: Dual Chat 50-50 Load Balancing, Background Mirror Backup, Instant Edge Caching, 
 *           IP Rate Limiting (1000 uploads / 6 hours), Security Filters & Admin Alerts.
 */
const FIELD = { sendPhoto: 'photo', sendAudio: 'audio', sendVideo: 'video', sendDocument: 'document' };

const TYPES = { 
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mp3: 'audio/mpeg', m4a: 'audio/mp4',
  ogg: 'audio/ogg', wav: 'audio/wav', pdf: 'application/pdf', 
  zip: 'application/zip', rar: 'application/x-rar-compressed', '7z': 'application/x-7z-compressed',
  txt: 'text/plain', json: 'application/json'
};

const BLOCKED_EXTENSIONS = ['exe', 'bat', 'cmd', 'scr', 'js', 'php', 'sh', 'jar'];

// **আপনার দুটি নির্দিষ্ট চ্যাট আইডি**
const CHAT_ID_1 = "6915123052";
const CHAT_ID_2 = "9244007722";

// ১০টি টেলিগ্রাম বট টোকেন (প্রথম ৫টি চ্যাট ১ এর জন্য, পরের ৫টি চ্যাট ২ এর জন্য)
const BOT_TOKENS = [
  '9220212334:AAHS_ro1arDHsbGrFgwxhcukmrAxNkntAK0', // Bot 1 (Chat 1)
  '9009329678:AAF_9km1mNn3eHeoRuK7tME1AtamexvCW9Y', // Bot 2 (Chat 1)
  '9000032855:AAFQATa3LR3lpUEjE6Fp1DNIVt1thAv7c4g', // Bot 3 (Chat 1)
  '9000032855:AAFQATa3LR3lpUEjE6Fp1DNIVt1thAv7c4g', // Bot 4 (Chat 1)
  '9003459592:AAFIAVc4jMQhn_MYtvl5dQkAORcI73GLyFc', // Bot 5 (Chat 1)
  '9152119095:AAF9WLNRsoUPLJi8DkaeTy7gAHOikRGOAE', // Bot 6 (Chat 2)
  '9077197962:AAF930vM4ZPxvO_5DIO_8XKoAPM8VoRYwLs', // Bot 7 (Chat 2)
  '9218770739:AAF2C-0A-vZyOFE_WdtbaU8gLgKyxVgockk', // Bot 8 (Chat 2)
  '9171632972:AAGjEqcjxApfYrJzLKZgPb0-y1Tv2pUYB9k', // Bot 9 (Chat 2)
  '9158369160:AAEEv_fCQ3Rx90029Dl-tW_2C7M5ycBwt8M'  // Bot 10 (Chat 2)
];

const rateLimitMap = new Map();
const MAX_UPLOADS = 1000;
const TIME_WINDOW = 6 * 60 * 60 * 1000; 

function checkRateLimit(clientIP) {
  const now = Date.now();
  if (!rateLimitMap.has(clientIP)) {
    rateLimitMap.set(clientIP, { count: 1, resetTime: now + TIME_WINDOW });
    return { allowed: true };
  }
  let record = rateLimitMap.get(clientIP);
  if (now > record.resetTime) {
    rateLimitMap.set(clientIP, { count: 1, resetTime: now + TIME_WINDOW });
    return { allowed: true };
  }
  if (record.count >= MAX_UPLOADS) {
    const hoursLeft = Math.ceil((record.resetTime - now) / (1000 * 60 * 60));
    return { allowed: false, hoursLeft };
  }
  record.count++;
  return { allowed: true };
}

async function sendAdminAlert(token, chatId, message) {
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: `⚠️ *In Cloud Pro Alert*\n\n${message}`, parse_mode: 'Markdown' })
    });
  } catch (e) {}
}

const cors = () => ({
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, X-Admin-Key, Content-Type, Range',
  'Access-Control-Max-Age': '86400',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges'
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

async function handleSend(request, env, ctx, url) {
  if (!(await authorized(request, env))) return json({ ok: false, description: 'Unauthorized (401)' }, 401);

  const clientIP = request.headers.get('CF-Connecting-IP') || 'unknown';
  const rateCheck = checkRateLimit(clientIP);
  if (!rateCheck.allowed) {
    return json({ 
      ok: false, 
      description: `Rate limit exceeded! You can upload up to 1000 files every 6 hours. Please try again after ${rateCheck.hoursLeft} hours.` 
    }, 429);
  }

  const ep = url.searchParams.get('ep'), field = url.searchParams.get('field');
  if (!FIELD[ep] || FIELD[ep] !== field) return json({ ok: false, description: 'Bad request' }, 400);

  const inc = await request.formData();
  const file = inc.get(field);
  if (!file || typeof file === 'string') return json({ ok: false, description: 'No file received' }, 400);

  const fileName = (file.name || '').toLowerCase();
  const fileExt = fileName.split('.').pop();
  if (BLOCKED_EXTENSIONS.includes(fileExt)) {
    return json({ ok: false, description: 'Security Error: This file type is restricted and blocked.' }, 403);
  }

  const cap = inc.get('caption');
  const fileIndex = parseInt(inc.get('index') || "0"); // অ্যাপ থেকে আসা ছবির সিরিয়াল/ইনডেক্স

  // **৫০-৫০ লোড শেয়ারিং লজিক (নিখুঁতভাবে দুই চ্যাটে ভাগ করা)**
  let targetChatId, botGroup;
  if (fileIndex % 2 === 0) {
    targetChatId = CHAT_ID_1;
    botGroup = [0, 1, 2, 3, 4]; // প্রথম ৫টি বট (চ্যাট ১ এর জন্য)
  } else {
    targetChatId = CHAT_ID_2;
    botGroup = [5, 6, 7, 8, 9]; // পরের ৫টি বট (চ্যাট ২ এর জন্য)
  }

  // নির্ধারিত গ্রুপ থেকে র্যান্ডমলি একটি বট সিলেক্ট করা
  const randomBotIdx = botGroup[Math.floor(Math.random() * botGroup.length)];
  const primaryToken = BOT_TOKENS[randomBotIdx];

  const primaryForm = new FormData();
  primaryForm.append('chat_id', targetChatId);
  primaryForm.append(field, file, file.name || 'upload');
  if (cap) primaryForm.append('caption', String(cap).slice(0, 1000));

  let primaryResult = null;
  const telegramUrl = `https://api.telegram.org/bot${primaryToken}/${ep}`;
  
  try {
    let r = await fetch(telegramUrl, { method: 'POST', body: primaryForm });
    primaryResult = await r.json();
  } catch (e) {
    primaryResult = { ok: false, description: e.message };
  }

  if (!primaryResult || !primaryResult.ok) {
    ctx.waitUntil(sendAdminAlert(BOT_TOKENS[0], CHAT_ID_1, `Critical Error: Primary upload failed for IP: ${clientIP}`));
    return json(primaryResult || { ok: false, description: 'Upload failed' }, 500);
  }

  // **সফল আপলোডের পর ব্যাকগ্রাউন্ড মিরর ব্যাকআপ লজিক (Background Forwarding)**
  if (primaryResult && primaryResult.ok && primaryResult.result && primaryResult.result.message_id) {
    const sentMessageId = primaryResult.result.message_id;

    ctx.waitUntil((async () => {
      try {
        let backupChatId = (targetChatId === CHAT_ID_1) ? CHAT_ID_2 : CHAT_ID_1;
        let backupBotGroup = (targetChatId === CHAT_ID_1) ? [5, 6, 7, 8, 9] : [0, 1, 2, 3, 4];
        let backupToken = BOT_TOKENS[backupBotGroup[Math.floor(Math.random() * backupBotGroup.length)]];

        const forwardUrl = `https://api.telegram.org/bot${backupToken}/forwardMessage`;
        const payload = {
          chat_id: backupChatId,
          from_chat_id: targetChatId,
          message_id: sentMessageId
        };

        await fetch(forwardUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
      } catch (e) {}
    })());
  }

  return json(primaryResult);
}

async function handleDel(request, env, url) {
  if (!(await authorized(request, env))) return json({ ok: false, description: 'Unauthorized (401)' }, 401);
  const mid = parseInt(url.searchParams.get('mid'), 10);
  if (!mid) return json({ ok: false, description: 'Bad request' }, 400);

  // উভয় চ্যাট আইডি এবং ১০টি বট থেকেই ফাইল ডিলিট করার রিকোয়েস্ট পাঠানো
  const deletePromises = [];
  for (const token of BOT_TOKENS) {
    deletePromises.push(
      fetch(`https://api.telegram.org/bot${token}/deleteMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: CHAT_ID_1, message_id: mid }),
      }).catch(() => null)
    );
    deletePromises.push(
      fetch(`https://api.telegram.org/bot${token}/deleteMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: CHAT_ID_2, message_id: mid }),
      }).catch(() => null)
    );
  }
  await Promise.all(deletePromises);

  return json({ ok: true });
}

async function handleFile(request, env, fid) {
  let up = null;
  let successExt = '';
  
  for (const token of BOT_TOKENS) {
    try {
      const g = await (await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${encodeURIComponent(fid)}`)).json();
      if (g.ok && g.result && g.result.file_path) {
        const h = {};
        const range = request.headers.get('Range');
        if (range) h.Range = range;
        
        up = await fetch(`https://api.telegram.org/file/bot${token}/${g.result.file_path}`, { headers: h });
        if (up && up.ok) {
          successExt = (g.result.file_path.split('.').pop() || '').toLowerCase();
          break;
        }
      }
    } catch (e) { continue; }
  }

  if (!up || !up.ok) return json({ ok: false, description: 'File not found on any bot' }, 404);

  // সুপার ফাস্ট ক্যাশিং হেডার: ছবি একবার লোড হলে পরবর্তীতে ইনস্ট্যান্ট শো করবে
  const headers = { 
    ...cors(), 
    'Content-Type': TYPES[successExt] || 'application/octet-stream',
    'Cache-Control': 'public, max-age=31536000, immutable', 
    'Accept-Ranges': 'bytes' 
  };
  
  ['Content-Length', 'Content-Range', 'Content-Disposition'].forEach(k => { 
    const v = up.headers.get(k); 
    if (v) headers[k] = v; 
  });

  return new Response(up.body, { status: up.status, headers });
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors() });
    
    env = { 
      ...env, 
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
    
