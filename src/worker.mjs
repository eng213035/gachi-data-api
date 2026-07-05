// Gachi Data API — Japan Station & Accessibility Data (API · MCP · Open Datasets) — lean MVP
// - Multi-key auth (self-serve free keys stored in KV)
// - Per-plan monthly rate limiting (KV counter; eventually consistent = approximate, fine for MVP)
// - English landing page + free-key form + Business interest form
// Data served straight from KV (see build_kv_seed*.py). No D1/Stripe-webhook in this lean build.

// Bumped on every deploy so /__version proves which build a given request hit.
const BUILD_VERSION = {
  commit: 'v2-nationwide-vacancy-context',
  built: '2026-07-05T15:10:41Z',
  build: 'v2-nationwide-9145-vacancy-context-api',
  pricing_tiers: 4,
};

const PLAN_LIMITS = { free: 1000, pro: 100000, all_access: 200000, business: 500000, admin: Infinity };

// Paid-plan metadata for key issuance + the activation success page.
const PLAN_META = {
  pro:        { prefix: 'gk_pro_', label: 'Pro',        stat: 'stat:pro_keys_issued' },
  all_access: { prefix: 'gk_all_', label: 'All Access', stat: 'stat:all_access_keys_issued' },
  business:   { prefix: 'gk_biz_', label: 'Business',   stat: 'stat:business_keys_issued' },
};
// Plan is detected from the paid amount (USD cents). $19/$49/$149 are distinct,
// so this is unambiguous without needing Stripe price IDs (the restricted key
// can't read them). If a future plan reuses an amount, add it here.
const AMOUNT_TO_PLAN = { 1900: 'pro', 4900: 'all_access', 14900: 'business' };

// Payment Links (Stripe). Pro is live; All Access / Business are placeholders the
// operator fills in after creating the links in Stripe (Phase 5 human task).
const PAYMENT_LINKS = {
  pro: 'https://buy.stripe.com/cNi6oHaKhaZp8mJ6Rh3Ru04',
  all_access: 'https://buy.stripe.com/6oU8wP05D2sTdH36Rh3Ru02',
  business: 'https://buy.stripe.com/3cIbJ18C9d7xdH30sT3Ru03',
};

