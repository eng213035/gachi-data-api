// Japan Toilet & Accessibility MCP — lean MVP
// - Multi-key auth (self-serve free keys stored in KV)
// - Per-plan monthly rate limiting (KV counter; eventually consistent = approximate, fine for MVP)
// - English landing page + free-key form + Business interest form
// Data served straight from KV (see build_kv_seed*.py). No D1/Stripe-webhook in this lean build.

const PLAN_LIMITS = { free: 1000, pro: 100000, admin: Infinity };

const TOOLS = [
  {
    name: 'get_toilet_by_station',
    description:
      'Look up wheelchair-accessible / multipurpose toilets inside a Tokyo train station, ' +
      'including floor, gender, equipment (wheelchair, ostomate, diaper table) and the nearest exit. ' +
      'Covers 526 Tokyo stations. Accepts Japanese (新宿) or romaji (Shinjuku, Kita-Senju) for major stations.',
    prefix: 'toilet:',
    argName: 'station',
    attribution: {
      source: 'Tokyo Metropolitan Government, Bureau of Social Welfare (wheelchair-accessible toilet dataset)',
      license: 'CC BY 4.0',
      derived: 'nearest_exit is an original value computed by gachi-tokusuru.com via spatial join',
      romaji: 'English station names via ODPT (Public Transportation Open Data Center)',
      provider: 'https://toilet.gachi-tokusuru.com',
    },
    inputSchema: {
      type: 'object',
      properties: {
        station: {
          type: 'string',
          description: 'Station name in Japanese (新宿, 渋谷) or romaji for major stations (Shinjuku, Shibuya, Kita-Senju).',
        },
      },
      required: ['station'],
    },
  },
  {
    name: 'get_public_toilet_by_city',
    description:
      'List public toilets in a Japanese municipality, with wheelchair / baby-seat / ostomate flags, ' +
      'address and coordinates. Covers 612 municipalities nationwide (large cities capped at the top 50 results). ' +
      'Municipality names accept Japanese (e.g. 那覇市, 渋谷区); prefixing the prefecture improves accuracy.',
    prefix: 'wc:',
    argName: 'city',
    attribution: {
      source: 'BODIK nationwide public-toilet open data (aggregated from Japanese municipalities)',
      license: 'CC BY 4.0 (or equivalent municipal open-data terms)',
      provider: 'https://toilet.gachi-tokusuru.com',
    },
    inputSchema: {
      type: 'object',
      properties: {
        city: {
          type: 'string',
          description: 'Municipality name in Japanese (e.g. 那覇市, 渋谷区, 上天草市). Prefix the prefecture for accuracy.',
        },
      },
      required: ['city'],
    },
  },
];

async function lookup(env, prefix, query) {
  const exact = await env.TOILET_KV.get(`${prefix}${query}`, 'json');
  if (exact) return exact;

  // romaji alias: "Shinjuku" / "Kita-Senju" -> 日本語駅名 (station prefix only)
  if (prefix === 'toilet:' && /[a-zA-Z]/.test(query)) {
    const norm = query.toLowerCase().replace(/[^a-z0-9]/g, '');
    const ja = await env.TOILET_KV.get(`romaji:${norm}`);
    if (ja) {
      const viaRomaji = await env.TOILET_KV.get(`${prefix}${ja}`, 'json');
      if (viaRomaji) return viaRomaji;
    }
  }

  const { keys } = await env.TOILET_KV.list({ prefix });
  const hit = keys.find((k) => {
    const name = k.name.slice(prefix.length);
    return name.includes(query) || query.includes(name);
  });
  return hit ? env.TOILET_KV.get(hit.name, 'json') : null;
}

