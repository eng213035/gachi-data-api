// Gachi Data API — Japan Station & Accessibility Data (API · MCP · Open Datasets) — lean MVP
// - Multi-key auth (self-serve free keys stored in KV)
// - Per-plan monthly rate limiting (KV counter; eventually consistent = approximate, fine for MVP)
// - English landing page + free-key form + Business interest form
// Data served straight from KV (see build_kv_seed*.py). No D1/Stripe-webhook in this lean build.

// Bumped on every deploy so /__version proves which build a given request hit.
const BUILD_VERSION = {
  commit: '6f171f9',
  built: '2026-07-05T04:58:00Z',
  build: 'hazard-launch-mcp-tool',
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
      'liquefaction classification, and landslide / storm-surge / tsunami inundation-area presence. ' +
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
async function stationHazard(env, coords) {
  const pt = [coords.lng, coords.lat];
  const { x, y } = hazTile(coords.lat, coords.lng, 14);
  const [flood, liq, landslide, surge, tsunami] = await Promise.all([
    reinfoLayer(env, 'XKT026', x, y).catch(() => null),
    reinfoLayer(env, 'XKT025', x, y).catch(() => null),
    reinfoLayer(env, 'XKT011', x, y).catch(() => null),
    reinfoLayer(env, 'XKT027', x, y).catch(() => null),
    reinfoLayer(env, 'XKT028', x, y).catch(() => null),
  ]);

  // Flood: keep only inundation polygons that actually contain the station point (point precision,
  // not tile-max), then report the deepest official rank + the rivers those polygons belong to.
  const floodHits = (flood?.features || []).filter((f) => polyContains(pt, f.geometry));
  const floodRank = floodHits.length ? Math.max(0, ...floodHits.map((f) => Number(f.properties?.A31a_205) || 0)) : 0;
  const rivers = [...new Set(floodHits.map((f) => f.properties?.A31a_202).filter(Boolean))];

  // Liquefaction/landform: the landform polygon containing the point (official classification + note).
  const liqHit = (liq?.features || []).find((f) => polyContains(pt, f.geometry));

  const present = (d) => !!(d && (d.features || []).length > 0);

  return {
    flood: {
      inundation_expected: floodRank > 0,
      depth_rank: floodRank || null,
      depth_category: floodRank ? FLOOD_RANK_EN[floodRank] : 'none',
      depth_category_ja: floodRank ? FLOOD_RANK_JA[floodRank] : 'なし',
      rivers: rivers.length ? rivers : null,
      source: '国土交通省 不動産情報ライブラリ XKT026 (洪水浸水想定区域・想定最大規模)',
    },
    liquefaction: liqHit
      ? {
          landform_ja: liqHit.properties?.topographic_classification_name_ja ?? null,
          tendency_level: Number(liqHit.properties?.liquefaction_tendency_level) || null,
          tendency_note_ja: liqHit.properties?.note ?? null,
          source: '国土交通省 不動産情報ライブラリ XKT025 (地形分類による液状化傾向図)',
        }
      : { landform_ja: null, tendency_level: null, tendency_note_ja: null, note: 'no data at this point', source: '国土交通省 不動産情報ライブラリ XKT025 (地形分類による液状化傾向図)' },
    landslide: {
      warning_area_present: present(landslide),
      source: '国土交通省 不動産情報ライブラリ XKT011 (土砂災害警戒区域)',
      commercial_use: 'restricted_in_some_prefectures — verify the source terms before commercial redistribution',
    },
    storm_surge: {
      inundation_area_present: present(surge),
      source: '国土交通省 不動産情報ライブラリ XKT027 (高潮浸水想定区域)',
    },
    tsunami: {
      inundation_area_present: present(tsunami),
      source: '国土交通省 不動産情報ライブラリ XKT028 (津波浸水想定)',
      commercial_use: 'restricted_in_some_prefectures — verify the source terms before commercial redistribution',
    },
  };
}

// Resolve a station record (with coords) from a station record whose lat/lng may be null,
// producing the final hazard payload. Shared by REST (by id) and MCP (by name).
async function hazardFromRec(env, rec) {
  const station = { id: rec.id ?? null, name: rec.n || null, name_ja: rec.nj || null };
  if (typeof rec.lat !== 'number' || typeof rec.lng !== 'number') {
    return { station, hazard: null, note: 'This station has no coordinates in the Japan Station Master, so a point hazard lookup is not available.', attribution: HAZARD_ATTRIBUTION };
  }
  const hazard = await stationHazard(env, { lat: rec.lat, lng: rec.lng });
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
async function activate(env, sessionId) {
  const cached = await env.TOILET_KV.get(`session:${sessionId}`, 'json');
  if (cached) return { ok: true, ...cached }; // already activated → same key

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
  const rec = { key, plan, email };
  await env.TOILET_KV.put(`session:${sessionId}`, JSON.stringify(rec));
  return { ok: true, ...rec };
}

function activatePage(body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Activate your API key</title>
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
    // Hazard tool: name -> coords -> live reinfolib relay (not a KV toilet lookup).
    if (tool.name === 'get_station_hazard') {
      const payload = await hazardPayload(env, params?.arguments?.station_name);
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

    // Legacy /pro-activate → /activate (keep old payment-completion URLs working, preserve query)
    if (request.method === 'GET' && url.pathname === '/pro-activate') {
      return Response.redirect(`${url.origin}/activate${url.search}`, 301);
    }

    // Activation — Stripe redirects here after any paid subscription checkout (Pro / All Access / Business).
    if (request.method === 'GET' && url.pathname === '/activate') {
      const sid = url.searchParams.get('session_id') || '';
      const htmlHeaders = { 'content-type': 'text/html; charset=utf-8' };
      const fail = (body, status) => new Response(activatePage(
        `<h1>Activate your API key</h1>${body}<p class="mut">Back to <a href="/">home &amp; pricing</a> · contact@piachan.com</p>`,
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
        + `<code class="key">${r.key}</code>`
        + '<p><b>Save it now</b> — treat it like a password. <b>Bookmark this page</b> to see the same key again.</p>'
        + '<p>First call:</p>'
        + `<pre style="background:#f6f8f7;border:1px solid #e3e8e6;border-radius:8px;padding:12px;overflow-x:auto;font-size:13px">curl "https://api.gachi-tokusuru.com/v1/station-toilets/search?station=Shinjuku" \\\n  -H "Authorization: Bearer ${r.key}"</pre>`
        + '<p>MCP client config:</p>'
        + `<pre style="background:#f6f8f7;border:1px solid #e3e8e6;border-radius:8px;padding:12px;overflow-x:auto;font-size:13px">{"mcpServers":{"japan-toilet":{"url":"https://api.gachi-tokusuru.com/mcp","headers":{"Authorization":"Bearer ${r.key}"}}}}</pre>`
        + '<p class="mut">Full API docs: <a href="/docs">/docs</a>. This key works for both MCP and REST (shared monthly quota).</p>'
        + `<p class="mut">Manage or cancel your subscription anytime: <a href="${PORTAL_URL}">billing portal</a>. Questions? contact@piachan.com</p>`,
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
  version: "1.0.0"
  description: >
    Structured data on wheelchair-accessible toilets in Tokyo train stations
    and public toilets across Japan. Same data and response shape as the MCP
    server. Auth: Authorization: Bearer <API key> (free keys at
    https://api.gachi-tokusuru.com). Requests count against one shared monthly
    quota per key (MCP + REST combined).
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
  /v1/stations/{id}/hazard:
    get:
      summary: Official hazard info at a station (live relay to MLIT reinfolib)
      description: >
        Returns the official MLIT 不動産情報ライブラリ hazard values/categories at the
        station's location — flood inundation depth rank, liquefaction/landform, and
        landslide / storm-surge / tsunami inundation-area presence — relayed verbatim
        (no derived score). station_id comes from the Japan Station Master (e.g. st_00001);
        327 of 425 stations have coordinates. NOT a substitute for official hazard maps.
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
<p>Official flood / liquefaction / landslide / storm-surge / tsunami categories at a station's
location, relayed as-is (no derived score). <code>id</code> is a Japan Station Master
<code>station_id</code> (e.g. <code>st_00001</code>).</p>
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
<p><a href="/">← Back to home &amp; pricing</a></p>
</body></html>`;

const LLMS_TXT = `# Gachi Data API — Japan Station & Accessibility Data (API · MCP · Open Datasets)

> Clean, structured data on wheelchair-accessible toilets in Tokyo train stations
> (with nearest station exit) and public toilets across Japan. For AI agents,
> travel and accessibility apps. Free tier; MCP + REST share one key.

## API access
- MCP endpoint: https://api.gachi-tokusuru.com/mcp (JSON-RPC; tools: get_toilet_by_station, get_public_toilet_by_city, get_station_hazard)
- REST GET /v1/station-toilets/search?station=Shinjuku  (station name English or Japanese)
- REST GET /v1/toilets/nearby?lat=&lng=&radius=&wheelchair=&ostomate=&diaper=  (radius metres, max 2000)
- REST GET /v1/stations/{station_id}/hazard  (official MLIT hazard categories at a station, relayed live; station_id e.g. st_00001)
- Auth: Authorization: Bearer <key>. Free keys: https://api.gachi-tokusuru.com
- OpenAPI: https://api.gachi-tokusuru.com/openapi.yaml
- Pricing: https://api.gachi-tokusuru.com (Free 1k, Pro $19/100k, All Access $49/200k, Business $149/500k)

## Free open datasets (citable, annually updated)
- Japan Station Master (entity-resolved, 425 stations) + Ridership 2000-2025 (station_id shared)
- Zenodo DOI: 10.5281/zenodo.21199500  (https://doi.org/10.5281/zenodo.21199500)
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
<meta name="description" content="Japan's station & accessibility data — clean, English-first, built for AI agents. MCP server, REST API, and free open datasets (station master, ridership). One key works for everything.">
<meta property="og:title" content="Gachi Data API — Japan Station & Accessibility Data (API · MCP · Open Datasets)">
<meta property="og:description" content="Japan's station & accessibility data for AI agents — MCP server, REST API, and free open datasets. One key works for everything.">
<meta property="og:type" content="website">
<meta property="og:url" content="https://api.gachi-tokusuru.com">
<meta name="twitter:card" content="summary">
<meta name="robots" content="index,follow">
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

<h1>Gachi Data API <span class="tag">Early access</span></h1>
<p class="sub">Japan's station &amp; accessibility data — clean, English-first, built for AI agents. Available as an <b>MCP</b> server, a <b>REST</b> API, and free <b>open datasets</b>. One key works for everything.</p>

<div class="demo">
<b>新宿駅 (Shinjuku) → nearest accessible toilet</b><br>
11 accessible toilets, each mapped to its <b>nearest station exit</b> — first-party data you won't find anywhere else.
</div>

<p><a href="/example" target="_blank" rel="noopener"><b>▶ See a live sample response</b></a> — no key needed, real JSON.</p>

<h2>What's inside</h2>
<ul>
<li><b>Accessibility API (live)</b> — 526 Tokyo stations with floor, gender, equipment &amp; <code>nearest_exit</code>; 612 municipalities of public toilets nationwide</li>
<li><b>Station Master (open dataset)</b> — 425 stations, entity-resolved across operators (Shinjuku = 6 companies, 1 ID), English names</li>
<li><b>Ridership 2000–2025 (open dataset)</b> — 292 stations, annual series through the COVID collapse and recovery</li>
<!-- Station Hazard is a LIVE API relay (REST GET /v1/stations/{id}/hazard + MCP get_station_hazard):
     house policy is to relay official MLIT hazard values as-is — no derived scores, no raw redistribution. -->
<li><b>Station Hazard API (live)</b> — official flood, liquefaction, landslide, storm-surge &amp; tsunami categories from MLIT, relayed live per station (REST + MCP)</li>
<li><b>More APIs launching on this data</b> — All Access subscribers get every new one automatically</li>
</ul>

<h2>Built with this data</h2>
<p><a href="https://toilet.gachi-tokusuru.com/en" target="_blank" rel="noopener">toilet.gachi-tokusuru.com</a> — a live site running entirely on this dataset. Your agent can do the same in one call.</p>

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
<p>Prefer the raw data? Our station master &amp; ridership datasets are free, citable and annually updated —
<b>station master (cross-operator, entity-resolved) &amp; ridership 2000–2025</b>.</p>
<ul>
<li><a href="${DATASETS.github}" target="_blank" rel="noopener">GitHub</a> — source + build pipeline</li>
<li><a href="${DATASETS.zenodo_url}" target="_blank" rel="noopener">Zenodo</a> — DOI <code>${DATASETS.zenodo_doi}</code> (citable archive)</li>
<li><a href="${DATASETS.kaggle}" target="_blank" rel="noopener">Kaggle</a> — notebooks &amp; discovery</li>
</ul>
<p class="mut">The newest survey year reaches API subscribers first; it lands in the free dataset at the next annual release.</p>

<h2 id="bizform-anchor">Questions or a custom need?</h2>
<p class="mut">Have a use case the plans above don't cover, or a question about the data? Tell us what you'd use it for — it shapes what we build next. Upcoming APIs (station master, ridership, hazard) are included in the relevant plans <b>as they launch</b>.</p>
<form id="bizform">
<input type="email" id="bemail" placeholder="you@example.com" required>
<textarea id="buse" rows="2" placeholder="What would you use it for? (1 line)" required></textarea>
<button type="submit">Contact us</button>
<div class="out" id="bout"></div>
</form>

<footer>
<p><b><a href="${PORTAL_URL}" target="_blank" rel="noopener">Manage or cancel your subscription →</a></b> (Pro subscribers) &nbsp;·&nbsp; contact@piachan.com</p>
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