const TOOLS = [
  {
    name: 'get_municipality_context',
    description:
      'Official Japanese government data for any municipality, one call — housing vacancy (2003–2023), ' +
      'nearest-station ridership trend, hazard categories, land prices, livability counts. ' +
      'No scores, no judgment — official values only. Accepts a 5-digit municipality code (13104) or an exact name (Shinjuku-ku / 新宿区).',
    inputSchema: {
      type: 'object',
      properties: {
        name_or_code: { type: 'string', description: '5-digit 全国地方公共団体コード (e.g. 13104) or exact municipality name (Shinjuku-ku / 新宿区).' },
        fields: { type: 'string', description: 'Optional comma-separated subset: vacancy,ridership,population,hazard,land_price,livability.' },
      },
      required: ['name_or_code'],
    },
  },
  {
    name: 'get_station_context',
    description:
      "Same official municipality data as get_municipality_context, resolved from a station: pass a Japan Station Master station_id (e.g. st_00001) and it returns the context for that station's municipality. Official values only — no scores.",
    inputSchema: {
      type: 'object',
      properties: {
        station_id: { type: 'string', description: 'Japan Station Master station_id (e.g. st_00001).' },
        fields: { type: 'string', description: 'Optional comma-separated subset: vacancy,ridership,population,hazard,land_price,livability.' },
      },
      required: ['station_id'],
    },
  },
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
  {
    name: 'get_station_hazard',
    description:
      'Official disaster-risk categories at a Japanese train station, relayed live from the MLIT ' +
      '不動産情報ライブラリ (Real Estate Information Library): flood inundation-depth rank, landform / ' +
      'liquefaction classification, and storm-surge inundation-area presence (landslide & tsunami are ' +
      'license-restricted and return available:false with a link to the official maps). ' +
      'Returns the official values/categories as-is — no composite score, no judgment. Accepts a station ' +
      'name in Japanese (新宿, 武蔵小杉) or romaji (Shinjuku, Musashi-Kosugi). For research/analytics; ' +
      'NOT a substitute for official government hazard maps or evacuation decisions.',
    argName: 'station_name',
    inputSchema: {
      type: 'object',
      properties: {
        station_name: {
          type: 'string',
          description: 'Station name in Japanese (新宿, 武蔵小杉) or romaji (Shinjuku, Musashi-Kosugi).',
        },
      },
      required: ['station_name'],
    },
  },
  {
    name: 'get_active_alerts',
    description:
      'Live river flood forecasts and landslide alerts for Japan (JMA official). ' +
      'NOT general weather warnings (storm/heavy rain/snow) and NOT earthquakes. Covers JMA ' +
      '指定河川洪水予報 (river flood forecast, levels 2–5) and 土砂災害警戒情報 (landslide warning), each with ' +
      'level, affected area, official summary and issue time. Optional `area` filters by 2-digit ' +
      'prefecture code (e.g. 13 = Tokyo) or a JMA forecast-area code. Relay of official facts — not a ' +
      'warning issued by this service, not a life-safety system.',
    inputSchema: {
      type: 'object',
      properties: { area: { type: 'string', description: 'Optional prefecture code (01–47, e.g. 13 = Tokyo) or JMA forecast-area code.' } },
    },
  },
  {
    name: 'get_station_alerts',
    description:
      "Live JMA river flood forecasts and landslide alerts affecting a station's prefecture — NOT general " +
      'weather warnings. Ask by station name in Japanese (新宿) or romaji (Shinjuku). Prefecture-level match ' +
      '(station master is Greater Tokyo). Relay of official JMA facts.',
    inputSchema: {
      type: 'object',
      properties: { station_name: { type: 'string', description: 'Station name in Japanese (新宿) or romaji (Shinjuku).' } },
      required: ['station_name'],
    },
  },
  {
    name: 'get_train_status',
    description:
      'Live train service status for Tokyo-area lines — delays, suspensions, resumptions. ' +
      "Ask 'is the Yamanote Line running?' by line or station name, English or Japanese. " +
      'Status enum: normal / delayed / suspended / resumed. Cause text relayed from ODPT (English summary ' +
      'for known patterns, else original text + null). Data via ODPT (CC BY 4.0).',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Line or station name (English or Japanese), e.g. "Yamanote" or "新宿".' } },
      required: ['query'],
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
function toiletNameEn(raw) {
  const n = raw || '';
  if (n.includes('多目的')) return 'Multipurpose Toilet';
  if (n.includes('多機能')) return 'Multifunction Toilet';
  return 'Accessible Toilet';
}
function toEnglishToilet(r) {
  return {
    name: toiletNameEn(r.name),
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

// ---- geohash nearby search (REST /v1/toilets/nearby) ---------------------
// geo:<geohash5> keys are an additive index built from the same koushu public-toilet
// data (build_kv_seed_geo.py); raw KV is untouched. A precision-5 cell is ~4.9km, so
// for a capped radius we only read the point's cell + its 8 neighbours (<=9 KV gets).
const GH_BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';
function geohashEncode(lat, lon, precision = 5) {
  let latLo = -90, latHi = 90, lonLo = -180, lonHi = 180;
  let gh = '', bits = 0, bit = 0, even = true;
  while (gh.length < precision) {
    if (even) {
      const mid = (lonLo + lonHi) / 2;
      if (lon >= mid) { bits = (bits << 1) | 1; lonLo = mid; } else { bits = bits << 1; lonHi = mid; }
    } else {
      const mid = (latLo + latHi) / 2;
      if (lat >= mid) { bits = (bits << 1) | 1; latLo = mid; } else { bits = bits << 1; latHi = mid; }
    }
    even = !even;
    if (++bit === 5) { gh += GH_BASE32[bits]; bits = 0; bit = 0; }
  }
  return gh;
}
const GH_NEIGHBORS = {
  n: ['p0r21436x8zb9dcf5h7kjnmqesgutwvy', 'bc01fg45238967deuvhjyznpkmstqrwx'],
  s: ['14365h7k9dcfesgujnmqp0r2twvyx8zb', '238967debc01fg45kmstqrwxuvhjyznp'],
  e: ['bc01fg45238967deuvhjyznpkmstqrwx', 'p0r21436x8zb9dcf5h7kjnmqesgutwvy'],
  w: ['238967debc01fg45kmstqrwxuvhjyznp', '14365h7k9dcfesgujnmqp0r2twvyx8zb'],
};
const GH_BORDERS = {
  n: ['prxz', 'bcfguvyz'], s: ['028b', '0145hjnp'],
  e: ['bcfguvyz', 'prxz'], w: ['0145hjnp', '028b'],
};
function geohashAdjacent(gh, dir) {
  gh = gh.toLowerCase();
  const last = gh.charAt(gh.length - 1);
  let base = gh.slice(0, -1);
  const type = gh.length % 2; // 0=even
  if (GH_BORDERS[dir][type].indexOf(last) !== -1 && base !== '') {
    base = geohashAdjacent(base, dir);
  }
  return base + GH_BASE32[GH_NEIGHBORS[dir][type].indexOf(last)];
}
function geohashNeighbors(gh) {
  const n = geohashAdjacent(gh, 'n'), s = geohashAdjacent(gh, 's');
  const e = geohashAdjacent(gh, 'e'), w = geohashAdjacent(gh, 'w');
  return [gh, n, s, e, w,
    geohashAdjacent(n, 'e'), geohashAdjacent(n, 'w'),
    geohashAdjacent(s, 'e'), geohashAdjacent(s, 'w')];
}
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000, toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
async function nearbyToilets(env, lat, lng, radius, filters) {
  const cells = geohashNeighbors(geohashEncode(lat, lng, 5));
  const gets = await Promise.all(cells.map((c) => env.TOILET_KV.get(`geo:${c}`, 'json')));
  const out = [];
  for (const cell of gets) {
    if (!cell) continue;
    for (const t of cell.toilets || []) {
      if (filters.wheelchair && !t.wheelchair) continue;
      if (filters.ostomate && !t.ostomate) continue;
      if (filters.diaper && !t.baby) continue; // koushu 'baby' = baby-changing seat
      const d = haversine(lat, lng, t.lat, t.lon);
      if (d <= radius) out.push({ ...t, distance_m: Math.round(d) });
    }
  }
  out.sort((a, b) => a.distance_m - b.distance_m);
  return out;
}
function toEnglishNearbyToilet(t) {
  return {
    name: t.name, addr: t.addr, lat: t.lat, lon: t.lon, distance_m: t.distance_m,
    wheelchair: !!t.wheelchair, baby: !!t.baby, ostomate: !!t.ostomate,
    hours: normHours(t.hours), city: t.city || null,
  };
}

// ---- Station hazard (live relay to MLIT 不動産情報ライブラリ / reinfolib) ------------
// Per-request passthrough: resolve station_id -> coords (sta:<id> in KV, seeded from the
// Japan Station Master), query the official MLIT reinfolib hazard layers AT THAT POINT, and
// return the OFFICIAL values/categories verbatim. No derived score (house policy: deliver
// official values as-is). Raw layer data is never stored or bulk-redistributed — every
// response is a fresh official lookup, so this is API usage, not dataset redistribution.
const REINFOLIB_BASE = 'https://www.reinfolib.mlit.go.jp/ex-api/external';
const HAZARD_ATTRIBUTION = {
  source: '国土交通省 不動産情報ライブラリ (MLIT Real Estate Information Library)',
  url: 'https://www.reinfolib.mlit.go.jp/',
  note: 'Official hazard-map values relayed as-is per request (point lookup by gachi-tokusuru.com). Not a government-created dataset — do not present as such.',
  terms: 'https://www.reinfolib.mlit.go.jp/help/termsOfUse/',
};
const HAZARD_DISCLAIMER =
  'For research & analytics only. This is NOT a substitute for official hazard maps and must NOT be the sole basis for safety or evacuation decisions. Always consult the government/municipal hazard maps at https://disaportal.gsi.go.jp/ . 防災・避難の判断には必ず自治体の公式ハザードマップをご確認ください。';
// Official 想定最大規模 inundation-depth ranks (国土数値情報 A31a_205).
const FLOOD_RANK_JA = {
  1: '0m以上0.5m未満', 2: '0.5m以上3.0m未満', 3: '3.0m以上5.0m未満',
  4: '5.0m以上10.0m未満', 5: '10.0m以上20.0m未満', 6: '20.0m以上',
};
const FLOOD_RANK_EN = {
  1: '< 0.5 m', 2: '0.5–3.0 m', 3: '3.0–5.0 m', 4: '5.0–10.0 m', 5: '10.0–20.0 m', 6: '≥ 20.0 m',
};

function hazTile(lat, lon, z) {
  const x = Math.floor(((lon + 180) / 360) * 2 ** z);
  const latRad = (lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * 2 ** z);
  return { x, y };
}
function ringContains(pt, ring) {
  let inside = false;
  const [x, y] = pt;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if (((yi > y) !== (yj > y)) && (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}
function polyContains(pt, geom) {
  if (!geom) return false;
  if (geom.type === 'Polygon') {
    return geom.coordinates.length > 0 && ringContains(pt, geom.coordinates[0]) && !geom.coordinates.slice(1).some((h) => ringContains(pt, h));
  }
  if (geom.type === 'MultiPolygon') {
    return geom.coordinates.some((poly) => ringContains(pt, poly[0]) && !poly.slice(1).some((h) => ringContains(pt, h)));
  }
  return false;
}
async function reinfoLayer(env, code, x, y) {
  const url = `${REINFOLIB_BASE}/${code}?response_format=geojson&z=14&x=${x}&y=${y}`;
  const res = await fetch(url, {
    headers: { 'Ocp-Apim-Subscription-Key': env.REINFOLIB_API_KEY },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`reinfolib ${code} HTTP ${res.status}`);
  return res.json();
}
const LAYER_META = {
  flood: '国土交通省 不動産情報ライブラリ XKT026 (洪水浸水想定区域・想定最大規模)',
  liquefaction: '国土交通省 不動産情報ライブラリ XKT025 (地形分類による液状化傾向図)',
  storm_surge: '国土交通省 不動産情報ライブラリ XKT027 (高潮浸水想定区域)',
};
const OFFICIAL_HAZARD_MAP = 'https://disaportal.gsi.go.jp/';

// --- per-layer parsers (official values only) ---
function parseFlood(data, pt) {
  // Keep only inundation polygons that contain the station point (point precision, not tile-max);
  // report the deepest official rank + the rivers those polygons belong to.
  const hits = (data.features || []).filter((f) => polyContains(pt, f.geometry));
  const rank = hits.length ? Math.max(0, ...hits.map((f) => Number(f.properties?.A31a_205) || 0)) : 0;
  const rivers = [...new Set(hits.map((f) => f.properties?.A31a_202).filter(Boolean))];
  return {
    inundation_expected: rank > 0,
    depth_rank: rank || null,
    depth_category: rank ? FLOOD_RANK_EN[rank] : 'none',
    depth_category_ja: rank ? FLOOD_RANK_JA[rank] : 'なし',
    rivers: rivers.length ? rivers : null,
    source: LAYER_META.flood,
  };
}
function parseLiquefaction(data, pt) {
  const hit = (data.features || []).find((f) => polyContains(pt, f.geometry));
  if (!hit) return { landform_ja: null, tendency_level: null, tendency_note_ja: null, note: 'no data at this point', source: LAYER_META.liquefaction };
  return {
    landform_ja: hit.properties?.topographic_classification_name_ja ?? null,
    tendency_level: Number(hit.properties?.liquefaction_tendency_level) || null,
    tendency_note_ja: hit.properties?.note ?? null,
    source: LAYER_META.liquefaction,
  };
}
function parseStormSurge(data) {
  return { inundation_area_present: (data.features || []).length > 0, source: LAYER_META.storm_surge };
}

// Per-layer KV cache: key `hazard:<station_id>:<type>`, 14-day TTL. Only successful upstream
// lookups are cached. attribution + disclaimer are re-attached at serve time (hazardFromRec),
// never stored in the cache, so they are always present — even on a cache hit.
const HAZARD_CACHE_TTL = 14 * 24 * 3600; // 14 days (seconds)
async function cachedLayer(env, sid, type, fetchParse) {
  const key = sid ? `hazard:${sid}:${type}` : null;
  if (key) {
    const cached = await env.TOILET_KV.get(key, 'json').catch(() => null);
    if (cached) return { ...cached, cached: true };
  }
  const val = await fetchParse(); // throws on upstream failure -> not cached
  if (key) await env.TOILET_KV.put(key, JSON.stringify(val), { expirationTtl: HAZARD_CACHE_TTL }).catch(() => {});
  return val;
}

// Landslide (XKT011) & tsunami (XKT028) source layers are 一部非商用 (commercial use restricted in
// some prefectures), so they are EXCLUDED from this paid API. Return a pointer to the official maps
// instead of the source value. Rationale: docs/hazard-license-check.md.
function excludedLayer(sourceLabel) {
  return {
    available: false,
    reason: 'Excluded from this API: the source layer is 一部非商用 (commercial use restricted in some prefectures), so it is not served through this paid endpoint.',
    official_map: OFFICIAL_HAZARD_MAP,
    source: sourceLabel,
  };
}

async function stationHazard(env, rec) {
  const sid = rec.id ?? null;
  const pt = [rec.lng, rec.lat];
  const { x, y } = hazTile(rec.lat, rec.lng, 14);
  // Only commercial-OK layers are fetched (flood / liquefaction / storm surge), each cached per
  // station+type. A per-layer upstream failure degrades to `unavailable` and is NOT cached.
  const guard = (type, fn) => cachedLayer(env, sid, type, fn).catch(() => ({ unavailable: true, note: 'hazard source lookup failed; try again later', source: LAYER_META[type] }));
  const [flood, liquefaction, storm_surge] = await Promise.all([
    guard('flood', async () => parseFlood(await reinfoLayer(env, 'XKT026', x, y), pt)),
    guard('liquefaction', async () => parseLiquefaction(await reinfoLayer(env, 'XKT025', x, y), pt)),
    guard('storm_surge', async () => parseStormSurge(await reinfoLayer(env, 'XKT027', x, y))),
  ]);
  return {
    flood,
    liquefaction,
    storm_surge,
    landslide: excludedLayer('国土交通省 不動産情報ライブラリ XKT011 (土砂災害警戒区域)'),
    tsunami: excludedLayer('国土交通省 不動産情報ライブラリ XKT028 (津波浸水想定)'),
  };
}

// Resolve a station record (with coords) from a station record whose lat/lng may be null,
// producing the final hazard payload. Shared by REST (by id) and MCP (by name).
async function hazardFromRec(env, rec) {
  const station = { id: rec.id ?? null, name: rec.n || null, name_ja: rec.nj || null };
  if (typeof rec.lat !== 'number' || typeof rec.lng !== 'number') {
    return { station, hazard: null, note: 'This station has no coordinates in the Japan Station Master, so a point hazard lookup is not available.', attribution: HAZARD_ATTRIBUTION };
  }
  const hazard = await stationHazard(env, rec);
  return { station: { ...station, lat: rec.lat, lng: rec.lng, pref: rec.pref || null }, hazard, disclaimer: HAZARD_DISCLAIMER, attribution: HAZARD_ATTRIBUTION };
}
// Resolve a station by name for the MCP tool: exact Japanese (name_ja) then normalized romaji.
async function resolveStationByName(env, name) {
  const raw = (name || '').trim();
  if (!raw) return null;
  let rec = await env.TOILET_KV.get(`hzn:${raw}`, 'json');
  if (rec) return rec;
  const n = raw.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (n) rec = await env.TOILET_KV.get(`hzn:${n}`, 'json');
  return rec || null;
}
// MCP get_station_hazard: name -> official hazard values (errors returned in-band, MCP-style).
async function hazardPayload(env, name) {
  if (!env.REINFOLIB_API_KEY) return { error: 'Hazard source is not configured.', attribution: HAZARD_ATTRIBUTION };
  const q = (name || '').trim();
  if (!q) return { error: 'station_name is required.', attribution: HAZARD_ATTRIBUTION };
  const rec = await resolveStationByName(env, q);
  if (!rec) return { error: `No station found for "${q}". Try Japanese (新宿) or romaji (Shinjuku, Musashi-Kosugi).`, attribution: HAZARD_ATTRIBUTION };
  try { return await hazardFromRec(env, rec); }
  catch (e) { return { error: `Hazard source lookup failed: ${e.message}`, attribution: HAZARD_ATTRIBUTION }; }
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

async function issuePaidKey(env, plan, { email, customer, session }) {
  const meta = PLAN_META[plan];
  const token = randToken(meta.prefix);
  const record = {
    plan, email, status: 'active',
    stripe_customer_id: customer || null,
    stripe_session_id: session || null,
    created: new Date().toISOString(),
  };
  await env.TOILET_KV.put(`key:${token}`, JSON.stringify(record));
  const c = parseInt((await env.TOILET_KV.get(meta.stat)) || '0', 10);
  await env.TOILET_KV.put(meta.stat, String(c + 1));
  return token;
}

// Verify a paid Stripe Checkout Session and issue the plan's key (idempotent per session).
// Plan is resolved from the paid amount (see AMOUNT_TO_PLAN). Works for Pro / All Access / Business.
// Email the freshly-issued key to the customer as a backup copy. Best-effort: never throws, and is
// a no-op unless RESEND_API_KEY is configured (so activation works with or without email). The
// /activate page stays the primary delivery. Idempotency is handled by the caller: this only runs
// on first issuance (a revisit hits the session cache and returns before reaching here).
async function sendKeyEmail(env, { email, plan, key }) {
  if (!env.RESEND_API_KEY || !email) return { sent: false, reason: 'disabled_or_no_email' };
  const from = env.MAIL_FROM || 'Gachi Data API <noreply@gachi-tokusuru.com>';
  const label = PLAN_META[plan]?.label || plan;
  const limit = (PLAN_LIMITS[plan] || 0).toLocaleString('en-US');
  const text =
    `You're on ${label} — thanks for subscribing to Gachi Data API.\n\n` +
    `Your API key (${limit} requests/month, works for both MCP and REST):\n\n` +
    `${key}\n\n` +
    `Keep it safe — treat it like a password. If you lose it, reopen the activation page you were ` +
    `redirected to after checkout (bookmark it) and it will show this same key.\n\n` +
    `First call:\n` +
    `  curl "https://api.gachi-tokusuru.com/v1/station-toilets/search?station=Shinjuku" -H "Authorization: Bearer ${key}"\n\n` +
    `Docs: https://api.gachi-tokusuru.com/docs\n` +
    `Manage or cancel: ${PORTAL_URL}\n` +
    `Questions? contact@gachi-tokusuru.com`;
  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from, to: [email], subject: `Your Gachi Data API key (${label})`, text }),
    });
    if (!resp.ok) console.log(`sendKeyEmail: resend HTTP ${resp.status}`);
    return { sent: resp.ok, status: resp.status };
  } catch (e) {
    console.log(`sendKeyEmail error: ${e.message}`);
    return { sent: false, reason: e.message };
  }
}

async function activate(env, sessionId) {
  const cached = await env.TOILET_KV.get(`session:${sessionId}`, 'json');
  if (cached) return { ok: true, ...cached }; // already activated → same key (no re-issue, no re-email)

  const resp = await fetch(
    `https://api.stripe.com/v1/checkout/sessions/${sessionId}?expand[]=line_items`,
    { headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` } },
  );
  if (!resp.ok) return { ok: false, reason: 'verify_failed' };
  const s = await resp.json();
  if (s.payment_status !== 'paid') return { ok: false, reason: 'not_paid' };

  // Resolve plan from the line-item amount (fall back to the session amount_total).
  const li = s.line_items?.data?.[0];
  const amount = li?.price?.unit_amount ?? li?.amount_total ?? s.amount_total;
  const plan = AMOUNT_TO_PLAN[amount];
  if (!plan) {
    console.log(`activate: unmapped amount ${amount} (session ${sessionId}) — add it to AMOUNT_TO_PLAN`);
    return { ok: false, reason: 'unknown_plan' };
  }

  const email = s.customer_details?.email || s.customer_email || '';
  const key = await issuePaidKey(env, plan, { email, customer: s.customer, session: sessionId });
  // Backup delivery by email — only here on first issuance, so it never re-sends on a revisit.
  const mail = await sendKeyEmail(env, { email, plan, key });
  const rec = { key, plan, email, emailed: !!mail.sent };
  await env.TOILET_KV.put(`session:${sessionId}`, JSON.stringify(rec));
  return { ok: true, ...rec };
}

function activatePage(body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Activate your API key</title>
<style>body{font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;max-width:640px;margin:40px auto;padding:0 20px;color:#1a1a1a}
code{background:#f6f8f7;border:1px solid #e3e8e6;border-radius:6px;padding:2px 6px;word-break:break-all}
.key{display:block;background:#eef6f2;border:1px solid #bfe6d5;border-radius:8px;padding:14px;font-family:ui-monospace,Menlo,monospace;margin:12px 0;word-break:break-all}
.mut{color:#666;font-size:14px}a{color:#0b6}
button{background:#0b6;color:#fff;border:0;border-radius:6px;padding:9px 16px;font:inherit;font-weight:600;cursor:pointer}
button:disabled{opacity:.7}</style></head><body>${body}</body></html>`;
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
      serverInfo: {
        name: 'gachi-japan-toilet-mcp',
        version: '0.3.0',
        description: "Deep, obscure Japanese data you won't find anywhere else — stations, accessibility, vacancy, hazards. Hand-verified, English-first, built for AI agents.",
      },
    });
  }
  if (method === 'notifications/initialized') return null;
  if (method === 'tools/list') {
    return rpcResult(id, { tools: TOOLS.map(({ prefix, argName, attribution, ...t }) => t) });
  }
  if (method === 'tools/call') {
    const tool = TOOLS.find((t) => t.name === params?.name);
    if (!tool) return rpcError(id, -32602, `unknown tool: ${params?.name}`);
    // Hazard tool: name -> coords -> live reinfolib relay (not a KV toilet lookup).
    if (tool.name === 'get_station_hazard') {
      const payload = await hazardPayload(env, params?.arguments?.station_name);
      return rpcResult(id, { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] });
    }
    // Realtime relays (KV snapshots written by the host pipelines).
    if (tool.name === 'get_active_alerts') {
      const payload = await activeAlertsPayload(env, (params?.arguments?.area || '').trim() || null);
      return rpcResult(id, { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] });
    }
    if (tool.name === 'get_station_alerts') {
      const payload = await stationAlertsPayload(env, params?.arguments?.station_name);
      return rpcResult(id, { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] });
    }
    if (tool.name === 'get_train_status') {
      const payload = await trainStatusPayload(env, params?.arguments?.query);
      return rpcResult(id, { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] });
    }
    // Municipality Context API (Akiya Stage 2): official municipality data in one call.
    if (tool.name === 'get_municipality_context' || tool.name === 'get_station_context') {
      const a = params?.arguments || {};
      const fields = parseCtxFields(a.fields);
      const payload = tool.name === 'get_station_context'
        ? await stationContextPayload(env, (a.station_id || '').trim(), fields)
        : await municipalityContextByNameOrCode(env, (a.name_or_code || '').trim(), fields);
      return rpcResult(id, { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] });
    }
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