// ---- i18n: normalize raw JP values to an English-first schema (response layer only;
//      raw KV data is never mutated, so re-imports stay safe) --------------------------
const GENDER_EN = { '共用': 'all', '男性用': 'male', '女性用': 'female' };
const LINE_EN = {
  '山手線': 'Yamanote Line', '中央線': 'Chuo Line', '中央本線': 'Chuo Line', '中央・総武線': 'Chuo-Sobu Line',
  '総武線': 'Sobu Line', '京浜東北線': 'Keihin-Tohoku Line', '埼京線': 'Saikyo Line',
  '湘南新宿ライン': 'Shonan-Shinjuku Line', '横須賀線': 'Yokosuka Line', '京葉線': 'Keiyo Line',
  '小田原線': 'Odakyu Odawara Line', '多摩線': 'Odakyu Tama Line', '江ノ島線': 'Odakyu Enoshima Line',
  '井の頭線': 'Keio Inokashira Line', '京王線': 'Keio Line', '相模原線': 'Keio Sagamihara Line',
  '東横線': 'Tokyu Toyoko Line', '田園都市線': 'Tokyu Den-en-toshi Line', '目黒線': 'Tokyu Meguro Line',
  '大井町線': 'Tokyu Oimachi Line', '池上線': 'Tokyu Ikegami Line',
  '銀座線': 'Ginza Line', '丸ノ内線': 'Marunouchi Line', '日比谷線': 'Hibiya Line', '東西線': 'Tozai Line',
  '千代田線': 'Chiyoda Line', '有楽町線': 'Yurakucho Line', '半蔵門線': 'Hanzomon Line', '南北線': 'Namboku Line',
  '副都心線': 'Fukutoshin Line',
  '浅草線': 'Asakusa Line', '三田線': 'Mita Line', '新宿線': 'Shinjuku Line', '大江戸線': 'Oedo Line',
  '京成本線': 'Keisei Main Line', '押上線': 'Keisei Oshiage Line',
  '東武スカイツリーライン': 'Tobu Skytree Line', '伊勢崎線': 'Tobu Isesaki Line', '東上線': 'Tobu Tojo Line',
  '西武池袋線': 'Seibu Ikebukuro Line', '池袋線': 'Seibu Ikebukuro Line', '西武新宿線': 'Seibu Shinjuku Line',
  '京急本線': 'Keikyu Main Line', '空港線': 'Keikyu Airport Line',
};
const GATE_DIR_EN = {
  '東改札': 'East Gate', '西改札': 'West Gate', '南改札': 'South Gate', '北改札': 'North Gate',
  '中央改札': 'Central Gate', '新南改札': 'New South Gate', '中央東改札': 'Central East Gate', '中央西改札': 'Central West Gate',
  '東口': 'East Exit', '西口': 'West Exit', '南口': 'South Exit', '北口': 'North Exit',
  '中央口': 'Central Exit', '中央東口': 'Central East Exit', '中央西口': 'Central West Exit',
};

