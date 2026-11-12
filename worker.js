/**
 * In Cloud Pro – Ultimate Enterprise High-Performance Worker (10 Bots Edition)
 * Features: 10-Bot Round-Robin, Background Forwarding, Smart Failover, Edge Caching, 
 *           IP Rate Limiting (1000 uploads / 6 hours), Zip/Doc Support & Admin Alerts.
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

// আপনার পুরোনো ৫টি এবং নতুন ৫টি—মোট ১০টি টেলিগ্রাম বট টোকেন
const BOT_TOKENS = [
  '9220212334:AAHS_ro1arDHsbGrFgwxhcukmrAxNkntAK0', // Bot 1 (Old)
  '9009329678:AAF_9km1mNn3eHeoRuK7tME1AtamexvCW9Y', // Bot 2 (Old)
  '9000032855:AAFQATa3LR3lpUEjE6Fp1DNIVt1thAv7c4g', // Bot 3 (Old)
  '9000032855:AAFQATa3LR3lpUEjE6Fp1DNIVt1thAv7c4g', // Bot 4 (Old)
  '9003459592:AAFIAVc4jMQhn_MYtvl5dQkAORcI73GLyFc', // Bot 5 (Old)
  '9152119095:AAF9WLNRsoUPLJi8DkaeTy7gAHOikRGOAE', // Bot 6 (New - In_cloud_photo_5bot)[span_0](start_span)[span_0](end_span)
  '9077197962:AAF930vM4ZPxvO_5DIO_8XKoAPM8VoRYwLs', // Bot 7 (New - In_cloud_photo_6bot)[span_1](start_span)[span_1](end_span)
  '9218770739:AAF2C-0A-vZyOFE_WdtbaU8gLgKyxVgockk', // Bot 8 (New - In_cloud_photo_7bot)[span_2](start_span)[span_2](end_span)
  '9171632972:AAGjEqcjxApfYrJzLKZgPb0-y1Tv2pUYB9k', // Bot 9 (New - In_cloud_pros_bot)[span_3](start_span)[span_3](end_span)
  '9158369160:AAEEv_fCQ3Rx90029Dl-tW_2C7M5ycBwt8M'  // Bot 10 (New - In cloud pro 9)[span_4](start_span)[span_4](end_span)
];

let roundRobinIndex = 0;
function getNextPrimaryBot() {
  const token = BOT_TOKENS[roundRobinIndex];
  roundRobinIndex = (roundRobinIndex + 1) % BOT_TOKENS.length;
  return token;
}

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

async function sendToSingleBotWithFailover(tokens, ep, form) {
  let result = null;
  for (let i = 0; i < tokens.length; i++) {
    const currentToken = getNextPrimaryBot();
    const url = `https://api.telegram.org/bot${currentToken}/${ep}`;
    try {
      let r = await fetch(url, { method: 'POST', body: form });
      let j = await r.json();
      
      if (j && j.error_code === 429) {
        const wait = Math.min(5, (j.parameters && j.parameters.retry_after) || 2);
        await new Promise(res => setTimeout(res, wait * 1000));
        continue;
      }
      
      if (j && j.ok) {
        return { token: currentToken, result: j };
      }
      result = j;
    } catch (e) {
      continue;
    }
  }
  return { token: tokens[0], result: result || { ok: false, description: 'All bots failed' } };
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

  const primaryForm = new FormData();
  primaryForm.append('chat_id', env.CHAT_ID);
  primaryForm.append(field, file, file.name || 'upload');
  if (cap) primaryForm.append('caption', String(cap).slice(0, 1000));

  const uploadResponse = await sendToSingleBotWithFailover(BOT_TOKENS, ep, primaryForm);
  const primaryToken = uploadResponse.token;
  const primaryResult = uploadResponse.result;

  if (!primaryResult || !primaryResult.ok) {
    ctx.waitUntil(sendAdminAlert(BOT_TOKENS[0], env.CHAT_ID, `Critical Error: All primary bot uploads failed for IP: ${clientIP}`));
    return json(primaryResult, 500);
  }

  if (primaryResult && primaryResult.ok && primaryResult.result && primaryResult.result.message_id) {
    const sentMessageId = primaryResult.result.message_id;

    ctx.waitUntil((async () => {
      try {
        const forwardPromises = BOT_TOKENS.filter(token => token !== primaryToken).map(async (token) => {
          const forwardUrl = `https://api.telegram.org/bot${token}/forwardMessage`;
          const payload = {
            chat_id: env.CHAT_ID,
            from_chat_id: env.CHAT_ID,
            message_id: sentMessageId
          };

          let r = await fetch(forwardUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          });
          return r.json();
        });

        await Promise.all(forwardPromises);
      } catch (e) {}
    })());
  }

  return json(primaryResult);
}

async function handleDel(request, env, url) {
  if (!(await authorized(request, env))) return json({ ok: false, description: 'Unauthorized (401)' }, 401);
  const mid = parseInt(url.searchParams.get('mid'), 10);
  if (!mid) return json({ ok: false, description: 'Bad request' }, 400);

  await Promise.all(BOT_TOKENS.map(token => 
    fetch(`https://api.telegram.org/bot${token}/deleteMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: env.CHAT_ID, message_id: mid }),
    }).catch(() => null)
  ));

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
    