const UPGRADE_URL = 'https://api.gachi-tokusuru.com'; // landing page with pricing
const PORTAL_URL = 'https://billing.stripe.com/p/login/00w9ATg4B5F5byV2B13Ru00'; // self-serve manage/cancel
const DOCS_URL = 'https://api.gachi-tokusuru.com/docs';

// Open Datasets (free, citable) — surfaced on the LP and in llms.txt.
const DATASETS = {
  github: 'https://github.com/eng213035/gachi-open-datasets',
  zenodo_doi: '10.5281/zenodo.21199500',
  zenodo_url: 'https://doi.org/10.5281/zenodo.21199500',
  kaggle: 'https://www.kaggle.com/datasets/takufujii/japan-station-master-and-ridership-2000-2025-tokyo',
};

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'Authorization, Content-Type',
  'access-control-max-age': '86400',
};

// REST error envelope (uniform shape, per spec).
function restError(code, message, status, extraHeaders = {}) {
  return Response.json(
    { error: code, message, docs: DOCS_URL },
    { status, headers: { ...CORS, ...extraHeaders } },
  );
}
function restJson(payload) {
  return Response.json(payload, { headers: { ...CORS } });
}

// ---- Realtime layer (JMA alerts + ODPT train status) ---------------------
// Relayed from official feeds; the one thing you can't cache. Host pipelines write
// fresh snapshots into KV (alerts:active, train:status:_all) with a `fetched_at`;
// the Worker never returns stale data with a fresh face — it flags `stale` when the
// snapshot is older than the poll cadence allows, or 503s when the key is missing.
const ALERTS_MAX_AGE_S = 1500; // JMA pipeline runs every 10 min → stale after 25 min
const TRAIN_MAX_AGE_S = 600;   // ODPT poller runs every ~3 min → stale after 10 min

const JMA_DISCLAIMER =
  'Source: Japan Meteorological Agency. Relayed as published — not a warning issued by ' +
  'this service. For evacuation decisions always follow official municipal guidance. ' +
  'Best-effort relay, not a life-safety system.';
const JMA_ATTR = { source: 'Japan Meteorological Agency (気象庁)', official_url: 'https://www.jma.go.jp/bosai/' };
// What this feed DOES cover — stated in every alert response so callers never assume
// it is general weather warnings. It is NOT general weather warnings (storm / heavy
// rain / snow) and NOT earthquakes; those are out of scope (see /docs).
const ALERTS_COVERAGE = ['river_flood_forecast (JMA levels 2-5)', 'landslide_warning'];
const ODPT_ATTR = {
  source: 'Public Transportation Open Data Center (ODPT)',
  provider: 'Association for Open Data of Public Transportation',
  license: 'CC BY 4.0',
};

// English prefecture name (station master) → 2-digit code, for prefecture-level
// station↔alert matching. Full 47 so it also works if coverage widens past Kanto.
const PREF_EN_CODE = {
  Hokkaido:'01',Aomori:'02',Iwate:'03',Miyagi:'04',Akita:'05',Yamagata:'06',Fukushima:'07',
  Ibaraki:'08',Tochigi:'09',Gunma:'10',Saitama:'11',Chiba:'12',Tokyo:'13',Kanagawa:'14',
  Niigata:'15',Toyama:'16',Ishikawa:'17',Fukui:'18',Yamanashi:'19',Nagano:'20',Gifu:'21',
  Shizuoka:'22',Aichi:'23',Mie:'24',Shiga:'25',Kyoto:'26',Osaka:'27',Hyogo:'28',Nara:'29',
  Wakayama:'30',Tottori:'31',Shimane:'32',Okayama:'33',Hiroshima:'34',Yamaguchi:'35',
  Tokushima:'36',Kagawa:'37',Ehime:'38',Kochi:'39',Fukuoka:'40',Saga:'41',Nagasaki:'42',
  Kumamoto:'43',Oita:'44',Miyazaki:'45',Kagoshima:'46',Okinawa:'47',
};

// Read a realtime KV snapshot with a freshness verdict. { missing } if absent.
async function readRealtime(env, key, maxAgeSec) {
  const data = await env.TOILET_KV.get(key, 'json');
  if (!data) return { missing: true };
  const t = data.fetched_at ? Date.parse(data.fetched_at) : NaN;
  const ageSec = Number.isFinite(t) ? (Date.now() - t) / 1000 : Infinity;
  return { data, fetched_at: data.fetched_at || null, stale: ageSec > maxAgeSec, age_sec: Math.round(ageSec) };
}

// MCP payload builders (shared shape with the REST routes).
async function activeAlertsPayload(env, area) {
  const r = await readRealtime(env, 'alerts:active', ALERTS_MAX_AGE_S);
  if (r.missing) return { error: 'Alert feed is not initialized yet.', attribution: JMA_ATTR };
  let alerts = r.data.alerts || [];
  if (area) alerts = alerts.filter((a) => a.area_code === area || a.pref_code === area);
  return { coverage: ALERTS_COVERAGE, fetched_at: r.fetched_at, stale: r.stale, count: alerts.length, alerts, source: JMA_ATTR.source, attribution: JMA_ATTR, disclaimer: JMA_DISCLAIMER };
}
async function stationAlertsPayload(env, name) {
  const rec = name ? await resolveStationByName(env, name) : null;
  if (!rec) return { error: `No station matched "${name}".`, attribution: JMA_ATTR };
  const prefCode = PREF_EN_CODE[rec.pref] || null;
  const r = await readRealtime(env, 'alerts:active', ALERTS_MAX_AGE_S);
  if (r.missing) return { error: 'Alert feed is not initialized yet.', attribution: JMA_ATTR };
  const alerts = prefCode ? (r.data.alerts || []).filter((a) => a.pref_code === prefCode) : [];
  return { station: { name: rec.n, name_ja: rec.nj, pref: rec.pref || null }, match: 'prefecture-level', coverage: ALERTS_COVERAGE, fetched_at: r.fetched_at, stale: r.stale, count: alerts.length, alerts, source: JMA_ATTR.source, attribution: JMA_ATTR, disclaimer: JMA_DISCLAIMER };
}
async function trainStatusPayload(env, query) {
  const r = await readRealtime(env, 'train:status:_all', TRAIN_MAX_AGE_S);
  if (r.missing) return { error: 'Train status feed is not initialized yet.', attribution: ODPT_ATTR };
  const lines = r.data.lines || {};
  const raw = (query || '').trim();
  if (!raw) return { error: 'query required', attribution: ODPT_ATTR };
  const q = raw.toLowerCase();
  const lineMatches = Object.values(lines).filter((l) =>
    (l.line_en && l.line_en.toLowerCase().includes(q)) || (l.line_ja && l.line_ja.includes(raw)));
  if (lineMatches.length) return { query: raw, fetched_at: r.fetched_at, stale: r.stale, count: lineMatches.length, lines: lineMatches, attribution: ODPT_ATTR };
  const rec = await resolveStationByName(env, raw);
  if (rec) {
    const ids = await env.TOILET_KV.get(`stalines:${rec.id}`, 'json');
    if (ids) {
      const sl = ids.map((id) => lines[id]).filter(Boolean);
      return { query: raw, station: { name: rec.n, name_ja: rec.nj }, fetched_at: r.fetched_at, stale: r.stale, count: sl.length, lines: sl, attribution: ODPT_ATTR };
    }
  }
  return { query: raw, count: 0, lines: [], note: 'No line or station matched.', attribution: ODPT_ATTR };
}

// Auth + shared metering for REST (same key + same monthly counter as MCP).
async function restAuthAndMeter(request, env) {
  const auth = await resolveAuth(request, env);
  if (!auth.ok) {
    return { error: restError('unauthorized', `Missing or invalid API key. Get a free key at ${UPGRADE_URL}`, 401) };
  }
  const m = await meterUsage(env, auth.token, auth.plan);
  if (!m.allowed) {
    return {
      error: restError(
        'rate_limit_exceeded',
        `Monthly limit reached (${m.used}/${m.limit} on ${auth.plan}). Upgrade: ${UPGRADE_URL}`,
        429,
        { 'retry-after': '3600' },
      ),
    };
  }
  return { ok: true, auth };
}

// ============ Municipality Context API (Akiya Stage 2) ============
// One call: official Japanese government data for a municipality (or a station's
// municipality) — housing vacancy (own dataset), nearest-station ridership (own),
// future population / hazard / land price (live MLIT reinfolib relay), livability
// facility counts (own KV, precomputed). Official values + arithmetic derivations
// ONLY — no synthetic scores, no judgment words (STRATEGY-AKIYA).
const CTX_FIELDS = ['vacancy', 'ridership', 'population', 'hazard', 'land_price', 'livability'];
const VACANCY_ATTR = { source: 'Housing and Land Survey (Statistics Bureau of Japan) via e-Stat', note: 'Official counts verbatim; vacancy_rate is computed (vacant_total/total_dwellings).', url: 'https://www.e-stat.go.jp/' };
const RIDERSHIP_ATTR = { source: 'Public Transportation Open Data Center (ODPT)', note: 'Annual passenger journeys; change_* are arithmetic derivations.', url: 'https://www.odpt.org/' };
const POP_ATTR = { source: '国土交通省 不動産情報ライブラリ XKT013 (将来推計人口メッシュ)', note: 'Future-population mesh relayed per request; change is arithmetic.', url: 'https://www.reinfolib.mlit.go.jp/' };
const LANDPRICE_ATTR = { source: '国土交通省 不動産情報ライブラリ XPT002 (地価公示)', note: 'Official published land prices within 1 km of the centroid; averages are arithmetic.', url: 'https://www.reinfolib.mlit.go.jp/' };
const BUSSTOP_ATTR = { source: '国土交通省 国土数値情報 P11 (バス停留所)', note: 'Bus stops within 1 km of the municipality centroid — density near the town centre, not whole-municipality coverage.', url: 'https://nlftp.mlit.go.jp/ksj/' };