function normHours(raw) {
  if (!raw) return null;
  if (raw === '始発〜終車') return 'first_train_to_last_train';
  if (/^\d/.test(raw)) return raw.replace('〜', '-'); // numeric time range → strip JP punctuation
  return null;
}
function cleanLine(line) { return (line || '').replace(/^\d+号線/, ''); }
function lineEn(line) {
  const c = cleanLine(line);
  if (!c) return null;
  if (c.includes('/')) {
    const parts = c.split('/').map((p) => LINE_EN[p.trim()]).filter(Boolean);
    return parts.length ? parts.join(' / ') : null;
  }
  return LINE_EN[c] || null;
}
function exitEn(raw) {
  const t = (raw || '').trim();
  const m = t.match(/^([A-Za-z]?\d+[A-Za-z]?)番?出口$/);
  if (m) return `Exit ${m[1]}`;
  if (/^[A-Za-z]\d+$/.test(t)) return `Exit ${t}`;
  if (t.startsWith('JR') && GATE_DIR_EN[t.slice(2)]) return 'JR ' + GATE_DIR_EN[t.slice(2)];
  return GATE_DIR_EN[t] || null;
}
function structExit(rawName, m) {
  const distance_m = (typeof m === 'number') ? m : null;
  if (!rawName || rawName === '出口' || rawName === '改札') {
    return { name: null, name_ja: null, distance_m, named: false };
  }
  return { name: exitEn(rawName), name_ja: rawName, distance_m, named: true };
}
function toEnglishToilet(r) {
  return {
    name: 'Accessible Toilet',
    name_ja: r.name || null,
    type: 'accessible',
    line: lineEn(r.line),
    line_ja: cleanLine(r.line) || null,
    floor: r.floor || null,
    gender: GENDER_EN[r.gender] ?? null,
    wheelchair: !!r.wheelchair,
    ostomate: !!r.ostomate,
    diaper: !!r.diaper,
    hours: normHours(r.hours),
    nearest_exit: structExit(r.nearest_exit, r.nearest_exit_m),
  };
}
async function toEnglishStation(env, found) {
  const en = await env.TOILET_KV.get(`en:${found.station}`);
  return {
    station: en || found.station,
    station_ja: found.station,
    station_name_source: en ? 'odpt' : 'japanese_fallback',
    count: found.count,
    toilets: (found.toilets || []).map(toEnglishToilet),
  };
}
function toEnglishCity(found) {
  return {
    city: found.city,
    count: found.count,
    returned: found.returned,
    toilets: (found.toilets || []).map((t) => ({
      name: t.name, addr: t.addr, lat: t.lat, lon: t.lon,
      wheelchair: !!t.wheelchair, baby: !!t.baby, ostomate: !!t.ostomate,
      hours: normHours(t.hours),
    })),
  };
}

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}
function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---- API key store (KV) --------------------------------------------------
function randToken(prefix) {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${prefix}${hex}`;
}

async function resolveAuth(request, env) {
  const auth = request.headers.get('authorization') || '';
  const [scheme, token] = auth.split(' ');
  if (scheme !== 'Bearer' || !token) return { ok: false };
  // admin/master key (env secret) — unlimited, for internal testing
  if (env.API_KEY && timingSafeEqual(token, env.API_KEY)) {
    return { ok: true, plan: 'admin', token };
  }
  const record = await env.TOILET_KV.get(`key:${token}`, 'json');
  if (!record || record.status !== 'active') return { ok: false };
  return { ok: true, plan: record.plan || 'free', token };
}

function monthKey() {
  return new Date().toISOString().slice(0, 7); // YYYY-MM (UTC)
}

// returns { allowed, used, limit }
async function meterUsage(env, token, plan) {
  const limit = PLAN_LIMITS[plan] ?? PLAN_LIMITS.free;
  if (limit === Infinity) return { allowed: true, used: 0, limit };
  const k = `usage:${token}:${monthKey()}`;
  const used = parseInt((await env.TOILET_KV.get(k)) || '0', 10);
  if (used >= limit) return { allowed: false, used, limit };
  // ~35 day TTL so old counters self-expire
  await env.TOILET_KV.put(k, String(used + 1), { expirationTtl: 3024000 });
  return { allowed: true, used: used + 1, limit };
}

async function issueFreeKey(env, email) {
  const token = randToken('gk_free_');
  const record = { plan: 'free', email, status: 'active', created: new Date().toISOString() };
  await env.TOILET_KV.put(`key:${token}`, JSON.stringify(record));
  // bump a simple issuance counter (KPI)
  const c = parseInt((await env.TOILET_KV.get('stat:keys_issued')) || '0', 10);
  await env.TOILET_KV.put('stat:keys_issued', String(c + 1));
  return token;
}

async function issueProKey(env, email) {
  const token = randToken('gk_pro_');
  const record = { plan: 'pro', email, status: 'active', created: new Date().toISOString() };
  await env.TOILET_KV.put(`key:${token}`, JSON.stringify(record));
  const c = parseInt((await env.TOILET_KV.get('stat:pro_keys_issued')) || '0', 10);
  await env.TOILET_KV.put('stat:pro_keys_issued', String(c + 1));
  return token;
}

// Verify a paid Stripe Checkout Session and hand back a Pro key (idempotent per session).
async function activatePro(env, sessionId) {
  const cached = await env.TOILET_KV.get(`session:${sessionId}`, 'json');
  if (cached) return { ok: true, ...cached }; // already activated → same key

  const resp = await fetch(`https://api.stripe.com/v1/checkout/sessions/${sessionId}`, {
    headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
  });
  if (!resp.ok) return { ok: false, reason: 'verify_failed' };
  const s = await resp.json();
  const paid = s.payment_status === 'paid' || s.status === 'complete';
  if (!paid) return { ok: false, reason: 'not_paid' };

  const email = s.customer_details?.email || s.customer_email || '';
  const key = await issueProKey(env, email);
  const rec = { key, email };
  await env.TOILET_KV.put(`session:${sessionId}`, JSON.stringify(rec));
  return { ok: true, ...rec };
}

function activatePage(body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Pro activation</title>
<style>body{font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;max-width:640px;margin:40px auto;padding:0 20px;color:#1a1a1a}
code{background:#f6f8f7;border:1px solid #e3e8e6;border-radius:6px;padding:2px 6px;word-break:break-all}
.key{display:block;background:#eef6f2;border:1px solid #bfe6d5;border-radius:8px;padding:14px;font-family:ui-monospace,Menlo,monospace;margin:12px 0;word-break:break-all}
.mut{color:#666;font-size:14px}a{color:#0b6}</style></head><body>${body}</body></html>`;
}

async function saveInterest(env, email, useCase) {
  const id = randToken('int_');
  await env.TOILET_KV.put(
    `interest:${id}`,
    JSON.stringify({ email, use_case: useCase, created: new Date().toISOString() }),
  );
}

// ---- MCP JSON-RPC --------------------------------------------------------
async function handleRpc(body, env) {
  const { id, method, params } = body;

  if (method === 'initialize') {
    return rpcResult(id, {
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'gachi-japan-toilet-mcp', version: '0.3.0' },
    });
  }
  if (method === 'notifications/initialized') return null;
  if (method === 'tools/list') {
    return rpcResult(id, { tools: TOOLS.map(({ prefix, argName, attribution, ...t }) => t) });
  }
  if (method === 'tools/call') {
    const tool = TOOLS.find((t) => t.name === params?.name);
    if (!tool) return rpcError(id, -32602, `unknown tool: ${params?.name}`);
    const query = params?.arguments?.[tool.argName];
    const found = query ? await lookup(env, tool.prefix, query) : null;
    let payload;
    if (!found) {
      payload = { error: `No data found for "${query}".`, attribution: tool.attribution };
    } else if (tool.name === 'get_toilet_by_station') {
      payload = { ...(await toEnglishStation(env, found)), attribution: tool.attribution };
    } else {
      payload = { ...toEnglishCity(found), attribution: tool.attribution };
    }
    return rpcResult(id, { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] });
  }
  return rpcError(id, -32601, `method not found: ${method}`);
}

const UPGRADE_URL = 'https://api.gachi-tokusuru.com'; // landing page with pricing + PayPal Pro link

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Landing page
    if (request.method === 'GET' && url.pathname === '/') {
      return new Response(LANDING_HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    }

    // No-auth sample response (click-to-try; fixed to Shinjuku so it isn't a free unlimited API)
    if (request.method === 'GET' && url.pathname === '/example') {
      const tool = TOOLS.find((t) => t.name === 'get_toilet_by_station');
      const found = await lookup(env, tool.prefix, '新宿');
      const en = found ? await toEnglishStation(env, found) : null;
      if (en) {
        // showcase only cleanly-named exits, closest first
        const nice = en.toilets
          .filter((t) => t.nearest_exit.named && t.nearest_exit.name)
          .sort((a, b) => (a.nearest_exit.distance_m ?? 1e9) - (b.nearest_exit.distance_m ?? 1e9));
        if (nice.length) { en.toilets = nice; en.count = nice.length; }
      }
      const payload = {
        note: 'Live sample of get_toilet_by_station("Shinjuku"). English-first; *_ja fields carry the original Japanese (use whichever you need). Get a free key at https://api.gachi-tokusuru.com to query any station via MCP.',
        ...(en || { error: 'sample unavailable' }),
        attribution: tool.attribution,
      };
      return Response.json(payload, { headers: { 'access-control-allow-origin': '*' } });
    }

    // Pro activation — Stripe redirects here after a successful subscription checkout.
    if (request.method === 'GET' && url.pathname === '/pro-activate') {
      const sid = url.searchParams.get('session_id') || '';
      const htmlHeaders = { 'content-type': 'text/html; charset=utf-8' };
      if (!/^cs_[A-Za-z0-9_]+$/.test(sid)) {
        return new Response(activatePage(
          '<h1>Pro activation</h1><p>Missing or invalid session. If you just paid and see this, contact support with your payment email.</p>'
          + '<p class="mut">contact@piachan.com</p>'), { headers: htmlHeaders, status: 400 });
      }
      const r = await activatePro(env, sid);
      if (!r.ok) {
        const msg = r.reason === 'not_paid'
          ? 'Payment is not completed yet. If you just paid, refresh this page in a few seconds.'
          : 'We could not verify your payment automatically. Please contact support with your payment email — we\'ll send your key.';
        return new Response(activatePage(`<h1>Pro activation</h1><p>${msg}</p><p class="mut">contact@piachan.com</p>`),
          { headers: htmlHeaders });
      }
      return new Response(activatePage(
        '<h1>✅ You\'re on Pro</h1>'
        + '<p>Thanks for subscribing. Here is your Pro API key (100,000 requests/month):</p>'
        + `<code class="key">${r.key}</code>`
        + '<p><b>Save it now</b> — treat it like a password. Use it as <code>Authorization: Bearer &lt;key&gt;</code> at '
        + '<code>https://api.gachi-tokusuru.com/mcp</code>.</p>'
        + '<p class="mut">A copy is tied to your subscription; reopening this page shows the same key. '
        + 'Questions? contact@piachan.com</p>'), { headers: htmlHeaders });
    }

    // Self-serve free key
    if (request.method === 'POST' && url.pathname === '/keys') {
      let b;
      try { b = await request.json(); } catch { return Response.json({ error: 'invalid json' }, { status: 400 }); }
      const email = (b?.email || '').trim();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        return Response.json({ error: 'valid email required' }, { status: 400 });
      }
      const token = await issueFreeKey(env, email);
      return Response.json({ api_key: token, plan: 'free', monthly_limit: PLAN_LIMITS.free });
    }

    // Business interest form
    if (request.method === 'POST' && url.pathname === '/interest') {
      let b;
      try { b = await request.json(); } catch { return Response.json({ error: 'invalid json' }, { status: 400 }); }
      const email = (b?.email || '').trim();
      const useCase = (b?.use_case || '').trim();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !useCase) {
        return Response.json({ error: 'email and use_case required' }, { status: 400 });
      }
      await saveInterest(env, email, useCase);
      return Response.json({ ok: true });
    }

    // MCP endpoint
    if (request.method === 'POST' && url.pathname === '/mcp') {
      let body;
      try { body = await request.json(); } catch {
        return Response.json(rpcError(null, -32700, 'parse error'), { status: 400 });
      }
      // Introspection (initialize / tools/list / notifications) is open — no key needed,
      // so any client or directory can discover the tools. Only tools/call needs a key + metering.
      if (body?.method === 'tools/call') {
        const auth = await resolveAuth(request, env);
        if (!auth.ok) {
          return Response.json(
            rpcError(body.id ?? null, -32001, 'unauthorized: get a free key at ' + UPGRADE_URL),
            { status: 401 },
          );
        }
        const m = await meterUsage(env, auth.token, auth.plan);
        if (!m.allowed) {
          return Response.json(
            rpcError(body.id ?? null, -32002,
              `monthly limit reached (${m.used}/${m.limit} on ${auth.plan}). Upgrade to Pro: ${UPGRADE_URL}`),
            { status: 429, headers: { 'retry-after': '3600' } },
          );
        }
      }
      const result = await handleRpc(body, env);
      if (result === null) return new Response(null, { status: 202 });
      return Response.json(result);
    }

    return new Response('not found', { status: 404 });
  },
};