function ctxDist(la1, lo1, la2, lo2) {
  const R = 6371000, r = Math.PI / 180;
  const dp = (la2 - la1) * r, dl = (lo2 - lo1) * r;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(la1 * r) * Math.cos(la2 * r) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
function parsePopulation(data, lat, lng) {
  const feats = (data.features || []).filter((f) => { const c = f.geometry?.coordinates?.[0]?.[0]; if (!c) return true; return ctxDist(lat, lng, c[1], c[0]) <= 600; });
  if (!feats.length) return { available: false, note: 'no population mesh at this point', source: POP_ATTR.source };
  const sum = (k) => feats.reduce((s, f) => s + (parseFloat(f.properties?.[k]) || 0), 0);
  const p25 = Math.round(sum('PT00_2025')), p50 = Math.round(sum('PT00_2050')), p70 = Math.round(sum('PT00_2070'));
  return { total_2025: p25, total_2050: p50, total_2070: p70, change_2025_2050_pct: p25 > 0 ? Math.round((p50 - p25) / p25 * 1000) / 10 : null, source: POP_ATTR.source };
}
function parseLandPrice(data, lat, lng, year) {
  const price = (f) => { const m = (f.properties?.u_current_years_price_ja || '').replace(/,/g, '').match(/\d+/); return m ? parseInt(m[0], 10) : 0; };
  const feats = (data.features || []).filter((f) => { const c = f.geometry?.coordinates; return c && ctxDist(lat, lng, c[1], c[0]) <= 1000; });
  const avg = (a) => (a.length ? Math.round(a.reduce((s, v) => s + v, 0) / a.length) : null);
  const resid = feats.filter((f) => (f.properties?.use_category_name_ja || '').includes('住宅')).map(price).filter((p) => p > 0);
  const all = feats.map(price).filter((p) => p > 0);
  if (!all.length) return { available: false, year, note: 'no land-price sample within 1 km of the centroid', source: LANDPRICE_ATTR.source };
  return { year, unit: 'JPY/m2', residential_avg: avg(resid), residential_samples: resid.length, all_avg: avg(all), all_samples: all.length, source: LANDPRICE_ATTR.source };
}

async function resolveMuniByCode(env, code) {
  const muni = await env.TOILET_KV.get(`muni:${code}`, 'json');
  if (muni) return { muni };
  const xw = await env.TOILET_KV.get(`munixwalk:${code}`, 'json');
  if (xw) {
    const nm = await env.TOILET_KV.get(`muni:${xw.new_code}`, 'json');
    if (nm) return { muni: nm, merged: { requested_code: code, merged_into: xw.new_code, merged_into_name: xw.new_name, merged_year: xw.merged_year } };
    return { mergedError: xw };
  }
  return {};
}

async function buildContext(env, muni, fields) {
  const want = (f) => !fields || fields.has(f);
  const lat = muni.lat, lng = muni.lng, hasCoord = typeof lat === 'number' && typeof lng === 'number';
  const out = { municipality: { code: muni.code, name: muni.name, name_ja: muni.name_ja, name_kana: muni.name_kana || null, pref: muni.pref, lat: hasCoord ? lat : null, lng: hasCoord ? lng : null } };
  const attribution = [];
  if (want('vacancy')) {
    const years = Object.keys(muni.vacancy || {});
    out.vacancy = years.length ? { series: muni.vacancy, source: VACANCY_ATTR.source } : { available: false, note: 'not tabulated in the Housing and Land Survey (sample survey; small municipalities are not broken out every year)', source: VACANCY_ATTR.source };
    if (years.length) attribution.push(VACANCY_ATTR);
  }
  if (want('ridership')) {
    if (muni.nearest_station_id) {
      const rr = await env.TOILET_KV.get(`muniridership:${muni.nearest_station_id}`, 'json');
      out.ridership = rr
        ? { via_station: muni.nearest_station_id, station_distance_km: muni.station_distance_km, operators: rr.operators, source: RIDERSHIP_ATTR.source }
        : { available: false, via_station: muni.nearest_station_id, station_distance_km: muni.station_distance_km, note: 'nearest station has no ridership series (ridership currently covers Greater Tokyo)' };
      if (rr) attribution.push(RIDERSHIP_ATTR);
    } else {
      out.ridership = { available: false, note: 'no station within 30 km of this municipality, so there is no nearest-station ridership' };
    }
  }
  const key = env.REINFOLIB_API_KEY;
  const tile = hasCoord ? hazTile(lat, lng, 14) : null;
  if (want('population')) {
    if (hasCoord && key) { out.population = await cachedLayer(env, `muni_${muni.code}`, 'population', async () => parsePopulation(await reinfoLayer(env, 'XKT013', tile.x, tile.y), lat, lng)).catch(() => ({ available: false, note: 'population source lookup failed; try again later', source: POP_ATTR.source })); attribution.push(POP_ATTR); }
    else out.population = { available: false, note: key ? 'no coordinates for this municipality' : 'population source is not configured', source: POP_ATTR.source };
  }
  if (want('hazard')) {
    if (hasCoord && key) { out.hazard = await stationHazard(env, { id: `muni_${muni.code}`, lat, lng, pref: muni.pref }); out.hazard_disclaimer = HAZARD_DISCLAIMER; attribution.push(HAZARD_ATTRIBUTION); }
    else out.hazard = { available: false, note: key ? 'no coordinates for this municipality' : 'hazard source is not configured' };
  }
  if (want('land_price')) {
    if (hasCoord && key) { out.land_price = await cachedLayer(env, `muni_${muni.code}`, 'land_price', async () => parseLandPrice(await reinfoLayer(env, 'XPT002', tile.x, tile.y), lat, lng, 2024)).catch(() => ({ available: false, note: 'land-price source lookup failed; try again later', source: LANDPRICE_ATTR.source })); attribution.push(LANDPRICE_ATTR); }
    else out.land_price = { available: false, note: key ? 'no coordinates for this municipality' : 'land-price source is not configured', source: LANDPRICE_ATTR.source };
  }
  if (want('livability')) {
    const t = muni.livability?.transit || {};
    out.livability = { transit: { nearest_station_km: t.nearest_station_km ?? null, bus_stops_within_1km: t.bus_stops_within_1km ?? null, bus_stops_basis: 'count within 1 km of the municipality centroid (representative point) — density near the town centre, not whole-municipality coverage' } };
    if (t.bus_stops_within_1km != null) attribution.push(BUSSTOP_ATTR);
  }
  const seen = new Set();
  out.attribution = attribution.filter((a) => !seen.has(a.source) && seen.add(a.source));
  return out;
}

function parseCtxFields(raw) {
  const s = (raw || '').trim();
  if (!s) return null;
  const set = new Set(s.split(',').map((x) => x.trim()).filter((f) => CTX_FIELDS.includes(f)));
  return set.size ? set : null;
}

// Free = 1 municipality/day (ctxday:<token>:<yyyymmdd>); Pro+ = normal monthly metering.
async function ctxAuthAndGate(request, env) {
  const auth = await resolveAuth(request, env);
  if (!auth.ok) return { error: restError('unauthorized', `Missing or invalid API key. Get a free key at ${UPGRADE_URL}`, 401) };
  if (auth.plan === 'free') {
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const k = `ctxday:${auth.token}:${day}`;
    const used = parseInt((await env.TOILET_KV.get(k)) || '0', 10);
    if (used >= 1) return { error: restError('rate_limit_exceeded', `Context API preview is 1 municipality/day on Free — upgrade for unlimited: ${UPGRADE_URL}`, 429, { 'retry-after': '86400' }) };
    await env.TOILET_KV.put(k, String(used + 1), { expirationTtl: 172800 });
  }
  const m = await meterUsage(env, auth.token, auth.plan);
  if (!m.allowed) return { error: restError('rate_limit_exceeded', `Monthly limit reached (${m.used}/${m.limit} on ${auth.plan}). Upgrade: ${UPGRADE_URL}`, 429, { 'retry-after': '3600' }) };
  return { ok: true, auth };
}

async function municipalityContextPayload(env, code, fields) {
  const r = await resolveMuniByCode(env, code);
  if (r.mergedError) return { error: `Municipality ${code} was dissolved (merged into ${r.mergedError.new_code} ${r.mergedError.new_name} in ${r.mergedError.merged_year}) and the successor is not in the current master.`, merged_into: r.mergedError.new_code };
  if (!r.muni) return { error: `Unknown municipality_code "${code}". Use a 5-digit 全国地方公共団体コード (e.g. 13104 for Shinjuku-ku).` };
  const ctx = await buildContext(env, r.muni, fields);
  if (r.merged) ctx.resolved_from = r.merged;
  return ctx;
}
async function municipalityContextByNameOrCode(env, q, fields) {
  const s = (q || '').trim();
  if (!s) return { error: 'name_or_code is required (e.g. 13104 or Shinjuku-ku or 新宿区).' };
  if (/^\d{5}$/.test(s)) return municipalityContextPayload(env, s, fields);
  let code = await env.TOILET_KV.get(`muniname:${s}`);
  if (!code) { const n = s.toLowerCase().replace(/[^a-z0-9]/g, ''); if (n) code = await env.TOILET_KV.get(`muniname:${n}`); }
  if (!code) return { error: `No municipality found for "${s}". Try a 5-digit code (13104) or an exact name (Shinjuku-ku / 新宿区).` };
  return municipalityContextPayload(env, code, fields);
}
async function stationContextPayload(env, stationId, fields) {
  const sid = (stationId || '').trim();
  const code = sid ? await env.TOILET_KV.get(`stamuni:${sid}`) : null;
  if (!code) return { error: `Unknown station_id "${sid}" (Japan Station Master, e.g. st_00001), or it has no coordinates to resolve a municipality.` };
  const sta = await env.TOILET_KV.get(`sta:${sid}`, 'json');
  const ctx = await municipalityContextPayload(env, code, fields);
  if (!ctx.error) ctx.resolved_via_station = { station_id: sid, name: sta?.n || null, name_ja: sta?.nj || null };
  return ctx;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS preflight for the REST API
    if (request.method === 'OPTIONS' && url.pathname.startsWith('/v1/')) {
      return new Response(null, { status: 204, headers: CORS });
    }

    // Build probe — cache-proof way to confirm which Worker version answered this request.
    if (request.method === 'GET' && url.pathname === '/__version') {
      return Response.json(
        { ...BUILD_VERSION, colo: request.cf?.colo ?? null, served_by: 'gachi-toilet-mcp' },
        { headers: { 'cache-control': 'no-cache, must-revalidate', ...CORS } },
      );
    }

    // ---- REST v1 (thin layer over the same internal functions + i18n as MCP) ----

    // Live hazard relay: official MLIT hazard values/categories at a station's location.
    // No derived score (house policy). station_id comes from the Japan Station Master (st_00001).
    const hazMatch = url.pathname.match(/^\/v1\/stations\/([^/]+)\/hazard$/);
    if (request.method === 'GET' && hazMatch) {
      const gate = await restAuthAndMeter(request, env);
      if (gate.error) return gate.error;
      if (!env.REINFOLIB_API_KEY) return restError('unavailable', 'Hazard source is not configured.', 503);
      const stationId = decodeURIComponent(hazMatch[1]);
      const rec = await env.TOILET_KV.get(`sta:${stationId}`, 'json');
      if (!rec) return restError('not_found', `Unknown station_id "${stationId}". IDs come from the Japan Station Master (e.g. st_00001).`, 404);
      rec.id = stationId;
      let payload;
      try { payload = await hazardFromRec(env, rec); }
      catch (e) { return restError('upstream_error', `Hazard source lookup failed: ${e.message}`, 502); }
      return restJson(payload);
    }

    // ---- Municipality Context API (Akiya Stage 2): official values, one call, no scores ----
    const muniCtxMatch = url.pathname.match(/^\/v1\/municipalities\/([^/]+)\/context$/);
    if (request.method === 'GET' && muniCtxMatch) {
      const gate = await ctxAuthAndGate(request, env);
      if (gate.error) return gate.error;
      const payload = await municipalityContextByNameOrCode(env, decodeURIComponent(muniCtxMatch[1]), parseCtxFields(url.searchParams.get('fields')));
      if (payload.error) return restError(payload.merged_into ? 'gone' : 'not_found', payload.error, payload.merged_into ? 410 : 404);
      return restJson(payload);
    }
    const staCtxMatch = url.pathname.match(/^\/v1\/stations\/([^/]+)\/context$/);
    if (request.method === 'GET' && staCtxMatch) {
      const gate = await ctxAuthAndGate(request, env);
      if (gate.error) return gate.error;
      const payload = await stationContextPayload(env, decodeURIComponent(staCtxMatch[1]), parseCtxFields(url.searchParams.get('fields')));
      if (payload.error) return restError('not_found', payload.error, 404);
      return restJson(payload);
    }

    if (request.method === 'GET' && url.pathname === '/v1/station-toilets/search') {
      const gate = await restAuthAndMeter(request, env);
      if (gate.error) return gate.error;
      const station = (url.searchParams.get('station') || '').trim();
      if (!station) return restError('bad_request', 'Query param "station" is required (e.g. ?station=Shinjuku or ?station=新宿).', 400);
      const tool = TOOLS.find((t) => t.name === 'get_toilet_by_station');
      const found = await lookup(env, tool.prefix, station);
      if (!found) return restError('not_found', `No station toilet data for "${station}".`, 404);
      return restJson({ ...(await toEnglishStation(env, found)), attribution: tool.attribution });
    }

    if (request.method === 'GET' && url.pathname === '/v1/toilets/nearby') {
      const gate = await restAuthAndMeter(request, env);
      if (gate.error) return gate.error;
      const lat = parseFloat(url.searchParams.get('lat'));
      const lng = parseFloat(url.searchParams.get('lng'));
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
        return restError('bad_request', 'Valid "lat" and "lng" query params are required.', 400);
      }
      let radius = parseInt(url.searchParams.get('radius') || '800', 10);
      if (!Number.isFinite(radius) || radius <= 0) radius = 800;
      radius = Math.min(radius, 2000); // capped so a fixed 9-cell geohash read fully covers the circle
      const filters = {
        wheelchair: url.searchParams.get('wheelchair') === 'true',
        ostomate: url.searchParams.get('ostomate') === 'true',
        diaper: url.searchParams.get('diaper') === 'true',
      };
      const found = await nearbyToilets(env, lat, lng, radius, filters);
      const capped = found.slice(0, 50);
      return restJson({
        query: { lat, lng, radius_m: radius, ...filters },
        count: capped.length,
        toilets: capped.map(toEnglishNearbyToilet),
        attribution: TOOLS.find((t) => t.name === 'get_public_toilet_by_city').attribution,
      });
    }

    // ---- Realtime: JMA alerts (relay of official published alerts) ----
    if (request.method === 'GET' && url.pathname === '/v1/alerts/active') {
      const gate = await restAuthAndMeter(request, env);
      if (gate.error) return gate.error;
      const r = await readRealtime(env, 'alerts:active', ALERTS_MAX_AGE_S);
      if (r.missing) return restError('unavailable', 'Alert feed is not initialized yet.', 503);
      return restJson({
        coverage: ALERTS_COVERAGE,
        fetched_at: r.fetched_at, stale: r.stale, count: r.data.count ?? r.data.alerts?.length ?? 0,
        alerts: r.data.alerts || [], source: JMA_ATTR.source, attribution: JMA_ATTR, disclaimer: JMA_DISCLAIMER,
      });
    }
    const alertAreaMatch = url.pathname.match(/^\/v1\/alerts\/area\/([^/]+)$/);
    if (request.method === 'GET' && alertAreaMatch) {
      const gate = await restAuthAndMeter(request, env);
      if (gate.error) return gate.error;
      const code = decodeURIComponent(alertAreaMatch[1]);
      const r = await readRealtime(env, 'alerts:active', ALERTS_MAX_AGE_S);
      if (r.missing) return restError('unavailable', 'Alert feed is not initialized yet.', 503);
      // Match either a JMA forecast-area code or a 2-digit prefecture code.
      const alerts = (r.data.alerts || []).filter((a) => a.area_code === code || a.pref_code === code);
      return restJson({
        area_code: code, coverage: ALERTS_COVERAGE, fetched_at: r.fetched_at, stale: r.stale, count: alerts.length,
        alerts, source: JMA_ATTR.source, attribution: JMA_ATTR, disclaimer: JMA_DISCLAIMER,
      });
    }
    const stationAlertsMatch = url.pathname.match(/^\/v1\/stations\/([^/]+)\/alerts$/);
    if (request.method === 'GET' && stationAlertsMatch) {
      const gate = await restAuthAndMeter(request, env);
      if (gate.error) return gate.error;
      const stationId = decodeURIComponent(stationAlertsMatch[1]);
      const sta = await env.TOILET_KV.get(`sta:${stationId}`, 'json');
      if (!sta) return restError('not_found', `Unknown station_id "${stationId}" (Japan Station Master, e.g. st_00001).`, 404);
      const prefCode = PREF_EN_CODE[sta.pref] || null;
      const r = await readRealtime(env, 'alerts:active', ALERTS_MAX_AGE_S);
      if (r.missing) return restError('unavailable', 'Alert feed is not initialized yet.', 503);
      const alerts = prefCode ? (r.data.alerts || []).filter((a) => a.pref_code === prefCode) : [];
      return restJson({
        station: { station_id: stationId, name: sta.n, name_ja: sta.nj, pref: sta.pref || null },
        match: 'prefecture-level (station master is Greater Tokyo; precise area-level matching is planned)',
        coverage: ALERTS_COVERAGE,
        fetched_at: r.fetched_at, stale: r.stale, count: alerts.length, alerts,
        source: JMA_ATTR.source, attribution: JMA_ATTR, disclaimer: JMA_DISCLAIMER,
      });
    }

    // ---- Realtime: ODPT train service status ----
    if (request.method === 'GET' && url.pathname === '/v1/lines/status') {
      const gate = await restAuthAndMeter(request, env);
      if (gate.error) return gate.error;
      const r = await readRealtime(env, 'train:status:_all', TRAIN_MAX_AGE_S);
      if (r.missing) return restError('unavailable', 'Train status feed is not initialized yet.', 503);
      const lines = Object.values(r.data.lines || {});
      return restJson({
        fetched_at: r.fetched_at, stale: r.stale, count: lines.length, lines, attribution: ODPT_ATTR,
      });
    }
    const lineStatusMatch = url.pathname.match(/^\/v1\/lines\/([^/]+)\/status$/);
    if (request.method === 'GET' && lineStatusMatch) {
      const gate = await restAuthAndMeter(request, env);
      if (gate.error) return gate.error;
      const lineId = decodeURIComponent(lineStatusMatch[1]);
      const r = await readRealtime(env, 'train:status:_all', TRAIN_MAX_AGE_S);
      if (r.missing) return restError('unavailable', 'Train status feed is not initialized yet.', 503);
      const one = (r.data.lines || {})[lineId];
      if (!one) return restError('not_found', `Unknown line_id "${lineId}" (e.g. odpt.Railway:JR-East.Yamanote).`, 404);
      return restJson({ fetched_at: r.fetched_at, stale: r.stale, line: one, attribution: ODPT_ATTR });
    }
    const stationLinesMatch = url.pathname.match(/^\/v1\/stations\/([^/]+)\/lines\/status$/);
    if (request.method === 'GET' && stationLinesMatch) {
      const gate = await restAuthAndMeter(request, env);
      if (gate.error) return gate.error;
      const stationId = decodeURIComponent(stationLinesMatch[1]);
      const lineIds = await env.TOILET_KV.get(`stalines:${stationId}`, 'json');
      if (!lineIds) return restError('not_found', `Unknown station_id "${stationId}" or no lines mapped.`, 404);
      const r = await readRealtime(env, 'train:status:_all', TRAIN_MAX_AGE_S);
      if (r.missing) return restError('unavailable', 'Train status feed is not initialized yet.', 503);
      const lines = lineIds.map((id) => (r.data.lines || {})[id]).filter(Boolean);
      return restJson({
        station: { station_id: stationId }, fetched_at: r.fetched_at, stale: r.stale,
        count: lines.length, lines, attribution: ODPT_ATTR,
      });
    }

    // OpenAPI spec + a tiny docs page pointing at it
    if (request.method === 'GET' && url.pathname === '/openapi.yaml') {
      return new Response(OPENAPI_YAML, { headers: { 'content-type': 'application/yaml; charset=utf-8', ...CORS } });
    }
    if (request.method === 'GET' && url.pathname === '/docs') {
      return new Response(DOCS_HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    }

    // llms.txt — sign-post for agents (project summary, endpoints, datasets, license)
    if (request.method === 'GET' && url.pathname === '/llms.txt') {
      return new Response(LLMS_TXT, { headers: { 'content-type': 'text/plain; charset=utf-8', ...CORS } });
    }

    // Landing page. no-cache so browsers/edge always revalidate — the page is a
    // small dynamic Worker response and must never show a stale pricing table.
    if (request.method === 'GET' && url.pathname === '/') {
      return new Response(LANDING_HTML, {
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache, must-revalidate' },
      });
    }

    if (request.method === 'GET' && url.pathname === '/robots.txt') {
      return new Response(
        'User-agent: *\nAllow: /\nSitemap: https://api.gachi-tokusuru.com/sitemap.xml\n',
        { headers: { 'content-type': 'text/plain; charset=utf-8' } },
      );
    }

    if (request.method === 'GET' && url.pathname === '/sitemap.xml') {
      return new Response(
        '<?xml version="1.0" encoding="UTF-8"?>\n' +
          '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
          '  <url><loc>https://api.gachi-tokusuru.com/</loc></url>\n' +
          '  <url><loc>https://api.gachi-tokusuru.com/docs</loc></url>\n' +
          '</urlset>\n',
        { headers: { 'content-type': 'application/xml; charset=utf-8' } },
      );
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

    // No-auth LIVE demos of the realtime layer (real data, trimmed). Rate-protected
    // by a 60s edge cache (Cache-Control) so anonymous traffic can't hammer the Worker.
    if (request.method === 'GET' && url.pathname === '/example/train-status') {
      const demoHeaders = { 'access-control-allow-origin': '*', 'cache-control': 'public, max-age=60' };
      const r = await readRealtime(env, 'train:status:_all', TRAIN_MAX_AGE_S);
      if (r.missing) {
        return Response.json({ note: 'Live demo of /v1/lines/status — the train feed is initializing, check back shortly.', lines: [], attribution: ODPT_ATTR }, { headers: demoHeaders });
      }
      const lines = r.data.lines || {};
      const all = Object.values(lines);
      const nonNormal = all.filter((l) => l.status !== 'normal').slice(0, 4); // disruptions first
      const majors = ['odpt.Railway:JR-East.Yamanote', 'odpt.Railway:TokyoMetro.Marunouchi', 'odpt.Railway:JR-East.ChuoRapid', 'odpt.Railway:TokyoMetro.Ginza', 'odpt.Railway:Toei.Oedo'];
      const pick = [];
      const add = (l) => { if (l && !pick.some((p) => p.line_id === l.line_id)) pick.push(l); };
      add(lines['odpt.Railway:JR-East.Yamanote']); // Yamanote always
      for (const l of nonNormal) add(l);
      for (const id of majors) { if (pick.length >= 5) break; add(lines[id]); } // fill with majors when calm
      return Response.json({
        note: 'Live demo of /v1/lines/status (trimmed to a few lines). This is real data, fetched moments ago. Get a free key at https://api.gachi-tokusuru.com for all 94 lines.',
        fetched_at: r.fetched_at, stale: r.stale, count: pick.length, lines: pick, attribution: ODPT_ATTR,
      }, { headers: demoHeaders });
    }
    if (request.method === 'GET' && url.pathname === '/example/alerts') {
      const demoHeaders = { 'access-control-allow-origin': '*', 'cache-control': 'public, max-age=60' };
      const r = await readRealtime(env, 'alerts:active', ALERTS_MAX_AGE_S);
      if (r.missing) {
        return Response.json({ note: 'Live demo of /v1/alerts/active — the alert feed is initializing, check back shortly.', coverage: ALERTS_COVERAGE, alerts: [] }, { headers: demoHeaders });
      }
      return Response.json({
        note: 'Live demo of /v1/alerts/active — river flood forecasts & landslide alerts. count:0 means Japan is calm right now. We return empty honestly.',
        coverage: ALERTS_COVERAGE, fetched_at: r.fetched_at, stale: r.stale,
        count: r.data.count ?? (r.data.alerts || []).length, alerts: r.data.alerts || [],
        source: JMA_ATTR.source, attribution: JMA_ATTR, disclaimer: JMA_DISCLAIMER,
      }, { headers: demoHeaders });
    }

    // Legacy /pro-activate → /activate (keep old payment-completion URLs working, preserve query)
    if (request.method === 'GET' && url.pathname === '/pro-activate') {
      return Response.redirect(`${url.origin}/activate${url.search}`, 301);
    }

    // Activation — Stripe redirects here after any paid subscription checkout (Pro / All Access / Business).
    if (request.method === 'GET' && url.pathname === '/activate') {
      const sid = url.searchParams.get('session_id') || '';
      const htmlHeaders = { 'content-type': 'text/html; charset=utf-8' };
      const fail = (body, status) => new Response(activatePage(
        `<h1>Activate your API key</h1>${body}<p class="mut">Back to <a href="/">home &amp; pricing</a> · contact@gachi-tokusuru.com</p>`,
      ), { headers: htmlHeaders, status });
      if (!env.STRIPE_SECRET_KEY) return fail('<p>Activation is temporarily unavailable. Please contact support with your payment email.</p>', 500);
      if (!/^cs_[A-Za-z0-9_]+$/.test(sid)) {
        return fail('<p>Missing or invalid session. If you just paid and see this, contact support with your payment email.</p>', 403);
      }
      const r = await activate(env, sid);
      if (!r.ok) {
        const msg = r.reason === 'not_paid'
          ? 'Payment is not completed yet. If you just paid, refresh this page in a few seconds.'
          : r.reason === 'unknown_plan'
            ? 'We could not match your purchase to a plan. Please contact support with your payment email.'
            : 'We could not verify your payment automatically. Please contact support with your payment email.';
        return fail(`<p>${msg}</p>`, 403);
      }
      const label = PLAN_META[r.plan]?.label || r.plan;
      const limit = (PLAN_LIMITS[r.plan] || 0).toLocaleString('en-US');
      return new Response(activatePage(
        `<h1>✅ You're on ${label}</h1>`
        + `<p>Thanks for subscribing. Here is your API key (${limit} requests/month, MCP + REST):</p>`
        + `<div class="key" id="apikey">${r.key}</div>`
        + '<p><button type="button" id="copybtn" onclick="copyKey()">Copy key</button></p>'
        + '<p><b>Save it now</b> — treat it like a password. <b>Bookmark this page (this exact URL).</b> '
        + 'Reloading it shows the same key again — even if you close the tab before copying'
        + (r.emailed ? ", and we've also emailed it to you as a backup." : '.') + '</p>'
        + `<script>function copyKey(){var k=document.getElementById('apikey').textContent.trim();var b=document.getElementById('copybtn');function done(){b.textContent='Copied!';setTimeout(function(){b.textContent='Copy key';},2000);}function fb(){try{var r=document.createRange();r.selectNode(document.getElementById('apikey'));var s=window.getSelection();s.removeAllRanges();s.addRange(r);document.execCommand('copy');done();}catch(e){b.textContent='Select the key and press Ctrl+C';}}if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(k).then(done).catch(fb);}else{fb();}}</script>`
        + '<p>First call:</p>'
        + `<pre style="background:#f6f8f7;border:1px solid #e3e8e6;border-radius:8px;padding:12px;overflow-x:auto;font-size:13px">curl "https://api.gachi-tokusuru.com/v1/station-toilets/search?station=Shinjuku" \\\n  -H "Authorization: Bearer ${r.key}"</pre>`
        + '<p>MCP client config:</p>'
        + `<pre style="background:#f6f8f7;border:1px solid #e3e8e6;border-radius:8px;padding:12px;overflow-x:auto;font-size:13px">{"mcpServers":{"japan-toilet":{"url":"https://api.gachi-tokusuru.com/mcp","headers":{"Authorization":"Bearer ${r.key}"}}}}</pre>`
        + '<p class="mut">Full API docs: <a href="/docs">/docs</a>. This key works for both MCP and REST (shared monthly quota).</p>'
        + `<p class="mut">Manage or cancel your subscription anytime: <a href="${PORTAL_URL}">billing portal</a>. Questions? contact@gachi-tokusuru.com</p>`,
      ), { headers: htmlHeaders });
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

// Renders a plan CTA. Real Stripe link -> Subscribe button. Placeholder link
// (operator hasn't created it yet) -> route to the inquiry form so no dead link ships.
function payCta(planKey, subscribeNote) {
  const url = PAYMENT_LINKS[planKey];
  if (/^https?:\/\//.test(url)) {
    return `<a href="${url}" target="_blank" rel="noopener"><button type="button">Subscribe</button></a> <span class="mut">${subscribeNote}</span>`;
  }
  return `<a href="#bizform"><button type="button">Request access</button></a> <span class="mut">Request access and we'll email your key.</span>`;
}

const OPENAPI_YAML = `openapi: 3.0.3
info:
  title: Gachi Data API — Japan Station & Accessibility Data (API · MCP · Open Datasets)
  version: "2.0.0"
  description: >
    Deep, obscure Japanese data you won't find anywhere else — stations, accessibility,
    vacancy, hazards. Hand-verified, English-first, built for AI agents. Same data and
    response shape as the MCP server. Auth: Authorization: Bearer <API key> (free keys at
    https://api.gachi-tokusuru.com). Requests count against one shared monthly quota per
    key (MCP + REST combined).
servers:
  - url: https://api.gachi-tokusuru.com
paths:
  /v1/station-toilets/search:
    get:
      summary: Accessible toilets inside a Tokyo station
      parameters:
        - name: station
          in: query
          required: true
          schema: { type: string }
          description: Station name, English or Japanese (Shinjuku or 新宿).
      responses:
        "200": { description: Station toilets (English-first, *_ja companions) }
        "400": { description: Missing station param }
        "401": { description: Missing/invalid API key }
        "404": { description: No data for that station }
        "429": { description: Monthly quota reached (Retry-After header) }
  /v1/toilets/nearby:
    get:
      summary: Public toilets near a coordinate
      parameters:
        - { name: lat, in: query, required: true, schema: { type: number } }
        - { name: lng, in: query, required: true, schema: { type: number } }
        - { name: radius, in: query, required: false, schema: { type: integer, default: 800, maximum: 2000 }, description: metres (capped at 2000) }
        - { name: wheelchair, in: query, required: false, schema: { type: boolean } }
        - { name: ostomate, in: query, required: false, schema: { type: boolean } }
        - { name: diaper, in: query, required: false, schema: { type: boolean } }
      responses:
        "200": { description: Nearby public toilets, nearest first (max 50) }
        "400": { description: Missing/invalid lat or lng }
        "401": { description: Missing/invalid API key }
        "429": { description: Monthly quota reached (Retry-After header) }
  /v1/municipalities/{code}/context:
    get:
      summary: Official data for a municipality in one call (vacancy, ridership, hazard, land price, livability)
      description: >
        One call returns official Japanese government data for a municipality — housing
        vacancy (2003–2023), nearest-station ridership trend, MLIT hazard categories, land
        prices, and livability counts (incl. bus stops within 1 km of the municipality
        centroid). Official values + arithmetic derivations only — no scores, no judgment.
        Accepts a 5-digit code or exact name; dissolved codes resolve via the merger
        crosswalk. Free plan: 1 municipality/day.
      parameters:
        - { name: code, in: path, required: true, schema: { type: string }, description: 5-digit municipality code (13104) or exact name. }
        - { name: fields, in: query, required: false, schema: { type: string }, description: "Comma-separated subset: vacancy,ridership,population,hazard,land_price,livability." }
      responses:
        "200": { description: Municipality context (official values only) }
        "401": { description: Missing/invalid API key }
        "404": { description: Unknown municipality }
        "410": { description: Municipality dissolved (response names the successor) }
        "429": { description: Free daily limit or monthly quota reached }
  /v1/stations/{id}/context:
    get:
      summary: Same municipality context, resolved from a station_id
      parameters:
        - { name: id, in: path, required: true, schema: { type: string }, description: Station master station_id (e.g. st_00001). }
        - { name: fields, in: query, required: false, schema: { type: string }, description: "Comma-separated subset (see /v1/municipalities/{code}/context)." }
      responses:
        "200": { description: Context for the station's municipality }
        "401": { description: Missing/invalid API key }
        "404": { description: Unknown station_id }
        "429": { description: Free daily limit or monthly quota reached }
  /v1/stations/{id}/hazard:
    get:
      summary: Official hazard info at a station (live relay to MLIT reinfolib)
      description: >
        Returns the official MLIT 不動産情報ライブラリ hazard values/categories at the
        station's location — flood inundation depth rank, liquefaction/landform, and
        storm-surge inundation-area presence — relayed verbatim (no derived score) and
        cached 14 days. Landslide & tsunami are license-restricted (一部非商用) and return
        available:false with a link to the official hazard maps. station_id comes from the
        Japan Station Master (e.g. st_00001); 9,143 of 9,145 stations have coordinates.
        NOT a substitute for official hazard maps.
      parameters:
        - name: id
          in: path
          required: true
          schema: { type: string }
          description: Station master station_id (e.g. st_00001).
      responses:
        "200": { description: Official hazard values at the station (or hazard=null if the station has no coordinates) }
        "401": { description: Missing/invalid API key }
        "404": { description: Unknown station_id }
        "429": { description: Monthly quota reached (Retry-After header) }
        "502": { description: Upstream hazard source lookup failed }
        "503": { description: Hazard source not configured }
  /v1/alerts/active:
    get:
      summary: Active JMA river flood forecasts & landslide alerts (live relay)
      description: >
        Relays currently-active JMA 指定河川洪水予報 (river flood forecast, levels 2-5) and
        土砂災害警戒情報 (landslide warning) as published — level, area, official summary, issue
        time; a coverage array states exactly what is included. NOT general weather warnings
        (storm/heavy rain/snow) and NOT earthquakes. Relay of official facts, NOT a warning
        issued by this service; not a life-safety system. Carries fetched_at and stale; 503 if
        the feed is uninitialised.
      responses:
        "200": { description: "Active alerts (empty array in calm periods)" }
        "401": { description: Missing/invalid API key }
        "429": { description: Monthly quota reached }
        "503": { description: Alert feed not initialized }
  /v1/alerts/area/{area_code}:
    get:
      summary: Active JMA alerts for an area
      parameters:
        - { name: area_code, in: path, required: true, schema: { type: string }, description: "2-digit prefecture code (e.g. 13 = Tokyo) or a JMA forecast-area code." }
      responses:
        "200": { description: Alerts matching the area }
        "401": { description: Missing/invalid API key }
        "503": { description: Alert feed not initialized }
  /v1/stations/{id}/alerts:
    get:
      summary: Active JMA alerts affecting a station's prefecture
      parameters:
        - { name: id, in: path, required: true, schema: { type: string }, description: "Station master station_id (e.g. st_00001)." }
      responses:
        "200": { description: "Alerts for the station's prefecture (prefecture-level match)" }
        "401": { description: Missing/invalid API key }
        "404": { description: Unknown station_id }
        "503": { description: Alert feed not initialized }
  /v1/lines/status:
    get:
      summary: Live train service status for all Tokyo-area lines (ODPT relay)
      description: >
        Live per-line service status relayed from ODPT odpt:TrainInformation. status is an
        English enum (normal / delayed / suspended / resumed); cause is the operator's original
        text, with summary_en for known patterns (else null). fetched_at + source_published_at;
        stale flagged, 503 if uninitialised. Data: CC BY 4.0 (ODPT).
      responses:
        "200": { description: All lines with current status }
        "401": { description: Missing/invalid API key }
        "503": { description: Train status feed not initialized }
  /v1/lines/{line_id}/status:
    get:
      summary: Live service status for one line
      parameters:
        - { name: line_id, in: path, required: true, schema: { type: string }, description: "ODPT railway id, e.g. odpt.Railway:JR-East.Yamanote (URL-encoded)." }
      responses:
        "200": { description: The line's current status }
        "401": { description: Missing/invalid API key }
        "404": { description: Unknown line_id }
        "503": { description: Train status feed not initialized }
  /v1/stations/{id}/lines/status:
    get:
      summary: Live status of every line serving a station
      parameters:
        - { name: id, in: path, required: true, schema: { type: string }, description: "Station master station_id (e.g. st_00001)." }
      responses:
        "200": { description: Status for each line at the station }
        "401": { description: Missing/invalid API key }
        "404": { description: Unknown station_id or no lines mapped }
        "503": { description: Train status feed not initialized }
components:
  securitySchemes:
    bearerAuth: { type: http, scheme: bearer }
security:
  - bearerAuth: []
`;

const DOCS_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>API docs — Gachi Data API</title>
<style>body{font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;max-width:720px;margin:40px auto;padding:0 20px;color:#1a1a1a}
code,pre{font-family:ui-monospace,Menlo,monospace}pre{background:#f6f8f7;border:1px solid #e3e8e6;border-radius:8px;padding:14px;overflow-x:auto;font-size:13px}
a{color:#0b6}h2{margin-top:32px}</style></head><body>
<h1>Gachi Data API — Japan Station &amp; Accessibility Data — REST v1</h1>
<p>Machine-readable spec: <a href="/openapi.yaml">/openapi.yaml</a>. Get a free key at <a href="/">the homepage</a>.
Auth header on every call: <code>Authorization: Bearer &lt;key&gt;</code>. MCP and REST share one monthly quota per key.</p>
<h2>Station toilets (English or Japanese station name)</h2>
<pre>curl "https://api.gachi-tokusuru.com/v1/station-toilets/search?station=Shinjuku" \\
  -H "Authorization: Bearer YOUR_API_KEY"</pre>
<h2>Public toilets near a coordinate</h2>
<pre>curl "https://api.gachi-tokusuru.com/v1/toilets/nearby?lat=35.6896&lng=139.7006&radius=800&wheelchair=true" \\
  -H "Authorization: Bearer YOUR_API_KEY"</pre>
<h2>Official hazard info at a station <span style="font-weight:400;font-size:14px;color:#666">(live relay to MLIT 不動産情報ライブラリ)</span></h2>
<p>Official flood / liquefaction / storm-surge categories at a station's location, relayed as-is
(no derived score) and cached 14 days. Landslide &amp; tsunami are 一部非商用 (license-restricted), so
they return <code>available:false</code> with a link to the official hazard maps. <code>id</code> is
a Japan Station Master <code>station_id</code> (e.g. <code>st_00001</code>).</p>
<pre>curl "https://api.gachi-tokusuru.com/v1/stations/st_00001/hazard" \\
  -H "Authorization: Bearer YOUR_API_KEY"</pre>
<p>Also available as the MCP tool <code>get_station_hazard(station_name)</code> — pass a station name
in Japanese (新宿) or romaji (Shinjuku, Musashi-Kosugi).</p>
<p><b>⚠️ Disclaimer:</b> for research &amp; analytics only. This is NOT a substitute for official hazard
maps and must NOT be the sole basis for safety or evacuation decisions — always consult the
government/municipal hazard maps at <a href="https://disaportal.gsi.go.jp/">disaportal.gsi.go.jp</a>.
防災・避難の判断には必ず自治体の公式ハザードマップをご確認ください。</p>
<p>Errors are JSON: <code>{"error":"&lt;code&gt;","message":"...","docs":"https://api.gachi-tokusuru.com/docs"}</code>.
Codes: 400 bad_request, 401 unauthorized, 404 not_found, 429 rate_limit_exceeded (with <code>Retry-After</code>).</p>

<h2 id="realtime">Realtime Layer <span style="font-weight:400;font-size:14px;color:#666">(the one thing you can't cache)</span></h2>
<p>Live relays from official feeds — <b>JMA River Flood Forecasts &amp; Landslide Alerts</b> and <b>ODPT</b> train
service status. Open to all plans (throttled by request volume, not feature-gated). Every response carries
<code>fetched_at</code> (and <code>source_published_at</code> for trains); when the upstream feed is stale the
response is flagged <code>"stale": true</code>, and when it is unavailable you get a <code>503</code> — we never
hand you old data with a fresh face.</p>
<p><b>Alert coverage: nationwide.</b> Station-matching: Greater Tokyo (423 stations) — elsewhere, query by area code.</p>
<p><b>What the alert feed covers</b> (also returned as <code>coverage</code> in every alert response):</p>
<ul>
<li><code>river_flood_forecast (JMA levels 2-5)</code> — 指定河川洪水予報 (氾濫注意 → 氾濫発生)</li>
<li><code>landslide_warning</code> — 土砂災害警戒情報</li>
</ul>
<p><b>What it does NOT cover:</b> general weather warnings (storm / heavy rain / snow 警報・注意報) and earthquakes
are <b>not</b> in this feed. General weather warnings are on the roadmap; see the FAQ below for earthquakes.</p>
<p><b>Typhoon-day question an agent can answer in two calls</b> — "It's storming. Are there flood alerts near Shinjuku, and is the Yamanote Line still running?"</p>
<pre># 1) Any active JMA alerts affecting Shinjuku's prefecture?
curl "https://api.gachi-tokusuru.com/v1/stations/st_00167/alerts" \\
  -H "Authorization: Bearer YOUR_API_KEY"
# 2) Is the Yamanote Line running right now?
curl "https://api.gachi-tokusuru.com/v1/lines/status" \\
  -H "Authorization: Bearer YOUR_API_KEY"
# → each line: { "status": "normal|delayed|suspended|resumed", "cause": "…", "summary_en": "…"|null,
#               "source_published_at": "…", "line_en": "Yamanote Line" }</pre>
<p>MCP equivalents: <code>get_active_alerts(area?)</code>, <code>get_station_alerts(station_name)</code>,
<code>get_train_status(line_or_station)</code> — e.g. ask <i>"is the Yamanote Line running?"</i> in English or Japanese.</p>
<p><b>See it live (no key):</b> <a href="/example/train-status">/example/train-status</a> · <a href="/example/alerts">/example/alerts</a> — trimmed real data, fetched moments ago.</p>
<p><b>An actual delayed response</b> — from July 5, 2026, the Fukutoshin Line was delayed while we were building this page (real values, unedited):</p>
<!-- PROVENANCE: values below are transcribed verbatim from a live read of the
     train:status:_all KV snapshot on 2026-07-05T11:33:01Z (Fukutoshin Line delayed,
     summary_en "passenger medical emergency", source_published_at 2026-07-05T20:32:00+09:00).
     Measured, not fabricated. If the measurement ever differs, fix the values AND the caption. -->
<pre>GET /v1/lines/odpt.Railway:TokyoMetro.Fukutoshin/status
{
  "line_en": "Fukutoshin Line",
  "line_ja": "副都心線",
  "status": "delayed",
  "summary_en": "passenger medical emergency",
  "source_published_at": "2026-07-05T20:32:00+09:00",
  "fetched_at": "2026-07-05T11:33:01Z"
}</pre>
<p><b>Alerts — an empty array is a feature.</b> When Japan is calm, <code>/v1/alerts/active</code> returns
<code>count:0</code> with an empty list (plus <code>coverage</code> + disclaimer). We don't pad quiet days.</p>
<p><b>⚠️ Disclaimer (JMA):</b> alerts are relayed from the Japan Meteorological Agency <b>as published — not warnings
issued by this service</b>. For evacuation decisions always follow official municipal guidance. Best-effort relay,
not a life-safety system. Our JMA pipeline also powers a public alert feed on
<a href="https://x.com/gachi_tokusuru">X (@gachi_tokusuru)</a> — proof the relay is alive.</p>
<p><b>FAQ — where are earthquakes?</b> Earthquake information is a point-in-time event, not an ongoing
"active" state, so it is intentionally not listed in the alerts feed. Use the official JMA earthquake
information for that.</p>

<h2 id="data-stories">Data Stories</h2>
<p>Two worked examples. Every number below is a real API response or a row from the open datasets — nothing is invented, and there's no interpretation on top.</p>

<h3>Two hubs, very different water</h3>
<p>Two of Tokyo's busiest interchange hubs sit about 13&nbsp;km apart. Shinjuku reads as no flood category; Musashi-Kosugi carries 0.5–3.0&nbsp;m of expected inundation from the Tama River. The station name doesn't tell you which — one call per station does.</p>
<pre>GET /v1/stations/st_00167/hazard          # Shinjuku (新宿)
{
  "station": { "id": "st_00167", "name": "Shinjuku", "name_ja": "新宿" },
  "hazard": {
    "flood":        { "inundation_expected": false, "depth_category": "none",
                      "rivers": null,
                      "source": "国土交通省 不動産情報ライブラリ XKT026 (洪水浸水想定区域・想定最大規模)" },
    "liquefaction": { "landform_ja": "ローム台地", "tendency_level": 5,
                      "tendency_note_ja": "液状化しにくい" }
  }
}

GET /v1/stations/st_00388/hazard          # Musashi-kosugi (武蔵小杉)
{
  "station": { "id": "st_00388", "name": "Musashi-kosugi", "name_ja": "武蔵小杉" },
  "hazard": {
    "flood":        { "inundation_expected": true, "depth_category": "0.5–3.0 m",
                      "rivers": ["多摩川", "大栗川", "浅川"],
                      "source": "国土交通省 不動産情報ライブラリ XKT026 (洪水浸水想定区域・想定最大規模)" },
    "liquefaction": { "landform_ja": "後背湿地", "tendency_level": 3,
                      "tendency_note_ja": "やや液状化しやすい" }
  }
}</pre>
<p>One call per station. Official MLIT categories, no interpretation.</p>

<h3>Ridership: the shock and the incomplete return</h3>
<p>Official annual ridership doesn't move the way you'd guess. At Chuo-Daigaku-Meisei-Daigaku on the Tama Monorail, daily journeys held near 34,000 through 2019, fell to 5,917 in 2020, and have climbed back only to about 16% below 2012. You can read the whole curve — and join it to hazard — per station.</p>
<pre># station-ridership open dataset (station_ridership.csv) — station_id st_00068
year    passenger_journeys
2012        33,118
2019        33,675
2020         5,917
2022        29,320
2024        27,913
# operator: Tokyo Tama Intercity Monorail · includes_alighting: true</pre>
<p>Cross it against the same station's hazard in one lookup:</p>
<pre>GET /v1/stations/st_00068/hazard
{ "hazard": { "flood": { "depth_category": "0.5–3.0 m" },
              "liquefaction": { "landform_ja": "丘陵" } } }</pre>
<!-- TODO(Context API / Stage 2): once GET /v1/stations/{id}/context ships, replace the two-step
     (ridership open dataset + hazard API) above with a single context call returning
     vacancy × ridership × hazard × population, and update this Data Story's example accordingly. -->
<p>Ridership from the open dataset, hazard from the API — joined on one <code>station_id</code>. The Context API will fold vacancy × ridership × hazard × population into a single call: next on the roadmap.</p>

<p><a href="/">← Back to home &amp; pricing</a></p>
</body></html>`;

const LLMS_TXT = `# Gachi Data API — Japan Station & Accessibility Data (API · MCP · Open Datasets)

> Deep, obscure Japanese data you won't find anywhere else — stations, accessibility,
> vacancy, hazards. Hand-verified, English-first, built for AI agents.
> Free tier; MCP + REST share one key.

## API access
- MCP endpoint: https://api.gachi-tokusuru.com/mcp (JSON-RPC; tools: get_toilet_by_station, get_public_toilet_by_city, get_station_hazard, get_active_alerts, get_station_alerts, get_train_status)
- REST GET /v1/station-toilets/search?station=Shinjuku  (station name English or Japanese)
- REST GET /v1/toilets/nearby?lat=&lng=&radius=&wheelchair=&ostomate=&diaper=  (radius metres, max 2000)
- REST GET /v1/stations/{station_id}/hazard  (official MLIT hazard categories at a station, relayed live; station_id e.g. st_00001)
- REST GET /v1/municipalities/{code}/context · /v1/stations/{station_id}/context  (Municipality Context API: vacancy 2003-2023 × nearest-station ridership × hazard × land price × livability, one call per municipality or station; official values only, no scores; Free 1 municipality/day)
- Realtime Layer (live) — service status for 94 Tokyo-area train lines (delays, suspensions, resumptions) + nationwide JMA river flood forecasts & landslide warnings, station-matched. Alert coverage: nationwide. Station-matching: Greater Tokyo (423 stations) — elsewhere, query by area code.
  - REST GET /v1/alerts/active · /v1/alerts/area/{code} · /v1/stations/{station_id}/alerts  (JMA river flood forecasts (levels 2-5) & landslide alerts ONLY — not general weather warnings, not earthquakes; each response has a coverage array; relay of official facts, not a warning we issue)
  - REST GET /v1/lines/status · /v1/lines/{line_id}/status · /v1/stations/{station_id}/lines/status  (ODPT train service status; enum normal/delayed/suspended/resumed)
  - Every realtime response carries fetched_at (+ source_published_at for trains); stale data is flagged stale:true or 503, never returned silently.
- Our JMA pipeline also powers a public alert feed on X (@gachi_tokusuru) — proof the relay is alive.
- Auth: Authorization: Bearer <key>. Free keys: https://api.gachi-tokusuru.com
- OpenAPI: https://api.gachi-tokusuru.com/openapi.yaml
- Example analyses (Data Stories): https://api.gachi-tokusuru.com/docs#data-stories
- Pricing: https://api.gachi-tokusuru.com (Free 1k, Pro $19/100k, All Access $49/200k, Business $149/500k)

## Free open datasets (citable, annually updated)
- Japan Station Master (entity-resolved, 9,145 stations nationwide) + Ridership 2000-2025 (station_id shared)
- Housing Vacancy 2003-2023 (1,653 municipalities, 5 national surveys, with merger crosswalk)
- Municipality Context API (live): vacancy × ridership × hazard × land price × livability, per municipality or station — official values only, no scores
- Zenodo DOI (concept, always latest): 10.5281/zenodo.21199500  (https://doi.org/10.5281/zenodo.21199500)
- GitHub: https://github.com/eng213035/gachi-open-datasets
- Kaggle: https://www.kaggle.com/datasets/takufujii/japan-station-master-and-ridership-2000-2025-tokyo

## License & attribution
- Data: Tokyo Metropolitan Government (Bureau of Social Welfare) & BODIK municipal open data, CC BY 4.0.
- English station names via ODPT (Public Transportation Open Data Center).
- nearest_exit is an original derived value by gachi-tokusuru.com. Accuracy/completeness not guaranteed.
`;

const LANDING_HTML = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Gachi Data API — Japan Station &amp; Accessibility Data (API · MCP · Open Datasets)</title>
<meta name="description" content="Deep, obscure Japanese data you won't find anywhere else — stations, accessibility, vacancy, hazards. Hand-verified, English-first, built for AI agents. MCP server + REST API + free open datasets.">
<meta property="og:title" content="Gachi Data API — Japan Station & Accessibility Data (API · MCP · Open Datasets)">
<meta property="og:description" content="Deep, obscure Japanese data you won't find anywhere else — stations, accessibility, vacancy, hazards. Hand-verified, English-first, built for AI agents.">
<meta property="og:type" content="website">
<meta property="og:url" content="https://api.gachi-tokusuru.com">
<meta name="twitter:card" content="summary">
<meta name="robots" content="index,follow">
<style>
:root{--fg:#1a1a1a;--mut:#666;--acc:#0b6;--bg:#fff;--card:#f6f8f7;--bd:#e3e8e6}
*{box-sizing:border-box}body{margin:0;font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:var(--fg);background:var(--bg)}
.wrap{max-width:760px;margin:0 auto;padding:32px 20px 64px}
h1{font-size:30px;line-height:1.2;margin:0 0 8px}h2{font-size:20px;margin:40px 0 12px}
.sub{color:var(--mut);font-size:18px;margin:0 0 16px}
.tagline{font-style:italic;color:var(--fg);border-left:3px solid var(--acc);padding-left:12px;margin:0 0 24px}
.cards{display:grid;grid-template-columns:1fr;gap:12px;margin:12px 0}
@media(min-width:640px){.cards{grid-template-columns:1fr 1fr 1fr}}
.card{background:var(--card);border:1px solid var(--bd);border-radius:8px;padding:14px}
.card p{margin:8px 0 0;font-size:14px}
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

<h1>Gachi Data API <span class="tag">Early access</span></h1>
<p class="sub">Deep, obscure Japanese data you won't find anywhere else — station accessibility, vacancy statistics, hazard categories. Small, hand-verified, English-first, built for AI agents. <b>MCP</b> server + <b>REST</b> API + free <b>open datasets</b>. One key for everything.</p>
<p class="tagline">Every station verified against official sources — or transparently flagged. (name_source: odpt / wikidata / romanized)</p>

<div class="demo">
<b>新宿駅 (Shinjuku) → nearest accessible toilet</b><br>
11 accessible toilets, each mapped to its <b>nearest station exit</b> — first-party data you won't find anywhere else.
</div>

<p><a href="/example" target="_blank" rel="noopener"><b>▶ See a live sample response</b></a> — no key needed, real JSON.</p>
<p><a href="/example/train-status" target="_blank" rel="noopener"><b>▶ Train status right now</b></a> — live JSON, no key needed.</p>
<p><a href="/example/alerts" target="_blank" rel="noopener"><b>▶ Active flood &amp; landslide alerts right now</b></a> — usually zero, and that's honest.</p>

<h2>What's inside</h2>
<ul>
<li><b>Accessibility API (live)</b> — 526 Tokyo stations with floor, gender, equipment &amp; <code>nearest_exit</code>; 612 municipalities of public toilets nationwide</li>
<li><b>Station Master (open dataset)</b> — 9,145 stations, entity-resolved nationwide (Shinjuku = 6 companies, 1 ID), English names (name_source: odpt/wikidata/romanized)</li>
<li><b>Ridership 2000–2025 (open dataset)</b> — 292 stations, annual series through the COVID collapse and recovery</li>
<li><b>Housing Vacancy (open dataset)</b> — 1,653 municipalities, 5 national surveys (2003–2023), official counts with merger crosswalk. The numbers behind Japan's 9-million-akiya story, finally citable.</li>
<li><b>Municipality Context API (live)</b> — vacancy × ridership × hazard × land price × livability in one call, per municipality or station. Official values only — no scores.</li>
<li><b>Station Hazard API (live)</b> — official flood, liquefaction &amp; storm-surge categories from MLIT for <b>9,143 stations</b>, relayed live per station (REST + MCP); landslide &amp; tsunami link out to the official maps (license-restricted)</li>
<li><b>Realtime Layer (live)</b> — service status for 94 Tokyo-area train lines (delays, suspensions, resumptions) + nationwide JMA river flood forecasts &amp; landslide warnings, station-matched. <b>The one thing you can't cache.</b></li>
</ul>

<h2>Built with this data</h2>
<p class="mut">Three live products, one data pipeline — we eat our own cooking.</p>
<div class="cards">
<div class="card">
<a href="https://toilet.gachi-tokusuru.com/en" target="_blank" rel="noopener"><b>toilet.gachi-tokusuru.com</b></a>
<p>A live accessibility site running entirely on this dataset. Your agent can do the same in one call.</p>
</div>
<div class="card">
<a href="https://infra.gachi-tokusuru.com/" target="_blank" rel="noopener"><b>infra.gachi-tokusuru.com</b></a>
<p>Rural infrastructure navigator: bus stops, hospitals, supermarkets, station access times. The same spatial engine that powers our livability data.</p>
</div>
<div class="card">
<a href="https://www.gachi-tokusuru.com/" target="_blank" rel="noopener"><b>www.gachi-tokusuru.com</b></a>
<p>Our Japanese-language data journalism site. Daily analyses built on this exact pipeline: land price × future population, hazard × price per station, ridership rankings. <span class="mut">(Japanese only — the data behind it is what this API sells.)</span></p>
</div>
</div>
<p>These sites run on the same pipeline you'd be buying — if they're updating daily, the data is alive.</p>

<h2>Roadmap</h2>
<ul>
<li><b>Seismic risk</b> — earthquake shaking categories per station</li>
<li><b>General weather warnings</b> (storm, heavy rain, snow) — planned</li>
</ul>
<p class="mut">No dates promised — we ship when it's right. All Access &amp; Business subscribers get every new API automatically.</p>

<h2>Pricing <span class="mut">(early-access — early users are grandfathered)</span></h2>
<table>
<tr><th>Plan</th><th>Price</th><th>Requests</th><th></th></tr>
<tr>
  <td class="price">Free</td><td>$0</td><td>1,000 / mo</td>
  <td><i>Try it with your agent</i><br>Full MCP + REST · all current tools · community support (GitHub issues)<br>
  <button type="button" onclick="document.getElementById('kemail').focus()">Get a free key</button>
  <br><span class="mut">Your key will be generated instantly upon email verification.</span></td>
</tr>
<tr>
  <td class="price">Pro</td><td>$19/mo</td><td>100,000 / mo</td>
  <td><i>For individual developers in production</i><br>Full MCP + REST · commercial projects welcome (single developer) · <b>Early access pricing — locked in</b><br>
  <a href="${PAYMENT_LINKS.pro}" target="_blank" rel="noopener"><button type="button">Subscribe</button></a>
  <span class="mut"> — your key is shown instantly after checkout.</span></td>
</tr>
<tr>
  <td class="price">All Access</td><td>$49/mo</td><td>200,000 / mo <span class="mut">(shared pool, fair use)</span></td>
  <td><i>Every API we ship, one key</i><br>All current + upcoming APIs (station master, ridership, hazard — <b>as they launch</b>), included automatically · single developer license<br>
  ${payCta('all_access', "your API key is issued instantly after checkout.")}</td>
</tr>
<tr>
  <td class="price">Business</td><td>$149/mo</td><td>500,000 / mo <span class="mut">(shared pool)</span></td>
  <td><i>For teams and companies</i><br>Team key sharing (multiple seats) · embed in your company's products &amp; internal systems (no redistribution of raw data) · all current + upcoming APIs included<br>
  ${payCta('business', "your API key is issued instantly after checkout.")}</td>
</tr>
</table>
<p class="mut">Free, Pro and All Access are licensed to a single individual developer — commercial projects welcome. Teams and companies, please use Business or above.</p>
<p class="mut">Already subscribed? <a href="${PORTAL_URL}" target="_blank" rel="noopener">Manage or cancel your subscription</a> anytime.</p>

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

<h2>Try it with curl (MCP)</h2>
<pre>curl -X POST https://api.gachi-tokusuru.com/mcp \\
  -H "Authorization: Bearer YOUR_API_KEY" -H "Content-Type: application/json" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call",
       "params":{"name":"get_toilet_by_station","arguments":{"station":"Shinjuku"}}}'</pre>

<h2>Or plain REST <span class="mut">(same data, same key — <a href="/docs">docs</a> · <a href="/openapi.yaml">openapi.yaml</a>)</span></h2>
<pre>curl "https://api.gachi-tokusuru.com/v1/station-toilets/search?station=Shinjuku" \\
  -H "Authorization: Bearer YOUR_API_KEY"

curl "https://api.gachi-tokusuru.com/v1/toilets/nearby?lat=35.6896&lng=139.7006&radius=800&wheelchair=true" \\
  -H "Authorization: Bearer YOUR_API_KEY"</pre>

<h2>Free open datasets</h2>
<p>Prefer the raw data? Our datasets are free, citable and annually updated —
<b>station master (9,145 stations, cross-operator, entity-resolved), ridership 2000–2025, and housing vacancy 2003–2023 (1,653 municipalities, with merger crosswalk)</b>.</p>
<ul>
<li><a href="${DATASETS.github}" target="_blank" rel="noopener">GitHub</a> — source + build pipeline</li>
<li><a href="${DATASETS.zenodo_url}" target="_blank" rel="noopener">Zenodo</a> — DOI <code>${DATASETS.zenodo_doi}</code> (citable archive)</li>
<li><a href="${DATASETS.kaggle}" target="_blank" rel="noopener">Kaggle</a> — notebooks &amp; discovery</li>
</ul>
<p class="mut">The newest survey year reaches API subscribers first; it lands in the free dataset at the next annual release.</p>

<h2 id="bizform-anchor">Questions or a custom need?</h2>
<p class="mut">Have a use case the plans above don't cover, or a question about the data? Tell us what you'd use it for — it shapes what we build next. Upcoming APIs (station master, ridership, hazard) are included in the relevant plans <b>as they launch</b>.</p>
<p class="mut"><b>Listing sites &amp; relocation services:</b> enrich your akiya listings with context data — vacancy, ridership trend, hazard and livability per municipality in one call.</p>
<form id="bizform">
<input type="email" id="bemail" placeholder="you@example.com" required>
<textarea id="buse" rows="2" placeholder="What would you use it for? (1 line)" required></textarea>
<button type="submit">Contact us</button>
<div class="out" id="bout"></div>
</form>

<footer>
<p><b><a href="${PORTAL_URL}" target="_blank" rel="noopener">Manage or cancel your subscription →</a></b> (Pro subscribers) &nbsp;·&nbsp; contact@gachi-tokusuru.com</p>
<p>Data: Tokyo Metropolitan Government &amp; BODIK municipal open data (CC BY 4.0). <code>nearest_exit</code> is an original derived value by gachi-tokusuru.com. Timeliness, accuracy and completeness are not guaranteed.</p>
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