const LANDING_HTML = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Japan Toilet & Accessibility API / MCP</title>
<style>
:root{--fg:#1a1a1a;--mut:#666;--acc:#0b6;--bg:#fff;--card:#f6f8f7;--bd:#e3e8e6}
*{box-sizing:border-box}body{margin:0;font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:var(--fg);background:var(--bg)}
.wrap{max-width:760px;margin:0 auto;padding:32px 20px 64px}
h1{font-size:30px;line-height:1.2;margin:0 0 8px}h2{font-size:20px;margin:40px 0 12px}
.sub{color:var(--mut);font-size:18px;margin:0 0 24px}
code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
pre{background:var(--card);border:1px solid var(--bd);border-radius:8px;padding:14px;overflow-x:auto;font-size:13px}
.demo{background:#0c1;background:linear-gradient(135deg,#0b6,#093);color:#fff;border-radius:10px;padding:18px 20px;margin:20px 0}
.demo b{font-size:18px}
table{width:100%;border-collapse:collapse;margin:8px 0}th,td{text-align:left;padding:10px 8px;border-bottom:1px solid var(--bd);vertical-align:top}
.price{font-size:22px;font-weight:700}
.tag{display:inline-block;background:#eef6f2;color:var(--acc);border:1px solid #bfe6d5;border-radius:99px;font-size:12px;padding:2px 10px;margin-left:6px}
form{background:var(--card);border:1px solid var(--bd);border-radius:8px;padding:16px;margin:12px 0}
input,textarea{width:100%;padding:10px;border:1px solid var(--bd);border-radius:6px;font:inherit;margin:6px 0}
button{background:var(--acc);color:#fff;border:0;border-radius:6px;padding:10px 18px;font:inherit;font-weight:600;cursor:pointer}
.out{font-size:13px;margin-top:8px;white-space:pre-wrap;word-break:break-all}
.mut{color:var(--mut);font-size:13px}a{color:var(--acc)}
footer{margin-top:48px;color:var(--mut);font-size:13px;border-top:1px solid var(--bd);padding-top:16px}
</style></head><body><div class="wrap">

<h1>Japan Toilet &amp; Accessibility API <span class="tag">Early access</span></h1>
<p class="sub">Clean, structured data on wheelchair-accessible &amp; public toilets across Japan — for AI agents, travel &amp; accessibility apps. Available as REST and <b>MCP</b>.</p>

<div class="demo">
<b>新宿駅 (Shinjuku) → nearest accessible toilet</b><br>
11 multipurpose toilets, mapped to their <b>nearest station exit</b> — a first-party value you won't find in any raw dataset.
</div>

<p><a href="/example" target="_blank" rel="noopener"><b>▶ See a live sample response</b></a> — no key needed, opens real JSON in your browser.</p>

<h2>Coverage</h2>
<ul>
<li><b>526 Tokyo stations</b> — accessible toilets with floor, gender, equipment &amp; <code>nearest_exit</code></li>
<li><b>612 municipalities</b> nationwide — public toilets with wheelchair / baby-seat / ostomate flags</li>
</ul>

<h2>Built with this data</h2>
<p><a href="https://toilet.gachi-tokusuru.com/en" target="_blank" rel="noopener">toilet.gachi-tokusuru.com</a> — a live site built entirely on this dataset. Your app can do the same in one API call.</p>

<h2>Pricing <span class="mut">(early-access — early users are grandfathered)</span></h2>
<table>
<tr><th>Plan</th><th>Price</th><th>Limit</th><th></th></tr>
<tr><td class="price">Free</td><td>$0</td><td>1,000 req / mo</td><td>Try it with your agent — full MCP access</td></tr>
<tr><td class="price">Pro</td><td>$19/mo</td><td>100,000 req / mo</td><td>Production volume — same full MCP access</td></tr>
<tr><td class="price">Business</td><td>Contact</td><td>—</td><td>Station master (cross-operator), ridership trends &amp; bulk datasets — <i>in development</i></td></tr>
</table>
<p><a href="https://buy.stripe.com/00w9ATg4B5F5byV2B13Ru00" target="_blank" rel="noopener"><b>Subscribe to Pro — $19/mo →</b></a> <span class="mut">(your Pro key, 100K req/mo, is shown instantly after checkout)</span></p>

<h2>Get a free API key</h2>
<p class="mut">Enter your email — your key is issued instantly on this page (1,000 req/mo, no card required).</p>
<form id="keyform">
<input type="email" id="kemail" placeholder="you@example.com" required>
<button type="submit">Get free key</button>
<div class="out" id="kout"></div>
</form>

<h2>Connect from an MCP client (Claude Desktop / Claude Code)</h2>
<pre>{
  "mcpServers": {
    "japan-toilet": {
      "url": "https://api.gachi-tokusuru.com/mcp",
      "headers": { "Authorization": "Bearer YOUR_API_KEY" }
    }
  }
}</pre>

<h2>Try it with curl</h2>
<pre>curl -X POST https://api.gachi-tokusuru.com/mcp \\
  -H "Authorization: Bearer YOUR_API_KEY" -H "Content-Type: application/json" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call",
       "params":{"name":"get_toilet_by_station","arguments":{"station":"Shinjuku"}}}'</pre>

<p class="mut">Prefer a plain REST endpoint over MCP? It's on the roadmap — <a href="#bizform">tell us your use case</a> and we'll prioritize it.</p>

<h2>Business / bulk data</h2>
<p class="mut">Interested in the upcoming cross-operator station master, ridership trends &amp; bulk datasets? Tell us what you'd use — it directly shapes what we build next.</p>
<form id="bizform">
<input type="email" id="bemail" placeholder="you@example.com" required>
<textarea id="buse" rows="2" placeholder="What would you use it for? (1 line)" required></textarea>
<button type="submit">Contact us</button>
<div class="out" id="bout"></div>
</form>

<footer>
Data: Tokyo Metropolitan Government &amp; BODIK municipal open data (CC BY 4.0). <code>nearest_exit</code> is an original derived value by gachi-tokusuru.com. Timeliness, accuracy and completeness are not guaranteed.
</footer>

<script>
document.getElementById('keyform').onsubmit=async(e)=>{e.preventDefault();
 const o=document.getElementById('kout');o.textContent='...';
 const r=await fetch('/keys',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:document.getElementById('kemail').value})});
 const j=await r.json();
 o.textContent=j.api_key?('Your key: '+j.api_key+'\\n(1,000 req/mo. Keep it safe.)'):('Error: '+(j.error||'failed'));};
document.getElementById('bizform').onsubmit=async(e)=>{e.preventDefault();
 const o=document.getElementById('bout');o.textContent='...';
 const r=await fetch('/interest',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:document.getElementById('bemail').value,use_case:document.getElementById('buse').value})});
 const j=await r.json();o.textContent=j.ok?'Thanks — we\\'ll be in touch.':('Error: '+(j.error||'failed'));};
</script>
</div></body></html>`;
