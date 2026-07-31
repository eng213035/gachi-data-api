// Gachi Data API — Japan Station & Accessibility Data (API · MCP · Open Datasets) — lean MVP
// - Multi-key auth (self-serve free keys stored in KV)
// - Per-plan monthly rate limiting (KV counter; eventually consistent = approximate, fine for MVP)
// - English landing page + free-key form + Business interest form
// Data served straight from KV (see build_kv_seed*.py). No D1/Stripe-webhook in this lean build.
//
// Host branching: this one Worker answers two custom domains.
//   api.gachi-tokusuru.com   — the full Gachi Data API (all 11 tools, own landing page).
//   ramen.gachi-tokusuru.com — the standalone "Japan Ramen Active Master" product: serves the
//                              ramen LP at /, and /mcp exposes ONLY the 3 ramen tools. REST /v1/shops
//                              and /keys /interest are shared infra (same KV, same key issuance).
import { RAMEN_LP_HTML } from './ramen_lp.mjs';
import { RAMEN_STORY_HTML } from './ramen_story.mjs';
import { RAMEN_SAMPLE } from './ramen_sample.mjs';

const RAMEN_HOST = 'ramen.gachi-tokusuru.com';
const RAMEN_TOOL_NAMES = new Set(['search_ramen', 'get_ramen_shop', 'get_ramen_changes', 'vibe_search']);

// api.* MCP surface is fully public (no key required): every tool is read-only and returns ONLY
// published open data / official-relay facts, one record at a time (no bulk extraction), so there is
// no data reason to gate calls. A no-key client sees all tools in tools/list and may call any of
// them, IP rate-limited by NOAUTH_LIMITER. Keys still exist for REST, higher metered volume, and the
// standalone ramen product (ramen.* stays key-gated). Ramen tools are excluded from the api.* surface.

// keito OUTPUT is the fine 19-value vocabulary as stored (champon/toripaitan/asahikawa… — 2026-07-21
// taxonomy adoption: regional schools are the product's value, expose them). KEITO_COARSE remains as
// the FILTER convenience layer: filtering by a coarse bucket (tonkotsu/miso/shoyu/shio/tsukemen/spicy/
// other) matches every fine school in that bucket, e.g. keito=tonkotsu also returns iekei/jiro shops.
const KEITO_COARSE = {
  tonkotsu: 'tonkotsu', iekei: 'tonkotsu', yokohama_iekei: 'tonkotsu', jiro: 'tonkotsu',
  miso: 'miso', sapporo: 'miso',
  shoyu: 'shoyu', chuka_tanrei: 'shoyu', kitakata: 'shoyu', kitakata_aizu: 'shoyu', niboshi: 'shoyu',
  asahikawa: 'shoyu', shirakawa: 'shoyu', sano: 'shoyu', onomichi: 'shoyu',
  shio: 'shio',
  tsukemen: 'tsukemen',
  tantanmen: 'spicy',
  abura_mazesoba: 'other', mazesoba: 'other', ramen_shop: 'other', curry: 'other', other: 'other',
  toripaitan: 'other', champon: 'other',
};
function ramenCoarseKeito(arr) {
  const out = [];
  for (const k of (arr || [])) {
    const c = KEITO_COARSE[k] || 'other';
    if (!out.includes(c)) out.push(c);
  }
  return out;
}
// keito filter: a coarse bucket value → bucket match (keito=tonkotsu also returns iekei/jiro shops,
// unchanged behavior); a fine value → EXACT fine match (keito=champon returns only champon shops,
// not the whole 'other' bucket).
const KEITO_COARSE_BUCKETS = new Set(['tonkotsu', 'miso', 'shoyu', 'shio', 'tsukemen', 'spicy', 'other']);
function ramenKeitoMatch(shopKeito, q) {
  if (KEITO_COARSE_BUCKETS.has(q)) return ramenCoarseKeito(shopKeito).includes(q);
  return (shopKeito || []).includes(q);
}

// Romaji prefecture name -> Japanese, so pref=saitama / tokyo / osaka work (English-first).
const PREF_EN_REV = {
  hokkaido: '北海道', aomori: '青森県', iwate: '岩手県', miyagi: '宮城県', akita: '秋田県',
  yamagata: '山形県', fukushima: '福島県', ibaraki: '茨城県', tochigi: '栃木県', gunma: '群馬県',
  saitama: '埼玉県', chiba: '千葉県', tokyo: '東京都', kanagawa: '神奈川県', niigata: '新潟県',
  toyama: '富山県', ishikawa: '石川県', fukui: '福井県', yamanashi: '山梨県', nagano: '長野県',
  gifu: '岐阜県', shizuoka: '静岡県', aichi: '愛知県', mie: '三重県', shiga: '滋賀県',
  kyoto: '京都府', osaka: '大阪府', hyogo: '兵庫県', nara: '奈良県', wakayama: '和歌山県',
  tottori: '鳥取県', shimane: '島根県', okayama: '岡山県', hiroshima: '広島県', yamaguchi: '山口県',
  tokushima: '徳島県', kagawa: '香川県', ehime: '愛媛県', kochi: '高知県', fukuoka: '福岡県',
  saga: '佐賀県', nagasaki: '長崎県', kumamoto: '熊本県', oita: '大分県', miyazaki: '宮崎県',
  kagoshima: '鹿児島県', okinawa: '沖縄県',
};

// Bumped on every deploy so /__version proves which build a given request hit.
const BUILD_VERSION = {
  commit: 'spice-filter-exposure-v1',
  built: '2026-07-31T20:30:00Z',
  build: 'P2-1,2 (2026-07-31 instruction #2): spice_level exposed as an explicit filter — search_ramen gains spice_level param (spicy/unknown; works on pref/city, nearby and nationwide paths; lite/geo indexes now carry spice_level for the 357 spicy shops), vibe_search gains spice_level as the canonical param name (spice kept as deprecated alias; explicit wins over query-text inference). keito(lineage) vs spice_level(attribute) orthogonality documented in both schemas. Prior deploy: toilet-dedup-romaji-namecontains-v1.',
  pricing_tiers: 5,
};

// Server icons (served at /icon.svg per host; referenced from initialize serverInfo.icon). Self-contained
// SVG so there's no external asset dependency — a ramen bowl on ramen.*, a station/data mark on api.*.
const RAMEN_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-label="Ramen bowl">
<rect width="512" height="512" rx="96" fill="#b3121b"/>
<g fill="none" stroke="#fff" stroke-width="14" stroke-linecap="round">
<path d="M188 150c0-26 20-44 44-44M256 142c0-30 22-50 48-50M322 150c0-24 18-42 40-42"/>
</g>
<path d="M104 250h304a24 24 0 0 1-4 14l-40 92a56 56 0 0 1-51 34H199a56 56 0 0 1-51-34l-40-92a24 24 0 0 1-4-14z" fill="#fff"/>
<path d="M124 268h264l-33 76a40 40 0 0 1-37 25H194a40 40 0 0 1-37-25z" fill="#f4a72b"/>
<circle cx="212" cy="312" r="26" fill="#fff"/><circle cx="212" cy="312" r="12" fill="#f4a72b"/>
<path d="M150 300c40 10 90 12 140 4" fill="none" stroke="#c8801a" stroke-width="9" stroke-linecap="round"/>
<rect x="300" y="150" width="150" height="12" rx="6" transform="rotate(24 375 156)" fill="#7a3b12"/>
<rect x="300" y="176" width="150" height="12" rx="6" transform="rotate(24 375 182)" fill="#7a3b12"/>
</svg>`;
const API_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-label="Japan data">
<rect width="512" height="512" rx="96" fill="#0b6e4f"/>
<g fill="#fff">
<ellipse cx="256" cy="176" rx="118" ry="30" opacity=".95"/>
<ellipse cx="256" cy="176" rx="118" ry="30" fill="none" stroke="#0b6e4f" stroke-width="0"/>
<path d="M138 176v72c0 17 53 30 118 30s118-13 118-30v-72c0 17-53 30-118 30s-118-13-118-30z" opacity=".8"/>
<path d="M138 256v72c0 17 53 30 118 30s118-13 118-30v-72c0 17-53 30-118 30s-118-13-118-30z" opacity=".65"/>
</g>
<path d="M256 300c-40 0-72 32-72 72 0 54 72 118 72 118s72-64 72-118c0-40-32-72-72-72z" fill="#fff"/>
<circle cx="256" cy="372" r="30" fill="#0b6e4f"/>
</svg>`;

const PLAN_LIMITS = { free: 1000, pro: 100000, all_access: 200000, business: 500000, enterprise: Infinity, ramen_pro: Infinity, admin: Infinity };

// ---- Pricing model -------------------------------------------------------------------------------
// Two tiers only: Free (nationwide, keyless or Free key, 60 req/min IP + 1,000/mo per key) and Pro
// (unlimited volume, higher QPS, REST, commercial licence). The former 7-day / 3-prefecture "trial"
// plan was retired 2026-07-22 — every ramen data surface is nationwide on Free. Legacy gk_trial_
// keys still in KV are coerced to plan:'free' in resolveAuth so they keep working, never error.
const RAMEN_UPGRADE_URL = 'https://ramen.gachi-tokusuru.com';

// Paid-plan metadata for key issuance + the activation success page.
const PLAN_META = {
  pro:        { prefix: 'gk_pro_',  label: 'Pro',        stat: 'stat:pro_keys_issued',        product: 'gachi' },
  all_access: { prefix: 'gk_all_',  label: 'All Access', stat: 'stat:all_access_keys_issued',  product: 'gachi' },
  business:   { prefix: 'gk_biz_',  label: 'Business',   stat: 'stat:business_keys_issued',    product: 'gachi' },
  // Standalone Ramen product: $500/mo, unlimited, scoped to the ramen dataset only.
  ramen_pro:  { prefix: 'gk_rpro_', label: 'Ramen Pro',  stat: 'stat:ramen_pro_keys_issued',   product: 'ramen' },
};
// Plan is detected from the paid amount (USD cents). Amounts are distinct, so this is
// unambiguous without needing Stripe price IDs (the restricted key can't read them).
// If a future plan reuses an amount, add it here.
const AMOUNT_TO_PLAN = { 1900: 'pro', 4900: 'all_access', 14900: 'business', 50000: 'ramen_pro' };

// Payment Links (Stripe). Pro / All Access / Business are the general Gachi Data API plans.
// ramen_pro is the standalone $500/mo Ramen product link (success_url → /activate).
const PAYMENT_LINKS = {
  pro: 'https://buy.stripe.com/cNi6oHaKhaZp8mJ6Rh3Ru04',
  all_access: 'https://buy.stripe.com/6oU8wP05D2sTdH36Rh3Ru02',
  business: 'https://buy.stripe.com/3cIbJ18C9d7xdH30sT3Ru03',
  ramen_pro: 'https://buy.stripe.com/aFa9AT2dLebB46t4J93Ru05',
};
// Stripe TEST-mode ($500/mo) link for sandbox payment testing. Reached via /subscribe?test=1.
// Its checkout produces cs_test_* sessions, verified in activate() with STRIPE_SECRET_KEY_TEST (sk_test_*).
const PAYMENT_LINK_RAMEN_PRO_TEST = 'https://buy.stripe.com/test_3cIfZh6wu6AAh0tfTN57W00';

// ---- ping (connection test / health check) ------------------------------------------------------
// Shown on BOTH hosts (special-cased in visibleTools). Not a bare pong: it self-proves data freshness.
// Response + metadata are host-specific (ramen: active-shop count + last crawl date; api: tool count +
// realtime snapshot update times). Numbers are read live from KV (cheap single gets) so they never rot
// into a stale hardcoded value. No auth, no args — counted in the normal no-auth rate limit.
const STATIONS_COVERED = 526; // Tokyo Bureau of Social Welfare accessible-toilet dataset (fixed size).
const PING_DESC_RAMEN =
  'Connection test / health check — call this first to confirm the server is reachable. Returns server '
  + 'identity, deploy version, and live data freshness (active shop count + the latest weekly-crawl date) '
  + 'so you can confirm the data is current, not just that the server is up. No auth, no arguments, lightweight.';
const PING_DESC_API =
  'Connection test / health check — call this first to confirm the server is reachable. Returns server '
  + 'identity, deploy version, tool count, station coverage, and the update times of the realtime layers '
  + '(JMA alerts, train status) so you can confirm freshness, not just liveness. No auth, no arguments, lightweight.';
const pingLeaf = (description) => ({ description });
const PING_OUTPUT_SCHEMA_RAMEN = {
  type: 'object', additionalProperties: true,
  description: 'Health check: server identity + live ramen-data freshness.',
  properties: {
    status: pingLeaf('Always "ok" when the server is reachable.'),
    server: pingLeaf('Server name.'),
    version: pingLeaf('Deploy version.'),
    shops_active: pingLeaf('Live count of active ramen shops in the dataset.'),
    last_weekly_crawl: pingLeaf('Date the dataset was last refreshed (YYYY-MM-DD).'),
    coverage: pingLeaf('Geographic coverage.'),
    rate_limit_noauth: pingLeaf('No-auth rate limit.'),
  },
};
const PING_OUTPUT_SCHEMA_API = {
  type: 'object', additionalProperties: true,
  description: 'Health check: server identity + realtime-layer freshness.',
  properties: {
    status: pingLeaf('Always "ok" when the server is reachable.'),
    server: pingLeaf('Server name.'),
    version: pingLeaf('Deploy version.'),
    tools: pingLeaf('Number of tools exposed by this server.'),
    stations_covered: pingLeaf('Stations with accessible-toilet data.'),
    realtime_layers: {
      type: 'object', additionalProperties: true,
      description: 'Update times of the realtime KV snapshots (a field is omitted if that layer is unavailable).',
      properties: {
        jma_alerts_updated: pingLeaf('When the JMA alerts snapshot was last fetched.'),
        train_status_updated: pingLeaf('When the train-status snapshot was last fetched.'),
      },
    },
    rate_limit_noauth: pingLeaf('No-auth rate limit.'),
  },
};

const TOOLS = [
  {
    name: 'ping',
    description: PING_DESC_API,
    inputSchema: { type: 'object', properties: {} },
    outputSchema: PING_OUTPUT_SCHEMA_API,
  },
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
      "Same official municipality data as get_municipality_context, resolved from a station: pass a station name (Shinjuku / 新宿 / Musashi-Kosugi) or a Japan Station Master station_id (e.g. st_00001), and it returns the context for that station's municipality. Official values only — no scores.",
    inputSchema: {
      type: 'object',
      properties: {
        station_name: { type: 'string', description: 'Station name in English/romaji (Shinjuku) or Japanese (新宿). Provide this or station_id.' },
        station_id: { type: 'string', description: 'Japan Station Master station_id (e.g. st_00001). Alternative to station_name.' },
        fields: { type: 'string', description: 'Optional comma-separated subset: vacancy,ridership,population,hazard,land_price,livability.' },
      },
      required: [],
    },
  },
  {
    name: 'get_toilet_by_station',
    description:
      'Look up wheelchair-accessible / multipurpose toilets inside a train station, ' +
      'including floor, gender, equipment (wheelchair, ostomate, diaper table) and the nearest exit. ' +
      'Covers 526 Tokyo stations (Tokyo Bureau of Social Welfare data). Major stations outside Tokyo ' +
      '(Yokohama, Kawasaki, Omiya, Chiba, Fujisawa, Shin-Yokohama…) return an in-station layer that groups ' +
      'accessible toilets by ticket gate — inside vs outside — per railway operator. ' +
      'Accepts Japanese (新宿, 横浜) or romaji (Shinjuku, Yokohama) for major stations.',
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
    name: 'station_search',
    description:
      'Discover Japanese train stations by describing what you want around them, in English or Japanese — ' +
      '"朝ラーメンが食べられて車椅子トイレがある駅", "terminal station with late-night ramen", "水害リスクが低くてラーメンが多い駅". ' +
      'Semantic search over 9,035 station profiles (lines/terminal size, ramen density & styles, in-station ' +
      'accessible-toilet equipment, official hazard categories, ridership) with hybrid metadata filters — ' +
      'the filters guarantee the constraint, the embedding ranks by fit. Filter intent in the query text ' +
      '(朝ラー/深夜/おむつ/車椅子/水害リスク低…) is auto-applied (filter_source: inferred); explicit params win. ' +
      'Water-hazard intent (水害/洪水/浸水/高潮…リスク低) expands to flood rank AND storm-surge zone; 液状化/地盤 intent ' +
      'filters on the official liquefaction-tendency category; results carry risk_notes when other official hazard ' +
      'categories are high. Inferred facility filters with partial data coverage (おむつ/車椅子 — Tokyo-only data) ' +
      'BOOST confirmed stations instead of excluding unknowns (see soft_filters); explicit params remain strict. ' +
      'Taste/quality words (うまい, "good food", delicious…) are not evaluated (no review data); ramen ranking ' +
      'reflects shop density and style variety only. name_contains gives exact substring matching on station names ' +
      '(日本語/romaji) when the name itself is the requirement. ' +
      'Coverage notes: toilet stats = Tokyo stations only; ridership = Greater Tokyo operators only; hazard = ' +
      'official MLIT categories relayed as-is, NOT a safety judgment. ' +
      'Role split: station_search finds candidate stations — then get_toilet_by_station / search_ramen / ' +
      'get_station_hazard / get_station_context for detail on one station.',
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: 'Natural-language description of the station/area you want (ja/en). Concrete attribute words (朝ラー, wheelchair toilet, terminal, 水害リスク低) match best.' },
        name_contains: { type: 'string', description: 'Substring filter on the station name (matches both 日本語 name_ja and romaji name, e.g. "谷" or "sakura"). ANDs with other filters; q still ranks the matches. Use for "stations whose name contains X" requests that semantic search cannot guarantee.' },
        pref: { type: 'string', description: 'Optional prefecture filter, Japanese (東京都, 千葉 OK) or romaji (tokyo/osaka). Auto-inferred from the query text when omitted.' },
        limit: { type: 'number', description: 'Max results (default 10; max 20, or 300 when name_contains is given — set limit >= name_matches_total for exhaustive name-match coverage).' },
        morning_ramen: { type: 'boolean', description: 'Require morning-ramen availability nearby (auto-inferred from 朝ラー/morning…).' },
        late_ramen: { type: 'boolean', description: 'Require late-night ramen nearby (auto-inferred from 深夜/late night…).' },
        ramen_min: { type: 'number', description: 'Require at least this many ramen shops nearby (e.g. 30).' },
        accessible_toilet_min: { type: 'number', description: 'Require at least this many in-station accessible toilets (Tokyo stations only; auto-inferred from 車椅子/wheelchair…).' },
        diaper: { type: 'boolean', description: 'Require a diaper changing table in station toilets (auto-inferred from おむつ/子連れ…).' },
        flood_rank_max: { type: 'number', description: 'Max official flood inundation-depth rank 0–6 (0 = no assumed inundation; auto-inferred from 水害リスク低/flood-safe…).' },
      },
      required: ['q'],
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
  {
    name: 'search_ramen',
    description:
      'Search a nationwide Japanese ramen-shop database (62,000+ shops, all 47 prefectures) with a ' +
      'verifiable freshness layer: monthly source checks, closure candidates, and web-verified closures ' +
      'with evidence URLs. English-first: shop names and places are searchable in Japanese OR romaji. ' +
      'To answer "is there a ramen shop called X?", pass q alone — it searches NATIONWIDE by name ' +
      '(e.g. q=一蘭 or q=ichiran, no prefecture needed). Or filter by prefecture (東京都/大阪府/〇〇県 ' +
      'or romaji tokyo/osaka/saitama), city (松戸市 or romaji kawaguchi), ramen style (keito), ' +
      'status (active/closed_candidate/closed_confirmed), or search near a coordinate (lat/lng + radius ' +
      'up to 5 km). Facts only — no rankings, no reviews. Payment/midnight fields are tri-state (true/false/null=unknown).',
    inputSchema: {
      type: 'object',
      properties: {
        pref: { type: 'string', description: 'Prefecture, Japanese (千葉県; short forms 千葉/東京) OR romaji (chiba/tokyo/saitama/osaka). Optional if city, q, or lat/lng is given.' },
        city: { type: 'string', description: 'Municipality, Japanese (松戸市, 世田谷区) OR romaji (kawaguchi, setagaya). Works alone — prefecture is auto-resolved (add pref if the romaji is ambiguous).' },
        keito: { type: 'string', description: 'Optional ramen-style filter. Coarse bucket (tonkotsu, miso, shoyu, shio, tsukemen, spicy, other) matches every school in the bucket — tonkotsu also covers iekei/家系 & jiro/二郎. Or an exact fine value from the 19-value vocabulary: iekei, jiro, tsukemen, tantanmen, abura_mazesoba, chuka_tanrei, champon, toripaitan, sapporo, asahikawa, kitakata_aizu, shirakawa, sano, onomichi… (keito=champon returns only champon shops). ~23% of shops carry a style; the rest are unclassified.' },
        status: { type: 'string', description: 'Optional: active (default: all) / closed_candidate / closed_confirmed.' },
        spice_level: { type: 'string', description: 'Optional spiciness ATTRIBUTE filter: "spicy" (357 shops whose signature is spiciness — dual-verified, never guessed) or "unknown" (no spice data). Orthogonal to keito: keito is the style lineage, spice_level is an attribute — keito=spicy (coarse bucket, effectively tantanmen) does NOT mean the shop is spicy.' },
        chain: { type: 'string', description: 'Optional chain filter on the curated chain label (e.g. chain=ラーメンショップ matches the whole family incl. ラーショ/うまいラーメンショップ variants; also 山岡家, 一蘭, 天下一品…). Works nationwide alone or combined with pref/city/nearby. Unlike q, this is curated membership, not a name substring.' },
        chain_sub: { type: 'string', description: 'Optional sub-lineage within a chain (currently for chain=ラーメンショップ): tsubaki (椿系), aji_q (アジキュー系), new_rasho (ニュー系), satsumakko (さつまっ子系), 105, kaizan (かいざん系). Exact value match; combine with chain or use alone.' },
        q: { type: 'string', description: 'Shop-name substring, Japanese OR romaji/English (e.g. 一蘭 or ichiran, 豚坂下 or butasakashita). Works NATIONWIDE on its own — pass q with no pref/city to check if a shop exists anywhere.' },
        match: { type: 'string', description: "How q matches: 'partial' (default, substring) or 'exact' (whole word on the romaji name — q=ojiya finds 王子家/Ojiya but not 糀谷/Kojiya). Use exact to avoid coincidental substring hits." },
        lat: { type: 'number', description: 'Optional latitude for nearby search (with lng).' },
        lng: { type: 'number', description: 'Optional longitude for nearby search (with lat).' },
        radius_m: { type: 'number', description: 'Nearby search radius in metres (default 1500, max 5000).' },
        limit: { type: 'number', description: 'Max results (default 20, max 50).' },
      },
    },
  },
  {
    name: 'get_ramen_shop',
    description:
      'Fetch one ramen shop by its stable id (rk_000001 style) — full record incl. address, coordinates, ' +
      'ramen style (keito), nearest station (Japan Station Master st_xxxx id + distance), tri-state payment ' +
      'facts, and the freshness block (first_seen/last_seen/status/closure evidence URL). ' +
      'No id? Pass name + pref instead and the best match is returned.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Stable shop id, e.g. rk_000851. Preferred.' },
        name: { type: 'string', description: 'Shop name (Japanese) — used with pref or city when id is unknown.' },
        pref: { type: 'string', description: 'Prefecture (千葉県; short form 千葉 also OK) — pref or city required with name.' },
        city: { type: 'string', description: 'Municipality (e.g. 松戸市) — alternative to pref; prefecture auto-resolved.' },
      },
    },
  },
  {
    name: 'get_ramen_changes',
    description:
      'Monthly change feed for the ramen DB — new shops, closure candidates (missing from the monthly web source ' +
      '2 consecutive checks or marked disused/closed), web-verified closures (closed_confirmed, with evidence ' +
      'URL) and reopenings. This is the freshness signal you cannot cache: poll it to keep a local copy honest. ' +
      'Optional since (YYYY-MM-DD) returns only events on/after that date.',
    inputSchema: {
      type: 'object',
      properties: { since: { type: 'string', description: 'Optional ISO date (YYYY-MM-DD), inclusive.' } },
    },
  },
  {
    name: 'vibe_search',
    description:
      'Semantic / vibe search over the same nationwide ramen DB — describe what you feel like eating in ' +
      'natural language, English or Japanese ("rich creamy pork broth", "あっさり淡麗な醤油", "oily mazesoba", ' +
      '"tsukemen near Ebisu station"), and get the closest shops by meaning, each with a similarity score. ' +
      'Powered by multilingual embeddings (bge-m3), so English queries find shops with Japanese-only names. ' +
      'Role split: use search_ramen for exact facts (shop name lookup, keito/prefecture/status filters, ' +
      'geo radius) — use vibe_search for descriptive/fuzzy queries where no exact filter fits. ' +
      'Style rankings reflect only classified shops (~25%); unclassified shops still match by name and place. ' +
      'Tip: concrete food words (style, broth, richness, place, hours) match far better than abstract mood ' +
      'words ("stylish", "hardcore") — translate moods into concrete attributes before querying. ' +
      'Prefecture intent in the query text (北海道, 博多の…) is auto-applied as a filter (pref_source: inferred); ' +
      'region-style names (札幌ラーメン, 喜多方, 佐野…) stay pure style words and never restrict location.',
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: 'Natural-language description, English or Japanese (e.g. "rich creamy pork bone broth", "辛い味噌", "brothless oily noodles").' },
        limit: { type: 'number', description: 'Max results (default 10, max 20).' },
        pref: { type: 'string', description: 'Optional prefecture filter, Japanese (東京都/千葉県, short 千葉 OK) or romaji (tokyo/osaka).' },
        status: { type: 'string', description: "Optional: active (default) / closed_confirmed / all." },
        richness: { type: 'string', description: 'Optional broth-richness filter from official-site enrichment: assari / kotteri / futsu / menu_varies. Auto-inferred from the query text (あっさり/こってり…) when omitted.' },
        hours: { type: 'string', description: 'Optional hours filter: morning / late_night / 24h. Auto-inferred from the query text (朝/深夜/24時間…) when omitted.' },
        spice_level: { type: 'string', description: 'Optional spiciness ATTRIBUTE filter: "spicy" (shops whose signature is spiciness — chain signage or shop-name signal, dual-verified; ~1% of shops). Explicit value wins over query-text inference (辛い/激辛/オロチョン/spicy…; negations like 辛くない do not trigger). Orthogonal to keito: keito is style lineage, spice_level is an attribute — tantanmen alone never implies spicy.' },
        spice: { type: 'string', description: 'Deprecated alias of spice_level (kept for backward compatibility).' },
      },
      required: ['q'],
    },
  },
];

// ---- Capability metadata: annotations + output schemas ------------------------------------------
// Raises Smithery's Capability Quality (Output schemas + Annotations) and sharpens tool selection in
// every MCP client. All tools are strictly read-only and never mutate anything (destructiveHint:false,
// idempotentHint:true). Realtime relays reach the live outside world (openWorldHint:true); DB/KV
// lookups are a closed domain (false). Output schemas are OPEN objects (documented top-level fields,
// additionalProperties allowed, nothing required) so both success and error payloads validate against
// the structuredContent we now return.
const REALTIME_TOOLS = new Set(['get_station_hazard', 'get_active_alerts', 'get_station_alerts', 'get_train_status']);
const TOOL_TITLES = {
  ping: 'Connection test / health check',
  get_municipality_context: 'Municipality context (official data)',
  get_station_context: 'Station-area context (official data)',
  get_toilet_by_station: 'Accessible toilets in a station',
  get_public_toilet_by_city: 'Public toilets in a city',
  get_station_hazard: 'Station disaster-risk (official)',
  station_search: 'Station discovery (semantic + filters)',
  get_active_alerts: 'Live JMA flood/landslide alerts',
  get_station_alerts: 'Live JMA alerts near a station',
  get_train_status: 'Live Tokyo-area train status',
  search_ramen: 'Search ramen shops (nationwide)',
  get_ramen_shop: 'Get one ramen shop',
  get_ramen_changes: 'Ramen DB change feed',
  vibe_search: 'Semantic vibe search (ramen)',
};
// Leaf/nested fields are documented by name + description but left type-flexible: real payloads use
// unions the way live data does (attribution is an object OR an array of sources; keito/coverage are
// strings OR arrays; some fields are null when data is absent; definitions is a note string in the
// no-auth preview). Only the root and array-of-record fields carry a `type`, so structuredContent
// always validates — success and error payloads alike — while agents still see the field map.
const s = (description) => ({ description });                          // scalar/variant leaf (may be null)
const obj = (description) => ({ description });                        // nested object (may be null/absent)
const arr = (description) => ({ type: 'array', description, items: { type: 'object', additionalProperties: true } });
const ATTR_PROP = { attribution: s('Data source(s), license and provenance — an object, or an array of sources.') };
const openObj = (properties, description) => ({ type: 'object', description, properties: { ...properties, ...ATTR_PROP }, additionalProperties: true });
const RAMEN_SHOP_ITEM = {
  type: 'object', additionalProperties: true,
  properties: {
    id: s('Stable shop id (rk_000851).'),
    name: s('Shop name (Japanese).'),
    name_en: s('Romanized/English name.'),
    pref: s('Prefecture.'), city: s('Municipality.'),
    keito: s('Ramen style(s) if classified — fine 19-value vocabulary (tonkotsu/champon/toripaitan/asahikawa…); [] = unclassified.'),
    status: s('active / closed_candidate / closed_confirmed.'),
  },
};
const TOOL_OUTPUT_SCHEMAS = {
  search_ramen: openObj({
    query: obj('Echo of the resolved query.'), count: s('Results returned.'), total_matched: s('Total matches before limit.'),
    shops: { type: 'array', description: 'Matching shops.', items: RAMEN_SHOP_ITEM }, note: s('Human-readable note.'),
    data_as_of: s('Dataset freshness date (YYYY-MM-DD).'),
  }, 'Ramen search results with freshness metadata.'),
  get_ramen_shop: openObj({
    shop: RAMEN_SHOP_ITEM, definitions: obj('Field definitions (or a note string in the no-auth preview).'),
    data_as_of: s('Dataset freshness date.'), error: s('Set when the shop was not found.'),
  }, 'One ramen shop (full record) or an error.'),
  get_ramen_changes: openObj({
    dataset: s('Dataset id.'), generated_at: s('Feed generation timestamp.'), since: s('Echo of the since filter.'),
    count: s('Number of events.'), events: arr('Change events (new / closure_candidate / closed_confirmed / reopened).'),
    definitions: obj('Event-type definitions (or a note string in the no-auth preview).'),
    window: obj('Time window covered.'), data_as_of: s('Dataset freshness date.'),
  }, 'Change feed: new shops, closure candidates, verified closures, reopenings.'),
  vibe_search: openObj({
    query: obj('Echo of the resolved query.'), count: s('Results returned.'),
    shops: { type: 'array', description: 'Closest shops by meaning, best first.', items: { ...RAMEN_SHOP_ITEM, properties: { ...RAMEN_SHOP_ITEM.properties, similarity: s('Cosine similarity of this shop to the query (0–1, higher = closer).') } } },
    note: s('Human-readable note.'), data_as_of: s('Dataset freshness date (YYYY-MM-DD).'),
  }, 'Semantic search results (lite shape + similarity score).'),
  get_toilet_by_station: openObj({
    station: s('Resolved station (English).'), station_ja: s('Station name in Japanese.'), station_name_source: s('How the name was resolved.'),
    count: s('Toilets returned.'), layer: s('Data layer (e.g. in_station_gate).'),
    toilets: arr('Accessible toilets with floor, gender, equipment and nearest exit.'), source: s('Data source label.'),
    note: s('Human-readable note.'), error: s('Set when nothing was found.'),
  }, 'Wheelchair-accessible / multipurpose toilets inside a station.'),
  get_public_toilet_by_city: openObj({
    city: s('Resolved municipality.'), count: s('Toilets returned.'),
    toilets: arr('Public toilets with wheelchair / baby-seat / ostomate flags, address and coordinates.'),
    note: s('Human-readable note.'), error: s('Set when nothing was found.'),
  }, 'Public toilets in a municipality.'),
  get_station_hazard: openObj({
    station: obj('Resolved station + coordinates.'),
    hazard: obj('Official categories: flood inundation depth, landform/liquefaction, storm-surge.'),
    disclaimer: s('Usage disclaimer (not a substitute for official maps).'),
  }, 'Official disaster-risk categories at a station (MLIT relay).'),
  station_search: openObj({
    query: s('Echo of the query.'), count: s('Results returned.'),
    applied_filters: obj('Hard metadata filters actually applied (explicit + inferred; includes name_contains when given).'),
    name_matches_total: s('Total stations whose name matched name_contains (before ranking/limit). Present only in name_contains mode.'),
    soft_filters: arr('Inferred facility filters applied as a score BOOST (confirmed stations get +BOOST on similarity = final_score; unknown/missing never excluded), with coverage note. Present only when active.'),
    filter_source: s('explicit / inferred / none — how the filters were chosen.'),
    stations: arr('Matching stations, best first: name, pref, similarity, ramen stats, toilet stats, official hazard categories (plus risk_notes when an official hazard category not covered by the filter is high), lines, ridership.'),
    note: s('Present when the query contains taste/quality words: they are not evaluated (no review data).'),
    notes: s('Coverage caveats (toilet stats Tokyo-only, ridership Greater-Tokyo-only).'),
    stats_as_of: s('Freshness of the underlying ramen stats (YYYY-MM-DD).'),
    disclaimer: s('Hazard usage disclaimer.'),
  }, 'Semantic station discovery with hybrid filters.'),
  get_active_alerts: openObj({
    coverage: s('What this feed covers — string or array of categories.'), fetched_at: s('When the snapshot was fetched.'),
    stale: s('True if the snapshot is stale.'), count: s('Number of active alerts.'),
    alerts: arr('Active JMA river-flood / landslide alerts with level, area, summary, issue time.'),
    source: s('Source label.'), disclaimer: s('Relay disclaimer (not a warning issued by this service).'),
  }, 'Live JMA river-flood & landslide alerts.'),
  get_station_alerts: openObj({
    station: obj('Resolved station.'), fetched_at: s('When the snapshot was fetched.'), stale: s('True if stale.'),
    count: s('Number of alerts.'), alerts: arr('JMA alerts affecting the prefecture.'),
    disclaimer: s('Relay disclaimer.'),
  }, "Live JMA alerts for a station's prefecture."),
  get_train_status: openObj({
    query: s('Echo of the query.'), fetched_at: s('When the snapshot was fetched.'), stale: s('True if stale.'),
    count: s('Number of lines.'), lines: arr('Per-line status: normal / delayed / suspended / resumed, with cause.'),
  }, 'Live Tokyo-area train service status.'),
  get_municipality_context: openObj({
    municipality: obj('Resolved municipality + code.'), vacancy: obj('Housing-vacancy counts (2003–2023).'),
    ridership: obj('Nearest-station ridership trend.'), population: obj('Population / future estimate.'),
    hazard: obj('Hazard categories.'), hazard_disclaimer: s('Hazard usage disclaimer.'),
    land_price: obj('Published land prices near the centroid.'), livability: obj('Livability counts.'),
  }, 'Official municipality data (vacancy, ridership, hazard, land price, livability).'),
  get_station_context: openObj({
    station: obj('Resolved station.'), municipality: obj('Municipality + code.'), vacancy: obj('Housing-vacancy counts.'),
    ridership: obj('Ridership trend.'), population: obj('Population / future estimate.'), hazard: obj('Hazard categories.'),
    land_price: obj('Land prices near the centroid.'), livability: obj('Livability counts.'),
  }, "Official data for a station's municipality."),
};
for (const t of TOOLS) {
  t.annotations = {
    title: TOOL_TITLES[t.name] || t.name,
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: REALTIME_TOOLS.has(t.name),
  };
  if (TOOL_OUTPUT_SCHEMAS[t.name]) t.outputSchema = TOOL_OUTPUT_SCHEMAS[t.name];
}

async function lookup(env, prefix, query) {
  const exact = await env.TOILET_KV.get(`${prefix}${query}`, 'json');
  if (exact) return exact;

  // romaji alias: "Shinjuku" / "Kita-Senju" -> 日本語駅名 (station prefix only)
  // 正規化 = 小文字化 → マクロン折り畳み(ō→o等・NFD分解で結合記号除去) → 非英数除去
  if (prefix === 'toilet:' && /[a-zA-Z]/.test(query)) {
    const norm = query.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');
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
    operator: r.operator ?? null,          // in-station层: 事業者名 (JR東日本 等)
    gate: r.gate ?? null,                   // 'inside' | 'outside' | null (改札内/外)
    gate_ja: r.gate_ja ?? null,
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
  // en: = ODPT公式英語名 / eng: = Station Master由来の生成別名(P2-b) — 由来を混同しない
  const en = await env.TOILET_KV.get(`en:${found.station}`);
  const eng = en ? null : await env.TOILET_KV.get(`eng:${found.station}`);
  return {
    station: en || eng || found.station,
    station_ja: found.station,
    station_name_source: en ? 'odpt' : eng ? 'romaji_generated' : 'japanese_fallback',
    count: found.count,
    layer: found.layer ?? null,     // 'in_station_gate' = 改札内/外つき(都外主要駅) / null = 東京都福祉局の多目的
    toilets: (found.toilets || []).map(toEnglishToilet),
    source: found.source ?? null,
    note: found.note ?? null,
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
// A tool result: the serialized JSON as a text block (universal) AND structuredContent (MCP 2025-06-18).
// Declaring an outputSchema per tool means spec-conformant clients expect structuredContent, so every
// tool payload is mirrored here. The payload object is unchanged — same data, same fields.
function mcpResult(id, payload) {
  return rpcResult(id, {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  });
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
    return { ok: true, plan: 'admin', product: 'all', token };
  }
  const record = await env.TOILET_KV.get(`key:${token}`, 'json');
  if (!record || record.status !== 'active') return { ok: false };
  // Legacy trial keys (retired plan) are coerced to Free — they keep working nationwide, never error,
  // and expiry is no longer enforced. New keys are only ever 'free' or a paid plan.
  const plan = record.plan === 'trial' ? 'free' : (record.plan || 'free');
  // product scope: 'ramen' | 'gachi' | 'all'. Legacy keys (no product) default to 'gachi' so a key
  // issued via the general API can NEVER reach the standalone ramen product (fail-closed).
  return { ok: true, plan, product: record.product || 'gachi', token };
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

// All keyed plans meter PER MONTH. Returns { allowed, used, limit, daily:false } — `daily` is kept
// for callers that word the limit message, always false now that the daily-metered trial is gone.
async function meterUsageFor(env, auth) {
  return { ...(await meterUsage(env, auth.token, auth.plan)), daily: false };
}

async function issueFreeKey(env, email, product = 'gachi') {
  const token = randToken('gk_free_');
  const record = { plan: 'free', email, product, status: 'active', created: new Date().toISOString() };
  await env.TOILET_KV.put(`key:${token}`, JSON.stringify(record));
  // bump a simple issuance counter (KPI)
  const c = parseInt((await env.TOILET_KV.get('stat:keys_issued')) || '0', 10);
  await env.TOILET_KV.put('stat:keys_issued', String(c + 1));
  return token;
}

// No-auth usage counters. The Free tier is keyless (rate-limit only), so per-key metering can't see it —
// these daily tallies are the ONLY way to tell whether the public MCP/REST endpoints are actually being
// called (e.g. after outreach). Fire-and-forget via waitUntil so counting never adds latency or can fail
// the response. Read-modify-write is eventually consistent (may undercount under bursts) — fine for a KPI.
// Per-host, per-method MCP usage: stat:mcp:<api|ramen>:<call|list>:<YYYY-MM-DD> (self-expire ~100d).
// Counts ALL tools/call + tools/list (keyed AND no-auth) that reach the dispatcher — so we can tell
// real tool USE (call) apart from directory/connector introspection (list), separately per product.
function bumpMcpMethodStat(env, ctx, host, method) {
  const short = method === 'tools/call' ? 'call' : method === 'tools/list' ? 'list' : null;
  if (!short) return;
  const key = `stat:mcp:${host}:${short}:${new Date().toISOString().slice(0, 10)}`;
  const p = (async () => {
    try {
      const c = parseInt((await env.TOILET_KV.get(key)) || '0', 10);
      await env.TOILET_KV.put(key, String(c + 1), { expirationTtl: 100 * 86400 });
    } catch (e) { /* never let counting affect serving */ }
  })();
  if (ctx && ctx.waitUntil) ctx.waitUntil(p); else p.catch(() => {});
}

// Counterpart to bumpMcpMethodStat for our OWN scripts (x-gachi-internal: 1) — same shape, separate
// key, so internal QA/benchmark traffic never inflates the external-usage KPI but a spike is still
// visible if we go looking. Key: stat:mcp:internal:<api|ramen>:<call|list>:<YYYY-MM-DD>.
function bumpInternalStat(env, ctx, host, method) {
  const short = method === 'tools/call' ? 'call' : method === 'tools/list' ? 'list' : null;
  if (!short) return;
  const key = `stat:mcp:internal:${host}:${short}:${new Date().toISOString().slice(0, 10)}`;
  const p = (async () => {
    try {
      const c = parseInt((await env.TOILET_KV.get(key)) || '0', 10);
      await env.TOILET_KV.put(key, String(c + 1), { expirationTtl: 100 * 86400 });
    } catch (e) { /* never let counting affect serving */ }
  })();
  if (ctx && ctx.waitUntil) ctx.waitUntil(p); else p.catch(() => {});
}

// Channel attribution via ?ref=<tag>. Purpose: measure which posting channel (r/ClaudeAI vs r/mcp vs
// HN vs dev.to …) produces actual CONNECTIONS, not impressions. A client opening the MCP URL with
// ?ref=rmcp is counted on initialize (handshake = someone wired the connection up) and on every
// tools/call (real use) — the two events that mean "a human from this channel connected and used it".
// Key: ref:<YYYY-MM-DD>:<api|ramen>:<ref>:<initialize|tools_call> (UTC date, matching stat:mcp so the
// buckets line up; self-expire ~120d). Requests with NO ref are not counted — the stat:mcp:* host
// totals already hold everything, so "no ref" = total minus the sum of the ref buckets. Observation
// only: ref NEVER changes the response, and no IP/UA is ever stored next to it.
// Normalize defensively so a hostile or malformed ?ref can't pollute logs or explode the keyspace:
// lowercase, keep only [a-z0-9-], cap at 16 chars; empty-after-strip -> not counted.
function normalizeRef(raw) {
  if (!raw) return null;
  const r = String(raw).toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 16);
  return r || null;
}
function bumpRefStat(env, ctx, host, rawRef, method) {
  const label = method === 'initialize' ? 'initialize' : method === 'tools/call' ? 'tools_call' : null;
  if (!label) return;
  const ref = normalizeRef(rawRef);
  if (!ref) return;
  const key = `ref:${new Date().toISOString().slice(0, 10)}:${host}:${ref}:${label}`;
  const p = (async () => {
    try {
      const c = parseInt((await env.TOILET_KV.get(key)) || '0', 10);
      await env.TOILET_KV.put(key, String(c + 1), { expirationTtl: 120 * 86400 });
    } catch (e) { /* never let counting affect serving */ }
  })();
  if (ctx && ctx.waitUntil) ctx.waitUntil(p); else p.catch(() => {});
}

// Per-tool daily counter, ramen host ONLY. Sole purpose: retention — did day-1 connectors come back
// a week later and call anything? Keys: stats:<JST-YYYY-MM-DD>:<toolName|initialize>. JST so a "day"
// matches how we report it. tools/call is bucketed by tool name; initialize is counted as a proxy for
// a connection attempt. No IP/UA (privacy + KV write volume — the raw CF logs already have those).
// Async via waitUntil — never on the serving path; a KV failure must not touch the response.
function bumpRamenToolStat(env, ctx, method, toolName) {
  let label = null;
  if (method === 'initialize') label = 'initialize';
  else if (method === 'tools/call' && toolName) label = toolName;
  if (!label) return;
  const p = (async () => {
    try {
      const jst = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
      const key = `stats:${jst}:${label}`;
      const c = parseInt((await env.TOILET_KV.get(key)) || '0', 10);
      await env.TOILET_KV.put(key, String(c + 1), { expirationTtl: 120 * 86400 });
    } catch (e) { /* counting must never affect serving */ }
  })();
  if (ctx && ctx.waitUntil) ctx.waitUntil(p); else p.catch(() => {});
}

// Keys: stat:ramen_noauth:<mcp|rest>:<YYYY-MM-DD>, self-expiring after ~100 days.
function bumpNoauthStat(env, ctx, kind) {
  const p = (async () => {
    try {
      const day = new Date().toISOString().slice(0, 10);
      const key = `stat:ramen_noauth:${kind}:${day}`;
      const c = parseInt((await env.TOILET_KV.get(key)) || '0', 10);
      await env.TOILET_KV.put(key, String(c + 1), { expirationTtl: 100 * 86400 });
    } catch (e) { /* never let counting affect serving */ }
  })();
  if (ctx && ctx.waitUntil) ctx.waitUntil(p); else p.catch(() => {});
}

// Approximate per-IP + global daily cap on free-key minting (abuse backstop against mass automated
// key creation). KV is eventually consistent → soft limit, not a hard gate, but enough to stop
// scripted minting. Applied ONLY at human-facing entry points (/keys, /authorize approve) where
// cf-connecting-ip is the real user — NOT /token or /register (called by claude.ai's shared backend IPs).
async function mintRateLimit(env, request, perIp = 20, globalCap = 1000) {
  const ip = request.headers.get('cf-connecting-ip') || 'noip';
  const day = new Date().toISOString().slice(0, 10);
  const ipK = `mint:${ip}:${day}`;
  const ipN = parseInt((await env.TOILET_KV.get(ipK)) || '0', 10);
  if (ipN >= perIp) return { ok: false, scope: 'ip' };
  const gK = `mint:_global:${day}`;
  const gN = parseInt((await env.TOILET_KV.get(gK)) || '0', 10);
  if (gN >= globalCap) return { ok: false, scope: 'global' };
  await env.TOILET_KV.put(ipK, String(ipN + 1), { expirationTtl: 172800 });
  await env.TOILET_KV.put(gK, String(gN + 1), { expirationTtl: 172800 });
  return { ok: true };
}

// Per-IP rate limit for the no-auth public tools, backed by the Cloudflare Workers native
// rate-limiting binding (in-colo, fast, no KV consistency lag). 60 requests/min/IP. Only the
// key-less public-tool call path hits this — keyed traffic is metered by its plan quota, untouched.
// Fail-open if the binding is absent (e.g. an old build) so a config gap can't take the tools down.
async function noauthCallLimit(env, request) {
  if (!env.NOAUTH_LIMITER) return { ok: true };
  const ip = request.headers.get('cf-connecting-ip') || 'noip';
  const { success } = await env.NOAUTH_LIMITER.limit({ key: `mcp-noauth:${ip}` });
  return { ok: success };
}

// Per-API-key BURST limit (requests/second) by plan, for keyed MCP + REST traffic. Separate from the
// monthly quota: "unlimited" (ramen_pro) still gets a QPS ceiling so a crawler can't scrape at line
// speed — unlimited VOLUME, not unlimited SPEED. admin (internal master key) and any unmapped plan
// are exempt (fail-open). Backed by 10s-window native limiters (see wrangler.jsonc).
const KEYED_RL = {
  free:       { binding: 'KEY_RL_1RPS',  rps: 1 },
  pro:        { binding: 'KEY_RL_5RPS',  rps: 5 },
  all_access: { binding: 'KEY_RL_10RPS', rps: 10 },
  business:   { binding: 'KEY_RL_10RPS', rps: 10 },
  enterprise: { binding: 'KEY_RL_15RPS', rps: 15 },
  ramen_pro:  { binding: 'KEY_RL_15RPS', rps: 15 },
  // admin: exempt (internal master key)
};
async function keyedBurstLimit(env, auth) {
  const cfg = KEYED_RL[auth.plan];
  if (!cfg) return { ok: true };            // admin / unknown plan → no burst cap
  const binding = env[cfg.binding];
  if (!binding) return { ok: true };        // binding missing → fail-open, never take paid traffic down
  const { success } = await binding.limit({ key: `k:${auth.token}` });
  return { ok: success, rps: cfg.rps };
}

// ---- OAuth 2.1 (MCP remote auth for claude.ai web / Desktop connectors) ------
// Same-origin authorization server + resource server. Access tokens ARE free keys
// (stored as key:<token>), so resolveAuth + metering are reused unchanged. PKCE S256
// mandatory; RFC 7591 dynamic client registration; loopback + claude.ai hosted redirects.
const OAUTH_ISSUER = 'https://api.gachi-tokusuru.com';
const OAUTH_RESOURCE = 'https://api.gachi-tokusuru.com/mcp';
const OAUTH_SCOPE = 'mcp';
function b64url(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function sha256b64url(str) {
  return b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str)));
}
function isLoopbackHost(h) { return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '[::1]'; }
// Exact match, or loopback with port-agnostic path match (RFC 8252 §7.3).
function oauthRedirectAllowed(uri, registered) {
  if (!uri) return false;
  if (registered.includes(uri)) return true;
  try {
    const u = new URL(uri);
    if (!isLoopbackHost(u.hostname)) return false;
    return registered.some((r) => { try { const ru = new URL(r); return isLoopbackHost(ru.hostname) && ru.pathname === u.pathname; } catch { return false; } });
  } catch { return false; }
}
function protectedResourceMetadata(isRamen) {
  // Advertise a host-specific resource so the client's RFC 8707 resource indicator lets us scope the
  // issued key to the right product (ramen keys must not be minted for api.-origin OAuth and vice versa).
  if (isRamen) {
    return { resource: `https://${RAMEN_HOST}/mcp`, authorization_servers: [OAUTH_ISSUER], scopes_supported: [OAUTH_SCOPE], bearer_methods_supported: ['header'], resource_name: 'Japan Ramen Active Master', resource_documentation: `https://${RAMEN_HOST}` };
  }
  return { resource: OAUTH_RESOURCE, authorization_servers: [OAUTH_ISSUER], scopes_supported: [OAUTH_SCOPE], bearer_methods_supported: ['header'], resource_name: 'Gachi Data API', resource_documentation: `${OAUTH_ISSUER}/docs` };
}
function authServerMetadata() {
  return { issuer: OAUTH_ISSUER, authorization_endpoint: `${OAUTH_ISSUER}/authorize`, token_endpoint: `${OAUTH_ISSUER}/token`, registration_endpoint: `${OAUTH_ISSUER}/register`, response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'], scopes_supported: [OAUTH_SCOPE] };
}
function oauthTokenErr(error, desc) {
  return Response.json({ error, error_description: desc }, { status: 400, headers: { ...CORS, 'cache-control': 'no-store' } });
}
function oauthErrPage(error, desc) {
  return new Response(`<!doctype html><meta charset="utf-8"><title>Authorization error</title><div style="font:16px/1.6 -apple-system,BlinkMacSystemFont,sans-serif;max-width:460px;margin:60px auto;padding:0 20px;color:#1a1a1a"><h1 style="font-size:20px">Authorization error</h1><p><b>${error}</b></p><p>${desc}</p></div>`, { status: 400, headers: { 'content-type': 'text/html; charset=utf-8' } });
}
function oauthConsentPage(reqUrl) {
  const approve = new URL(reqUrl); approve.searchParams.set('approve', '1');
  const href = approve.toString().replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  // Brand by the RFC 8707 resource indicator: a client connecting to ramen.*/mcp gets the ramen
  // product (and a ramen-scoped key at /token), so the consent must say so — not "Gachi Data API".
  const isRamen = (reqUrl.searchParams.get('resource') || '').includes(RAMEN_HOST);
  const title = isRamen ? 'Japan Ramen Active Master' : 'Gachi Data API';
  const blurb = isRamen
    ? 'query <b>Japan Ramen Active Master</b> — 62,000+ active Japanese ramen stores nationwide, <b>free</b> (all 47 prefectures)'
    : 'query <b>Gachi Data API</b> — Japan station, accessibility &amp; hazard data';
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Authorize — ${title}</title></head><body><div style="font:16px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:460px;margin:56px auto;padding:0 20px;color:#1a1a1a">
<h1 style="font-size:22px;margin:0 0 8px">Connect to ${title}</h1>
<p>You're authorizing an MCP client to ${blurb}${isRamen ? '' : ' — on the <b>free tier</b>'}.</p>
<p style="color:#666;font-size:14px">No account needed. ${isRamen ? `A free key is created for this connection — all 47 prefectures, 1,000 requests/day; upgrade to Pro anytime for unlimited volume, REST and a commercial licence.` : 'A free-tier key is created for this connection; disconnect anytime to stop using it.'}</p>
<p style="margin-top:22px"><a href="${href}" style="display:inline-block;background:#0b6;color:#fff;text-decoration:none;padding:11px 22px;border-radius:6px;font-weight:600">Authorize</a></p>
<p style="color:#999;font-size:12px;margin-top:28px">Powered by api.gachi-tokusuru.com · <a href="/docs" style="color:#0b6">docs</a></p>
</div></body></html>`, { headers: { 'content-type': 'text/html; charset=utf-8' } });
}

async function issuePaidKey(env, plan, { email, customer, session, test }) {
  const meta = PLAN_META[plan];
  const token = randToken(meta.prefix);
  const record = {
    plan, email, status: 'active',
    product: meta.product || 'gachi', // scope paid key to its product (ramen_pro → 'ramen', else 'gachi')
    stripe_customer_id: customer || null,
    stripe_session_id: session || null,
    created: new Date().toISOString(),
    ...(test ? { test: true } : {}), // sandbox-issued: identifiable + excluded from paid stats
  };
  await env.TOILET_KV.put(`key:${token}`, JSON.stringify(record));
  if (!test) { // don't inflate production paid-key stats with sandbox test issuances
    const c = parseInt((await env.TOILET_KV.get(meta.stat)) || '0', 10);
    await env.TOILET_KV.put(meta.stat, String(c + 1));
  }
  return token;
}

// Verify a paid Stripe Checkout Session and issue the plan's key (idempotent per session).
// Plan is resolved from the paid amount (see AMOUNT_TO_PLAN). Works for Pro / All Access / Business.
// Email the freshly-issued key to the customer as a backup copy. Best-effort: never throws, and is
// a no-op unless RESEND_API_KEY is configured (so activation works with or without email). The
// /activate page stays the primary delivery. Idempotency is handled by the caller: this only runs
// on first issuance (a revisit hits the session cache and returns before reaching here).
// gachi-tokusuru.com is a verified Resend sending domain (DKIM/SPF/bounce-MX, ap-northeast-1;
// verified 2026-07-06). Send "from" it for brand consistency. Override with the MAIL_FROM secret
// if the verified domain changes.
const MAIL_FROM_DEFAULT = 'Gachi Data API <noreply@gachi-tokusuru.com>';
const NOTIFY_EMAIL_DEFAULT = 'contact@gachi-tokusuru.com';

async function sendKeyEmail(env, { email, plan, key }) {
  if (!env.RESEND_API_KEY || !email) return { sent: false, reason: 'disabled_or_no_email' };
  const from = env.MAIL_FROM || MAIL_FROM_DEFAULT;
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

// Notify the operator when a new lead arrives via the /interest form. Best-effort: never throws,
// no-op unless RESEND_API_KEY is set. To-address defaults to contact@gachi-tokusuru.com (inbound
// Email Routing → your inbox); override with the NOTIFY_EMAIL secret.
async function sendInterestNotification(env, { email, useCase, id }) {
  if (!env.RESEND_API_KEY) return { sent: false, reason: 'disabled' };
  const from = env.MAIL_FROM || MAIL_FROM_DEFAULT;
  const to = env.NOTIFY_EMAIL || NOTIFY_EMAIL_DEFAULT;
  const text =
    `New lead from the Gachi Data API contact form.\n\n` +
    `Email:    ${email}\n` +
    `Use case: ${useCase}\n` +
    `KV key:   interest:${id}\n` +
    `Time:     ${new Date().toISOString()}\n\n` +
    `Reply directly to ${email}.`;
  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from, to: [to], reply_to: email, subject: `New lead — ${email}`, text }),
    });
    if (!resp.ok) console.log(`sendInterestNotification: resend HTTP ${resp.status}`);
    return { sent: resp.ok, status: resp.status };
  } catch (e) {
    console.log(`sendInterestNotification error: ${e.message}`);
    return { sent: false, reason: e.message };
  }
}

async function activate(env, sessionId) {
  const cached = await env.TOILET_KV.get(`session:${sessionId}`, 'json');
  if (cached) return { ok: true, ...cached }; // already activated → same key (no re-issue, no re-email)

  // Test-mode sessions (cs_test_*) must be verified with the test secret key, live with the live key.
  const isTest = sessionId.startsWith('cs_test_');
  const stripeKey = isTest ? env.STRIPE_SECRET_KEY_TEST : env.STRIPE_SECRET_KEY;
  if (!stripeKey) return { ok: false, reason: isTest ? 'test_key_missing' : 'verify_failed' };

  const resp = await fetch(
    `https://api.stripe.com/v1/checkout/sessions/${sessionId}?expand[]=line_items`,
    { headers: { Authorization: `Bearer ${stripeKey}` } },
  );
  if (!resp.ok) return { ok: false, reason: 'verify_failed' };
  const s = await resp.json();
  if (s.payment_status !== 'paid') return { ok: false, reason: 'not_paid' };

  // Resolve plan from the line-item amount (fall back to the session amount_total).
  // In test mode, default to ramen_pro if the amount isn't mapped, so any sandbox price works.
  const li = s.line_items?.data?.[0];
  const amount = li?.price?.unit_amount ?? li?.amount_total ?? s.amount_total;
  const plan = AMOUNT_TO_PLAN[amount] || (isTest ? 'ramen_pro' : null);
  if (!plan) {
    console.log(`activate: unmapped amount ${amount} (session ${sessionId}) — add it to AMOUNT_TO_PLAN`);
    return { ok: false, reason: 'unknown_plan' };
  }

  const email = s.customer_details?.email || s.customer_email || '';
  const key = await issuePaidKey(env, plan, { email, customer: s.customer, session: sessionId, test: isTest });
  // Backup delivery by email — only here on first issuance, so it never re-sends on a revisit.
  const mail = await sendKeyEmail(env, { email, plan, key });
  const rec = { key, plan, email, emailed: !!mail.sent, ...(isTest ? { test: true } : {}) };
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
  return id;
}

// ---- MCP JSON-RPC --------------------------------------------------------
async function handleRpc(body, env, opts = {}) {
  const { id, method, params } = body;
  // On ramen.gachi-tokusuru.com the MCP surface is scoped to the ramen product only.
  // On api.* (the full data API) the ramen tools are EXCLUDED — the standalone ramen product
  // must not be reachable through a general Gachi Data API key (close the back door).
  const ramenOnly = opts.ramenOnly === true;
  // ramen.* shows ONLY the ramen tools; api.* shows everything EXCEPT them. tools/list is open on
  // both (no auth needed for discovery), and on api.* every listed tool is also callable no-auth.
  // ping is a health check shown on BOTH surfaces; every other ramen tool stays scoped to ramen.*,
  // and api.* shows everything except the ramen tools.
  const visibleTools = ramenOnly
    ? TOOLS.filter((t) => RAMEN_TOOL_NAMES.has(t.name) || t.name === 'ping')
    : TOOLS.filter((t) => !RAMEN_TOOL_NAMES.has(t.name));

  if (method === 'initialize') {
    return rpcResult(id, {
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: ramenOnly
        ? {
          name: 'japan-ramen-active-master',
          title: 'Japan Ramen Active Master',
          version: '0.3.0',
          description: '62,268 active ramen shops across all 47 prefectures of Japan. Names verified by dual-AI audit (26,975 romanization fixes); liveness re-verified monthly with web-checked closure evidence, and every response is stamped with its data_as_of date. No auth, no signup. Yes, we have both ramen shops on Iriomote Island.',
          websiteUrl: 'https://ramen.gachi-tokusuru.com',
          homepage: 'https://ramen.gachi-tokusuru.com',
          icon: 'https://ramen.gachi-tokusuru.com/icon.svg',
        }
        : {
          name: 'gachi-data-api',
          title: 'Gachi Data API — Japan life & safety data',
          version: '0.3.0',
          description: '9 tools for Japan life & safety data: semantic station discovery (9,035 stations — ramen density, accessibility, official hazard), station restrooms & accessibility (526 Tokyo stations), live train status, JMA flood/landslide alerts, hazard risk and official statistics for any station or municipality. Government open data, no auth.',
          websiteUrl: 'https://toilet.gachi-tokusuru.com/en',
          homepage: 'https://toilet.gachi-tokusuru.com/en',
          icon: 'https://api.gachi-tokusuru.com/icon.svg',
        },
    });
  }
  if (method === 'notifications/initialized') return null;
  if (method === 'tools/list') {
    return rpcResult(id, {
      tools: visibleTools.map(({ prefix, argName, attribution, ...t }) =>
        // ping's default metadata is the api variant; swap to the ramen variant on ramen.*.
        (t.name === 'ping' && ramenOnly)
          ? { ...t, description: PING_DESC_RAMEN, outputSchema: PING_OUTPUT_SCHEMA_RAMEN }
          : t),
    });
  }
  if (method === 'tools/call') {
    const tool = visibleTools.find((t) => t.name === params?.name);
    if (!tool) return rpcError(id, -32602, `unknown tool: ${params?.name}`);
    // Connection test / health check — host-specific identity + live freshness (no auth, no args).
    if (tool.name === 'ping') {
      const payload = ramenOnly ? await pingRamenPayload(env) : await pingApiPayload(env, visibleTools.length);
      return mcpResult(id, payload);
    }
    // Hazard tool: name -> coords -> live reinfolib relay (not a KV toilet lookup).
    if (tool.name === 'get_station_hazard') {
      const payload = await hazardPayload(env, params?.arguments?.station_name);
      return mcpResult(id, payload);
    }
    // Semantic station discovery (Vectorize gachi-station-vibe + hybrid metadata filters).
    if (tool.name === 'station_search') {
      const payload = await stationSearchPayload(env, params?.arguments || {});
      return mcpResult(id, payload);
    }
    // Realtime relays (KV snapshots written by the host pipelines).
    if (tool.name === 'get_active_alerts') {
      const payload = await activeAlertsPayload(env, (params?.arguments?.area || '').trim() || null);
      return mcpResult(id, payload);
    }
    if (tool.name === 'get_station_alerts') {
      const payload = await stationAlertsPayload(env, params?.arguments?.station_name);
      return mcpResult(id, payload);
    }
    if (tool.name === 'get_train_status') {
      const payload = await trainStatusPayload(env, params?.arguments?.query);
      return mcpResult(id, payload);
    }
    // Ramen DB (KV dataset with monthly freshness sync).
    if (tool.name === 'search_ramen') {
      const a = params?.arguments || {};
      const payload = await ramenSearchPayload(env, {
        pref: (a.pref || '').trim() || null, city: (a.city || '').trim() || null,
        keito: (a.keito || '').trim() || null, status: (a.status || '').trim() || null,
        q: (a.q || '').trim() || null,
        chain: (a.chain || '').trim() || null,
        chainSub: (a.chain_sub || '').trim() || null,
        spiceLevel: (a.spice_level || '').trim().toLowerCase() || null,
        match: (a.match || '').trim() || null,
        lat: typeof a.lat === 'number' ? a.lat : parseFloat(a.lat),
        lng: typeof a.lng === 'number' ? a.lng : parseFloat(a.lng),
        radius: a.radius_m, limit: a.limit,
        // No-auth: all 47 prefectures, but limit capped 20 and nearby radius capped 2,000 m (clamped).
        ...(opts.ramenNoauth ? { maxLimit: 20, maxRadius: 2000 } : {}),
      });
      withRamenDataAsOf(payload, await ramenDataAsOf(env));
      return mcpResult(id, payload);
    }
    if (tool.name === 'get_ramen_shop') {
      const a = params?.arguments || {};
      let payload;
      if ((a.id || '').trim()) {
        payload = (await ramenShopPayload(env, a.id.trim()))
          || { error: `Unknown shop id "${a.id}".`, attribution: RAMEN_ATTR };
      } else if ((a.name || '').trim()) {
        payload = await ramenShopByName(env, a.name.trim(), (a.pref || '').trim() || null, (a.city || '').trim() || null);
      } else {
        payload = { error: 'Provide id (rk_000851) or name + pref.', attribution: RAMEN_ATTR };
      }
      withRamenDataAsOf(payload, await ramenDataAsOf(env));
      return mcpResult(id, payload);
    }
    if (tool.name === 'get_ramen_changes') {
      // No-auth: cap to the last 7 days and ≤50 events so the full changes feed (a Pro deliverable) can't be bulk-pulled.
      const changeOpts = opts.ramenNoauth
        ? { maxEvents: 50, minDate: new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10) }
        : {};
      const payload = await ramenChangesPayload(env, (params?.arguments?.since || '').trim() || null, changeOpts);
      withRamenDataAsOf(payload, await ramenDataAsOf(env));
      return mcpResult(id, payload);
    }
    if (tool.name === 'vibe_search') {
      const a = params?.arguments || {};
      const payload = await ramenVibeSearchPayload(env, {
        q: (a.q || '').trim() || null,
        pref: (a.pref || '').trim() || null,
        status: (a.status || '').trim() || null,
        limit: a.limit,
        richness: (a.richness || '').trim() || null,
        hours: (a.hours || '').trim() || null,
        spice: ((a.spice_level || a.spice) || '').trim() || null,  // spice_level=正式名 / spice=旧名(後方互換)
      });
      withRamenDataAsOf(payload, await ramenDataAsOf(env));
      return mcpResult(id, payload);
    }
    // Municipality Context API (Akiya Stage 2): official municipality data in one call.
    if (tool.name === 'get_municipality_context' || tool.name === 'get_station_context') {
      const a = params?.arguments || {};
      const fields = parseCtxFields(a.fields);
      const payload = tool.name === 'get_station_context'
        ? await stationContextPayload(env, (a.station_id || a.station_name || '').trim(), fields)
        : await municipalityContextByNameOrCode(env, (a.name_or_code || '').trim(), fields);
      return mcpResult(id, payload);
    }
    const query = params?.arguments?.[tool.argName];
    const found = query ? await lookup(env, tool.prefix, query) : null;
    let payload;
    if (!found) {
      payload = { error: `No data found for "${query}".`, attribution: tool.attribution };
    } else if (tool.name === 'get_toilet_by_station') {
      const attribution = found.layer === 'in_station_gate' ? EKINAI_ATTR : tool.attribution;
      payload = { ...(await toEnglishStation(env, found)), attribution };
    } else {
      payload = { ...toEnglishCity(found), attribution: tool.attribution };
    }
    return mcpResult(id, payload);
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
  kaggle: 'https://www.kaggle.com/datasets/gachidata/japan-stations-ridership-and-akiya-2003-2025',
};

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'Authorization, Content-Type',
  'access-control-max-age': '86400',
};

// CORS for /mcp specifically. Streamable HTTP here is POST-only (we offer no GET/SSE stream), and a
// browser-side client (Glama's Inspector, MCP Inspector) has to be able to read Mcp-Session-Id back
// off the response — cross-origin that requires an explicit expose-headers.
const MCP_CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type, mcp-session-id, mcp-protocol-version',
  'access-control-expose-headers': 'Mcp-Session-Id',
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

// In-station toilet層(改札内/外・都外主要駅)の出典。東京の多目的(福祉局CC BY)とは別ソースなので
// get_toilet_by_station が layer==='in_station_gate' のレコードを返すときはこちらを使う。
const EKINAI_ATTR = {
  source: 'らくらくおでかけネット (Rakuraku Odekake Net) — Ecomo Mobility Foundation, with each railway operator',
  coverage: 'In-station accessible toilets grouped by ticket gate (inside/outside), for major stations outside Tokyo',
  note: 'Facility presence relayed as published; floor and exact location are not included — confirm on-site signage.',
  provider: 'https://toilet.gachi-tokusuru.com',
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

// ---- Ramen DB (nationwide) ----
// KV layout (seeded by build_kv_seed_ramen.py, synced monthly after the ramen refresh):
//   ramen:meta / ramen:pref:<都道府県> / ramen:ididx / ramen:geo:<gh4> / ramen:changes
// Provenance (osm_id is 0 across the DB — OSM does NOT contribute; do NOT claim ODbL, that would be
// false attribution): three layers — (1) facts observed from public web ramen listings, (2) records
// cross-checked against Japanese municipality open data (CC BY), (3) reverse-geocoded municipality
// via 国土地理院 (GSI) + our own enrichment. Mirrors ramen:meta.attribution.
const RAMEN_ATTR = {
  attribution: '© 各自治体オープンデータ (CC BY) · reverse geocoding © 国土地理院 (GSI) · enrichment © gachi-tokusuru.com',
  license:
    'Three layers: (1) store facts observed from public web ramen listings — factual data, no third-party copyright asserted; ' +
    '(2) licensing-verified records from Japanese municipality open data — © 各自治体オープンデータ, CC BY (attribution required); ' +
    '(3) derived/enrichment values (keito classification, romanization, station distance, municipality via reverse geocoding © 国土地理院 GSI, rk_ ids) are original © gachi-tokusuru.com.',
  source_detail: 'contact@gachi-tokusuru.com',
};
const RAMEN_DEFS = {
  status:
    'active | closed_candidate (missing from the monthly web source 2 consecutive checks, OR marked ' +
    'disused/closed) | closed_confirmed (closure web-verified, with evidence_url)',
  reopened:
    'a closed_candidate found open on web verification (high confidence, no successor record within 200 m) is restored to active',
  merged:
    'this id was consolidated into merged_into (duplicate-record dedup 2026-07-31). Old ids stay resolvable: get_ramen_shop / GET /v1/shops/{old_id} return the canonical record with merged_into set',
  spice_level:
    'spicy = spiciness is the shop\'s signature (chain official signage or shop-name signal, dual-LLM verified; no UGC) | null = unknown (never guessed). Independent of keito: tantanmen alone never implies spicy',
  midnight_hours: 'true = open at/after 23:00; null = unknown (never coerced to false)',
  keito: '19-value ramen-style vocabulary assigned by our classifier (incl. regional schools champon/toripaitan/asahikawa etc.); [] = unclassified (we do not guess)',
  data_as_of: 'Dataset build date (response-level). Active shops are present in the source as of this date — a DATASET-level freshness signal, not an independent per-shop re-verification.',
  last_seen: 'Present only on closure records (closed_candidate/closed_confirmed): the last date the shop was seen in the source before it went missing. Omitted for active shops (there it would just equal data_as_of).',
};

// q matching. partial(default): substring on name(JP) OR name_en(romaji), case/space-insensitive.
// exact: whole-word match on the romaji name_en, so q=ojiya finds 王子家(Ojiya) but NOT 糀谷(Kojiya)/
// 木ノ実屋(Kinojiya). The Japanese name stays substring in both modes (kanji is already precise).
function ramenQMatch(s, q, exact) {
  if (!q) return true;
  if ((s.name || '').includes(q)) return true;
  const en = (s.name_en || '').toLowerCase();
  const qc = q.toLowerCase().replace(/\s+/g, '');
  if (!qc) return false;
  if (exact) return en.split(/\s+/).some((t) => t.replace(/[^a-z0-9]/g, '') === qc);
  return en.replace(/\s+/g, '').includes(qc);
}

// Public shape for full shop records. Internal ops/lifecycle fields (st_ id, *_source metadata,
// osm_id, and the freshness lifecycle internals) stay in KV for our pipeline but are NOT exposed
// to customers. Kept: the facts a consumer actually uses + status/last_seen + sources (CC BY provenance).
function ramenPublicShape(s) {
  if (!s) return s;
  const st = s.station, p = s.payment, fr = s.freshness || {};
  // Product thesis: an authoritative registry of ACTIVE Japanese ramen shops — identity + location
  // done rigorously (name/romaji/address/coords are 100%). Granular per-shop details (hours, url,
  // phone…) are "look it up on Google", not our job. Empty fields (name_kana/url/url_type/midnight_hours
  // = 0% coverage) are omitted rather than shipped as noise. Re-add if a future source populates them.
  return {
    id: s.id, name: s.name, name_en: s.name_en,
    pref: s.pref, pref_en: s.pref_en, city: s.city, city_en: s.city_en, address: s.address,
    lat: s.lat, lng: s.lng,
    keito: s.keito || [], chain: s.chain || null, chain_sub: s.chain_sub || null, genre: s.genre,
    // Chain-level attributes from the chain's official site (2026-07 enrichment).
    // Sparse by design (chains only) — omitted when null rather than shipped as noise.
    ...(s.richness ? { richness: s.richness } : {}),
    ...(s.hours_class && s.hours_class.length ? { hours_class: s.hours_class } : {}),
    ...(s.midnight_hours != null ? { midnight_hours: s.midnight_hours } : {}),
    station: st ? { name: st.name, name_en: st.name_en, distance_meters: st.distance_meters } : null,
    payment: p ? { cash_only: p.cash_only, card_accepted: p.card_accepted, qr_accepted: p.qr_accepted, state: p.state } : null,
    sources: s.sources,
    // last_seen for an ACTIVE shop is just the dataset build date (uniform across all active shops),
    // NOT a per-shop re-verification — so we don't expose it there (would overstate freshness). On
    // closure records it IS meaningful (the frozen last date the shop was seen), so keep it there.
    // Dataset-level freshness is the response-level data_as_of instead.
    freshness: (fr.status && fr.status !== 'active')
      ? { status: fr.status, last_seen: fr.last_seen }
      : { status: fr.status || 'active' },
  };
}

function ramenFilterFull(arr, { city, keito, status, q, exact, chain, chainSub }) {
  let out = arr;
  // city matches Japanese city (substring) OR romaji city_en (case/space-insensitive): "kawaguchi" → 川口市.
  if (city) { const cc = city.toLowerCase().replace(/\s+/g, ''); out = out.filter((s) => (s.city || '').includes(city) || (s.city_en || '').toLowerCase().replace(/\s+/g, '').includes(cc)); }
  if (keito) out = out.filter((s) => ramenKeitoMatch(s.keito, keito));
  if (chain) out = out.filter((s) => ramenChainMatch(s.chain, chain));
  if (chainSub) out = out.filter((s) => (s.chain_sub || '').toLowerCase() === chainSub.toLowerCase());
  if (status) out = out.filter((s) => ((s.freshness || {}).status || 'active') === status);
  // q matches the Japanese name (substring) OR the romaji/English name (case-insensitive),
  // so "butasakashita" / "ichiran" find shops just like 豚坂下 / 一蘭 (English-first product).
  if (q) out = out.filter((s) => ramenQMatch(s, q, exact));
  return out;
}

// chain filter: exact-ish match on the curated chain label (chain_master.csv). NFKC + case-insensitive
// substring, so chain=ラーメンショップ matches, and chain=yamaokaya-style romaji is NOT attempted (labels
// are Japanese; romaji users can q= the shop name instead).
function ramenChainMatch(shopChain, want) {
  if (!shopChain) return false;
  const a = String(shopChain).normalize('NFKC').toLowerCase();
  const b = String(want).normalize('NFKC').toLowerCase();
  return a.includes(b);
}

// pref入力の寛容化: 「千葉」→「千葉県」「東京」→「東京都」等。フル形はそのまま通す。
function ramenNormalizePref(raw) {
  const p = (raw || '').trim();
  if (!p) return null;
  // Romaji input (e.g. "saitama", "Tokyo", "osaka-ken") -> Japanese prefecture.
  if (/^[A-Za-z]/.test(p)) {
    const key = p.toLowerCase().replace(/[\s\-]|(ken|fu|prefecture)$/g, '');
    return PREF_EN_REV[key] || PREF_EN_REV[p.toLowerCase().replace(/[\s\-]/g, '')] || null;
  }
  if (/[都道府県]$/.test(p)) return p;
  if (p === '東京') return '東京都';
  if (p === '大阪') return '大阪府';
  if (p === '京都') return '京都府';
  if (p === '北海道') return '北海道';
  return p + '県';
}

// pref未指定でcityだけ来た時の解決: cityidx逆引き。1県に定まれば採用、複数なら候補を返す。
async function ramenResolvePrefFromCity(env, city) {
  const idx = await env.TOILET_KV.get('ramen:cityidx', 'json');
  if (!idx) return { error: 'City index is not initialized yet.' };
  // 完全一致優先 → 「松戸」のような市抜き表記は包含で救済
  let key = idx[city] ? city : null;
  if (!key) {
    const hits = Object.keys(idx).filter((c) => c.includes(city));
    if (hits.length > 1) return { error: `"${city}" matches multiple municipalities: ${hits.slice(0, 8).join(', ')}. Add the prefecture.` };
    if (!hits.length) return { error: `No shops found in "${city}". Check the municipality name (e.g. 松戸市, 世田谷区).` };
    key = hits[0];
  }
  const prefs = idx[key];
  if (prefs.length > 1) return { error: `"${key}" exists in multiple prefectures (${prefs.join(', ')}). Specify pref.` };
  return { pref: prefs[0], city: key };
}

async function ramenSearchPayload(env, { pref, city, keito, status, q, lat, lng, radius, limit, match, chain, chainSub, spiceLevel, maxLimit = 50, maxRadius = 5000 }) {
  // spice_level(属性軸)フィルタ。spicy=看板が辛さ(裁定済357店) / unknown=データなし。keito(系統)とは独立。
  if (spiceLevel && !['spicy', 'unknown'].includes(spiceLevel)) {
    return { error: 'spice_level must be "spicy" or "unknown".', attribution: RAMEN_ATTR };
  }
  const spiceMatch = (s) => (spiceLevel === 'spicy' ? s.spice_level === 'spicy' : !s.spice_level);
  // No-auth callers pass a lower maxLimit/maxRadius; over-limit requests are CLAMPED, not rejected.
  const cap = Math.min(Math.max(Number.parseInt(limit, 10) || Math.min(20, maxLimit), 1), maxLimit);
  const exact = (match || '').toLowerCase() === 'exact';  // opt-in whole-word q match
  // Nearby mode: geohash-4 buckets (lite records), 9-cell read covers radius ≤ 5 km.
  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return { error: 'Invalid lat/lng.', attribution: RAMEN_ATTR };
    let rad = Number.parseInt(radius, 10);
    if (!Number.isFinite(rad) || rad <= 0) rad = Math.min(1500, maxRadius);
    rad = Math.min(rad, maxRadius);
    const cells = geohashNeighbors(geohashEncode(lat, lng, 4));
    const gets = await Promise.all(cells.map((c) => env.TOILET_KV.get(`ramen:geo:${c}`, 'json')));
    let out = [];
    for (const cell of gets) {
      if (!cell) continue;
      for (const s of cell) {
        const d = haversine(lat, lng, s.lat, s.lng);
        if (d <= rad) out.push({ ...s, distance_m: Math.round(d) });
      }
    }
    if (keito) out = out.filter((s) => ramenKeitoMatch(s.keito, keito));
    if (chain) out = out.filter((s) => ramenChainMatch(s.chain, chain));
    if (chainSub) out = out.filter((s) => (s.chain_sub || '').toLowerCase() === chainSub.toLowerCase());
    if (status) out = out.filter((s) => (s.status || 'active') === status);
    if (q) out = out.filter((s) => ramenQMatch(s, q, exact));
    if (spiceLevel) out = out.filter(spiceMatch);
    out.sort((a, b) => a.distance_m - b.distance_m);
    return {
      query: { lat, lng, radius_m: rad, keito: keito || null, chain: chain || null, chain_sub: chainSub || null, status: status || null, q: q || null, ...(spiceLevel ? { spice_level: spiceLevel } : {}) },
      count: Math.min(out.length, cap), total_matched: out.length, shops: out.slice(0, cap).map((s) => ({ ...s, keito: s.keito || [] })),
      note: 'Nearby results are the lite shape (id/name/pref/city/coords/keito/status). Use get_ramen_shop / GET /v1/shops/{id} for the full record.',
      attribution: RAMEN_ATTR,
    };
  }
  // Nationwide search: q / keito / status with NO location → scan the lite index, so
  // "is there a ramen shop called X?" works without knowing the prefecture (Japanese or romaji).
  if (!pref && !city && (q || keito || status || chain || chainSub)) {
    const all = await env.TOILET_KV.get('ramen:all_lite', 'json');
    if (all) {
      let out = all;
      if (keito) out = out.filter((s) => ramenKeitoMatch(s.keito, keito));
      if (chain) out = out.filter((s) => ramenChainMatch(s.chain, chain));
      if (chainSub) out = out.filter((s) => (s.chain_sub || '').toLowerCase() === chainSub.toLowerCase());
      if (status) out = out.filter((s) => (s.status || 'active') === status);
      if (q) out = out.filter((s) => ramenQMatch(s, q, exact));
      if (spiceLevel) out = out.filter(spiceMatch);
      return {
        query: { q: q || null, keito: keito || null, chain: chain || null, chain_sub: chainSub || null, status: status || null, ...(spiceLevel ? { spice_level: spiceLevel } : {}), scope: 'nationwide' },
        count: Math.min(out.length, cap), total_matched: out.length, shops: out.slice(0, cap).map((s) => ({ ...s, keito: s.keito || [] })),
        note: 'Nationwide search (lite shape: id/name/name_en/pref/city/status). Use get_ramen_shop / GET /v1/shops/{id} for the full record.',
        attribution: RAMEN_ATTR,
      };
    }
  }
  pref = ramenNormalizePref(pref);
  if (!pref && city) {
    const r = await ramenResolvePrefFromCity(env, city);
    if (r.error) return { error: r.error, attribution: RAMEN_ATTR };
    pref = r.pref;
    city = r.city;
  }
  if (!pref) return { error: 'Provide "pref" (e.g. 東京都/千葉県, or romaji: saitama/tokyo), a "city" (e.g. 松戸市 / kawaguchi), a name via "q" (nationwide), or lat+lng for nearby search.', attribution: RAMEN_ATTR };
  const arr = await env.TOILET_KV.get(`ramen:pref:${pref}`, 'json');
  if (!arr) {
    const meta = await env.TOILET_KV.get('ramen:meta', 'json');
    return { error: `No data for pref "${pref}". Use the full form (東京都, 大阪府, 北海道, 千葉県…).`, prefs: meta?.prefs || [], attribution: RAMEN_ATTR };
  }
  let matched = ramenFilterFull(arr, { city, keito, status, q, exact, chain, chainSub });
  if (spiceLevel) matched = matched.filter(spiceMatch);
  return {
    query: { pref, city: city || null, keito: keito || null, chain: chain || null, chain_sub: chainSub || null, status: status || null, q: q || null, ...(spiceLevel ? { spice_level: spiceLevel } : {}) },
    count: Math.min(matched.length, cap), total_matched: matched.length, shops: matched.slice(0, cap).map(ramenPublicShape),
    definitions: RAMEN_DEFS, attribution: RAMEN_ATTR,
  };
}

// Semantic search: query -> bge-m3 embedding (Workers AI binding) -> Vectorize nearest neighbours.
// The lite shape (name/name_en/pref/city/keito/status) rides in vector metadata, so a query needs
// NO KV reads beyond ramen:meta (data_as_of) — the 10MB all_lite parse never touches this path.
// Vector corpus: one synthetic sentence per shop (name JA+romaji, keito taxonomy phrase JA+EN for
// classified shops only — never guessed, nearest station JA+romaji, municipality/prefecture JA+EN),
// built by vibe/build_all_sentences.py and kept fresh by vibe/diff_upsert.py after the monthly sync.
// Query-intent keywords -> attribute filters (attributes come from official-site
// enrichment 2026-07; metadata-indexed on Vectorize). Explicit params win over intent.
const VIBE_RICH_INTENT = [
  [/あっさり|淡麗|さっぱり|light broth|assari/i, 'assari'],
  [/こってり|濃厚|ドロ|背脂|rich broth|kotteri|creamy/i, 'kotteri'],
];
const VIBE_HOURS_INTENT = [
  [/深夜|夜中|夜遅|〆|締めの|シメの|late night|midnight/i, 'late_night'],
  [/朝ラー|朝から|早朝|モーニング|morning|breakfast/i, 'morning'],
  [/24時間|24h|24 hours/i, '24h'],
];
// spice intent (2026-07-31 spice_level軸新設): 辛さ語彙 -> spice=spicy filter。
// 否定形(辛くない/控えめ/苦手)では発火しない。「担々麺/tantanmen」は意図的に不発火
// (汁なし白胡麻系など辛くない店があるため。spice_levelはkeitoと独立の裁定)。
const VIBE_SPICE_NEG = /辛くない|辛さ控えめ|辛さ抑えめ|辛いの(?:苦手|だめ|ダメ)|not spicy|mild/i;
const VIBE_SPICE_INTENT = /激辛|辛い|辛め|辛口|オロチョン|カラシビ|麻辣|マーラー|spicy|\bhot\b/i;
// Indirect scenario words (season / body condition) -> concrete corpus vocabulary.
// The vector corpus is built from taxonomy phrases (vibe/keito_map.py), so queries like
// 「汗だくの夏に塩分補給」 share zero tokens with any shop sentence. When a scenario fires we
// append the exact taxonomy phrases it implies before embedding, and default richness/hours
// (only if the query didn't state or trigger one already — attr_filter_source stays 'inferred').
const VIBE_SCENE_EXPAND = [
  [/汗だく|塩分補給|夏バテ|猛暑|暑い日/, 'shio 塩 clear salt broth ramen', { rich: 'assari' }],
  [/風邪|胃に優し|優しい味|体に優し|やさしい味/, 'shio 塩 chuka soba 中華そば 淡麗 light clear broth', { rich: 'assari' }],
  [/温まる|あったまる|寒い夜|真冬|冷えた/, 'miso 味噌 ramen Sapporo-style 札幌ラーメン rich miso tantanmen 担々麺 spicy sesame', {}],
  [/二日酔い|飲み過ぎ|酔い覚まし/, 'shio 塩 shoyu 醤油 淡麗 light clear broth', { rich: 'assari' }],
  [/背徳/, 'こってり 濃厚 rich heavy thick broth', { rich: 'kotteri' }],
];
// Query-intent -> prefecture filter (same inferred-filter idea as richness/hours).
// Two tiers, tuned against style-name false positives:
//   - FULL prefecture names (北海道/〜県/東京都/大阪府/京都府) always signal location.
//   - Bare stems (東京, 熊本…) and well-known place names (博多, すすきの…) count ONLY when
//     followed by a location particle (の/で/…) — so「東京豚骨」「熊本ラーメン」「横浜家系」
//     read as style names and do NOT bind location, while「博多の細麺」「仙台でラーメン」do.
//   - Region-style keito words (札幌/喜多方/佐野/白河/尾道/旭川) are deliberately absent:
//     they are taxonomy styles first, so pref inference must never fire on them.
const VIBE_PREF_FULL = ['北海道', '東京都', '大阪府', '京都府',
  '青森県', '岩手県', '宮城県', '秋田県', '山形県', '福島県', '茨城県', '栃木県', '群馬県', '埼玉県',
  '千葉県', '神奈川県', '新潟県', '富山県', '石川県', '福井県', '山梨県', '長野県', '岐阜県', '静岡県',
  '愛知県', '三重県', '滋賀県', '兵庫県', '奈良県', '和歌山県', '鳥取県', '島根県', '岡山県', '広島県',
  '山口県', '徳島県', '香川県', '愛媛県', '高知県', '福岡県', '佐賀県', '長崎県', '熊本県', '大分県',
  '宮崎県', '鹿児島県', '沖縄県'];
const VIBE_PLACE_TO_PREF = [
  ['すすきの', '北海道'], ['函館', '北海道'], ['小樽', '北海道'],
  ['仙台', '宮城県'], ['宇都宮', '栃木県'],
  ['新宿', '東京都'], ['渋谷', '東京都'], ['池袋', '東京都'], ['銀座', '東京都'],
  ['上野', '東京都'], ['浅草', '東京都'], ['秋葉原', '東京都'],
  ['横浜', '神奈川県'], ['川崎', '神奈川県'],
  ['名古屋', '愛知県'], ['金沢', '石川県'], ['神戸', '兵庫県'],
  ['博多', '福岡県'], ['天神', '福岡県'], ['小倉', '福岡県'], ['那覇', '沖縄県'],
];
const VIBE_PLACE_PARTICLE = '(?:の|で|に|なら|周辺|近辺|あたり|辺り|エリア|市内|駅)';
function vibeInferPref(q) {
  for (const full of VIBE_PREF_FULL) if (q.includes(full)) return full;
  for (const [place, pref] of VIBE_PLACE_TO_PREF) {
    if (new RegExp(place + VIBE_PLACE_PARTICLE).test(q)) return pref;
  }
  for (const full of VIBE_PREF_FULL) {
    if (full === '北海道') continue;
    const stem = full.replace(/[都府県]$/, '');
    // 京都 stem must not fire inside 東京都/東京 — negative lookbehind on 東.
    const re = stem === '京都' ? new RegExp('(?<!東)京都' + VIBE_PLACE_PARTICLE) : new RegExp(stem + VIBE_PLACE_PARTICLE);
    if (re.test(q)) return full;
  }
  return null;
}


async function ramenVibeSearchPayload(env, { q, pref, status, limit, richness, hours, spice }) {
  if (!q) return { error: 'Provide q — a natural-language description, e.g. "rich creamy pork bone broth" / "あっさり淡麗な醤油".', attribution: RAMEN_ATTR };
  if (!env.AI || !env.VECTORIZE) return { error: 'Semantic search is not available on this deployment.', attribution: RAMEN_ATTR };
  const cap = Math.min(Math.max(Number.parseInt(limit, 10) || 10, 1), 20);
  const st = (status || 'active').toLowerCase();
  if (!['active', 'closed_confirmed', 'all'].includes(st)) {
    return { error: 'status must be active (default), closed_confirmed or all.', attribution: RAMEN_ATTR };
  }
  const filter = {};
  const explicitPref = Boolean(pref);
  if (pref) {
    const np = ramenNormalizePref(pref);
    if (!np) return { error: `Unknown prefecture "${pref}". Use 東京都/千葉県… or romaji (tokyo/osaka).`, attribution: RAMEN_ATTR };
    filter.pref = np;
  } else {
    const ip = vibeInferPref(q);
    if (ip) filter.pref = ip;
  }
  const inferredPref = !explicitPref && Boolean(filter.pref);
  if (st !== 'all') filter.status = st;
  // attribute filters: explicit params win; otherwise infer intent from the query text.
  const RICH_VALUES = ['assari', 'kotteri', 'futsu', 'menu_varies'];
  const HOURS_VALUES = ['morning', 'late_night', '24h'];
  let rich = (richness || '').toLowerCase() || null;
  let hrs = (hours || '').toLowerCase() || null;
  let spc = (spice || '').toLowerCase() || null;
  if (rich && !RICH_VALUES.includes(rich)) return { error: `richness must be one of ${RICH_VALUES.join('/')}.`, attribution: RAMEN_ATTR };
  if (hrs && !HOURS_VALUES.includes(hrs)) return { error: `hours must be one of ${HOURS_VALUES.join('/')}.`, attribution: RAMEN_ATTR };
  if (spc && spc !== 'spicy') return { error: 'spice must be "spicy" (the only filterable value — none/unknown are not filter targets).', attribution: RAMEN_ATTR };
  const explicit = Boolean(rich || hrs || spc);
  if (!rich) { for (const [rx, v] of VIBE_RICH_INTENT) if (rx.test(q)) { rich = v; break; } }
  if (!hrs) { for (const [rx, v] of VIBE_HOURS_INTENT) if (rx.test(q)) { hrs = v; break; } }
  if (!spc && VIBE_SPICE_INTENT.test(q) && !VIBE_SPICE_NEG.test(q)) spc = 'spicy';
  let embedText = String(q).slice(0, 300);
  let sceneTerms = null;
  for (const [rx, terms, d] of VIBE_SCENE_EXPAND) {
    if (rx.test(q)) {
      sceneTerms = terms;
      if (!rich && d.rich) rich = d.rich;
      if (!hrs && d.hours) hrs = d.hours;
      embedText = `${embedText} ${terms}`;
      break;
    }
  }
  const attrFilter = {};
  if (rich) attrFilter.richness = rich;
  if (hrs) attrFilter.hours = hrs;
  if (spc) attrFilter.spice = spc;
  let vector;
  try {
    const emb = await env.AI.run('@cf/baai/bge-m3', { text: [embedText] });
    vector = emb && emb.data && emb.data[0];
  } catch (e) { /* fall through to the error below */ }
  if (!vector) return { error: 'Query embedding failed — please retry.', attribution: RAMEN_ATTR };
  const toShop = (m, attrMatched) => {
    const md = m.metadata || {};
    return {
      id: m.id, name: md.name, name_en: md.name_en || null,
      pref: md.pref, city: md.city,
      keito: md.keito ? String(md.keito).split(',') : [],
      ...(md.richness ? { richness: md.richness } : {}),
      ...(md.hours ? { hours_class: String(md.hours).split(',') } : {}),
      ...(md.spice ? { spice_level: md.spice } : {}),
      status: md.status || 'active',
      ...(attrMatched != null ? { attr_matched: attrMatched } : {}),
      similarity: Math.round(m.score * 10000) / 10000,
    };
  };
  // blend fallback keeps only what the caller stated explicitly (drops inferred pref/attrs),
  // so a wrong inference can narrow the top results but never empty them.
  const fallbackFilter = { ...filter };
  if (inferredPref) delete fallbackFilter.pref;
  let shops;
  if (Object.keys(attrFilter).length) {
    // attribute-aware path: verified-attribute shops first; if the pool is thin and
    // a filter was only INFERRED, blend in plain semantic matches after them.
    const resA = await env.VECTORIZE.query(vector, {
      topK: cap, returnValues: false, returnMetadata: 'all',
      filter: { ...filter, ...attrFilter },
    });
    shops = (resA && resA.matches ? resA.matches : []).map((m) => toShop(m, true));
    if ((!explicit || inferredPref) && shops.length < cap) {
      const bf = { ...fallbackFilter, ...(explicit ? attrFilter : {}) };
      const resB = await env.VECTORIZE.query(vector, {
        topK: cap, returnValues: false, returnMetadata: 'all',
        ...(Object.keys(bf).length ? { filter: bf } : {}),
      });
      const seen = new Set(shops.map((s2) => s2.id));
      for (const m of (resB && resB.matches ? resB.matches : [])) {
        if (seen.has(m.id) || shops.length >= cap) continue;
        shops.push(toShop(m, explicit ? true : false));
      }
    }
  } else {
    const res = await env.VECTORIZE.query(vector, {
      topK: cap, returnValues: false, returnMetadata: 'all',
      ...(Object.keys(filter).length ? { filter } : {}),
    });
    shops = (res && res.matches ? res.matches : []).map((m) => toShop(m, null));
    if (inferredPref && shops.length < cap) {
      const resB = await env.VECTORIZE.query(vector, {
        topK: cap, returnValues: false, returnMetadata: 'all',
        ...(Object.keys(fallbackFilter).length ? { filter: fallbackFilter } : {}),
      });
      const seen = new Set(shops.map((s2) => s2.id));
      for (const m of (resB && resB.matches ? resB.matches : [])) {
        if (seen.has(m.id) || shops.length >= cap) continue;
        shops.push(toShop(m, null));
      }
    }
  }
  return {
    query: { q, pref: filter.pref || null, status: st, semantic: true,
             ...(filter.pref ? { pref_source: explicitPref ? 'param' : 'inferred' } : {}),
             ...(sceneTerms ? { scene_expansion: sceneTerms } : {}),
             ...(rich ? { richness: rich } : {}), ...(hrs ? { hours: hrs } : {}),
             ...(spc ? { spice: spc } : {}),
             ...(Object.keys(attrFilter).length ? { attr_filter_source: explicit ? 'param' : 'inferred' } : {}) },
    count: shops.length, shops,
    note: 'Semantic matches, best first (lite shape + similarity 0–1). Use get_ramen_shop / GET /v1/shops/{id} for the full record; use search_ramen for exact name/keito/geo filters.',
    attribution: RAMEN_ATTR,
  };
}

// ---- station_search: semantic station discovery + hybrid metadata filters -----------------------
// Index gachi-station-vibe: one bge-m3 sentence per physical station (9,035 clusters from the Japan
// Station Master), carrying lines/terminal size, ramen density BAND words (never exact counts — so
// monthly count drift doesn't force re-embeds), in-station accessible-toilet equipment, official
// hazard categories and ridership. Built by vibe/station_sentences.py + vibe/station_upsert.py.
// Design validated in the S3 Vectors lab (2026-07): pure vector ranking is fuzzy on conjunctive
// constraints — the metadata filter GUARANTEES the constraint, the embedding ranks by fit.
const STATION_ATTR = {
  sources: [
    'Station master & lines — Japan Station Master (gachi-open-datasets, CC BY 4.0; ODPT/Wikidata-derived)',
    'Ramen stats — gachi-tokusuru.com ramen DB (monthly re-verified)',
    'In-station accessible-toilet stats — Tokyo Metropolitan Bureau of Social Welfare (CC BY 4.0), Tokyo stations only',
    'Ridership — ODPT PassengerSurvey (Greater Tokyo operators only)',
    'Hazard — 国土交通省 不動産情報ライブラリ official categories (point lookup at the station, relayed as-is)',
  ],
  provider: 'https://api.gachi-tokusuru.com',
};
const STATION_SEARCH_NOTES = [
  'toilet stats cover Tokyo stations only (missing ≠ no toilets)',
  'ridership covers Greater Tokyo operators only',
  'hazard fields are official MLIT categories relayed as-is — not a safety judgment',
];

// 駅検索専用のpref推論: 共通のvibeInferPref(助詞必須)に加え、「〜駅 埼玉」のような
// 末尾/区切りの裸の都道府県名も拾う(検索クエリの定型)。ramen側の挙動には影響させない。
function stationInferPref(q) {
  const p = vibeInferPref(q);
  if (p) return p;
  for (const full of VIBE_PREF_FULL) {
    if (full === '北海道') continue; // 全名はvibeInferPrefのincludesで既に拾済み
    const stem = full.replace(/[都府県]$/, '');
    const re = stem === '京都' ? /(?<!東)京都(?=\s|$|、|。)/ : new RegExp(stem + '(?=\\s|$|、|。)');
    if (re.test(q)) return full;
  }
  return null;
}

// 品質・味の語は評価しない(レビューデータ無し)ことの正直な宣言に使う検知。
const STATION_TASTE_WORDS = /うまい|旨い|美味い|美味しい|おいしい|絶品|名店|delicious|tasty|good\s+(food|ramen|eats)|best\s+(food|ramen)/i;

// softフィルタ一致への加算値(final_score = similarity + BOOST)。確定値0.005(2026-07-31決裁・
// 定数vs相対式k×pool_spreadの7クエリベンチで決定: top12集合は全ケース同一、相対式はspreadが
// 外れ値駆動のため広プールで二分割閾値を超えるリスクがあり定数を採用)。
// 基準0: softフィルタはタイブレークであり順位改変機構ではない — similarity差がBOOST以内の
// 近接駅間でのみデータ確認済みの駅を優先し、それを超える差は覆さず、いかなる場合も除外しない。
// 制約: BOOSTが「プール内の max(sim of false) − min(sim of true)」(実測0.0115〜0.0154)を超えると
// 事実上の二分割に戻りデータ欠損県が常に沈む。
const SOFT_FILTER_BOOST = 0.005;

// ---- ハザード意図辞書(複合展開) ----
// 低リスク方向の言い回し: ない/なし/低い/避けたい/安心/安全/少ない/心配(がない)/不安/〜に強い 等。
// 高リスク値の定義(risk_notes用・公式区分の中継のみ):
//   flood_rank>=3 = 浸水想定3.0m以上 / liq_level 1-2 = 非常に液状化しやすい・液状化しやすい / storm_surge = 高潮浸水想定区域内
const HAZ_LOWRISK_WORDS = /ない|なし|低|避け|安心|安全|少な|心配|不安|強い|良い|いい|しにくい|しづらい|free|low|safe|avoid|without|resistant/i;
const HAZ_FLOOD_WORDS = /洪水|水害|浸水|高潮|flood|storm surge|inundation/i;
const HAZ_LIQ_WORDS = /液状化|地盤|liquefaction|\bground\b/i; // \b: undergroundに部分一致させない
const HAZ_BROAD_WORDS = /災害|ハザード|disaster|hazard/i;
function stationRiskNotes(md) {
  const notes = [];
  if ((md.flood_rank ?? 0) >= 3) notes.push(`flood: ${md.flood_ja || `rank ${md.flood_rank}`}（浸水想定3.0m以上）`);
  if (md.liq_level >= 1 && md.liq_level <= 2 && md.liq_note) notes.push(`liquefaction: ${md.liq_note}`);
  if (md.storm_surge) notes.push('storm_surge: 高潮浸水想定区域内');
  return notes;
}

async function stationSearchPayload(env, a) {
  const q = (a.q || '').trim();
  if (!q) return { error: 'Provide q — describe the station/area you want, e.g. "朝ラーメンが食べられて車椅子トイレがある駅" / "terminal with late-night ramen".', attribution: STATION_ATTR };
  if (!env.AI || !env.VECTORIZE_STATION) return { error: 'Station search is not available on this deployment.', attribution: STATION_ATTR };
  // name_containsモードはgetByIds経路(Vectorize topK20制約なし)なのでlimit上限300(=候補上限CAND_CAPと同値・全件返却可能)。通常モードは20。
  const capMax = (a.name_contains || '').trim() ? 300 : 20;
  const cap = Math.min(Math.max(Number.parseInt(a.limit, 10) || 10, 1), capMax);
  // explicit filters (params) — these always survive the blend fallback
  const explicitFilter = {};
  if (a.pref) {
    const np = ramenNormalizePref(a.pref);
    if (!np) return { error: `Unknown prefecture "${a.pref}". Use 東京都/千葉県… or romaji (tokyo/osaka).`, attribution: STATION_ATTR };
    explicitFilter.pref = np;
  }
  if (a.morning_ramen === true) explicitFilter.has_morning_ramen = true;
  if (a.late_ramen === true) explicitFilter.has_late_ramen = true;
  if (a.diaper === true) explicitFilter.has_diaper = true;
  const nMin = Number(a.ramen_min);
  if (Number.isFinite(nMin) && nMin > 0) explicitFilter.ramen_count = { $gte: nMin };
  const tMin = Number(a.accessible_toilet_min);
  if (Number.isFinite(tMin) && tMin > 0) explicitFilter.acc_toilet_count = { $gte: tMin };
  const fMax = Number(a.flood_rank_max);
  if (a.flood_rank_max !== undefined && Number.isFinite(fMax)) explicitFilter.flood_rank = { $lte: Math.max(0, Math.min(6, fMax)) };
  // inferred filters (query-text intent) — dropped by the blend fallback if the pool runs thin
  const filter = { ...explicitFilter };
  const inferred = [];
  if (!('pref' in explicitFilter)) {
    const ip = stationInferPref(q);
    if (ip) { filter.pref = ip; inferred.push(`pref=${ip}`); }
  }
  if (a.morning_ramen === undefined && /朝ラー|朝から|早朝|モーニング|morning|breakfast/i.test(q)) { filter.has_morning_ramen = true; inferred.push('morning_ramen'); }
  if (a.late_ramen === undefined && /深夜|夜中|夜遅|〆|締めの|シメの|late night|midnight/i.test(q)) { filter.has_late_ramen = true; inferred.push('late_ramen'); }
  // 設備系(トイレ設備)のinferredフィルタはSOFT: データが東京都限定のため、hard除外だと
  // 46道府県がデータ欠損だけで黙って消える。確認済み駅をブースト・unknownは降格で残す。
  // 明示パラメータ(a.diaper===true等)は従来どおりhard(上のexplicitFilterで処理済み)。
  const softFilters = [];
  if (a.diaper === undefined && /おむつ|オムツ|diaper|子連れ|赤ちゃん|ベビー|子育て/i.test(q)) {
    softFilters.push({ filter: 'diaper', test: (md) => Boolean(md.has_diaper), coverage: 'toilet equipment data covers Tokyo stations only' });
  }
  if (a.accessible_toilet_min === undefined && /車椅子|車いす|バリアフリー|wheelchair|accessible/i.test(q)) {
    softFilters.push({ filter: 'accessible_toilet', test: (md) => (md.acc_toilet_count ?? 0) >= 1, coverage: 'in-station accessible-toilet data covers Tokyo stations only' });
  }
  // ハザード系のinferredフィルタはHARD維持(公式データが全国カバレッジで欠損問題がないため)。
  // 水害系の語は flood_rank だけでなく高潮(storm_surge)も複合で展開する — 高潮浸水想定区域の
  // 埋立地駅が「水害リスク低い」に混入しないように。広域語(災害/hazard)は3要素すべて。
  const wantsLowRisk = HAZ_LOWRISK_WORDS.test(q);
  if (a.flood_rank_max === undefined && wantsLowRisk && (HAZ_FLOOD_WORDS.test(q) || HAZ_BROAD_WORDS.test(q))) {
    filter.flood_rank = { $lte: 0 };
    filter.storm_surge = false;
    inferred.push('flood_rank_max=0', 'storm_surge=false');
  }
  if (wantsLowRisk && (HAZ_LIQ_WORDS.test(q) || HAZ_BROAD_WORDS.test(q))) {
    filter.liq_level = { $gte: 4 };
    inferred.push('liq_level_min=4 (公式区分: 4=やや液状化しにくい, 5=液状化しにくい)');
  }
  // 品質・味の語は評価できない(レビューデータ無し)。暗黙にkeito多様性等へ寄せ替えない — noteで正直に宣言。
  const tasteNote = STATION_TASTE_WORDS.test(q)
    ? "Taste/quality words ('うまい', 'delicious'…) are not evaluated — this dataset has no review/rating data. Ramen-related ranking reflects shop density and style variety only."
    : null;
  let vector;
  try {
    const emb = await env.AI.run('@cf/baai/bge-m3', { text: [q.slice(0, 300)] });
    vector = emb && emb.data && emb.data[0];
  } catch (e) { /* fall through */ }
  if (!vector) return { error: 'Query embedding failed — please retry.', attribution: STATION_ATTR };
  const toStation = (m) => {
    const md = m.metadata || {};
    const riskNotes = stationRiskNotes(md); // フィルタ通過後も高リスク要素は沈黙させない(公式区分の中継のみ)
    return {
      station_id: m.id, name: md.name || null, name_ja: md.name_ja || null, pref: md.pref || null,
      similarity: Math.round(m.score * 10000) / 10000,
      ramen: { count: md.ramen_count ?? 0, keito_top: md.keito_top ? String(md.keito_top).split(',') : [],
               morning: Boolean(md.has_morning_ramen), late_night: Boolean(md.has_late_ramen) },
      toilet: { accessible_count: md.acc_toilet_count ?? 0, diaper: Boolean(md.has_diaper), baby_chair: Boolean(md.has_baby_chair) },
      hazard: { flood_rank: md.flood_rank ?? 0, flood_category_ja: md.flood_ja || 'なし',
                ...(md.rivers ? { rivers: String(md.rivers).split(', ') } : {}),
                liquefaction_note_ja: md.liq_note || null, storm_surge_zone: Boolean(md.storm_surge) },
      ...(riskNotes.length ? { risk_notes: riskNotes } : {}),
      lines: md.line_count ?? 0,
      ...(md.ridership_latest ? { ridership_latest: md.ridership_latest } : {}),
      ...(md.lat ? { lat: md.lat, lng: md.lng } : {}),
    };
  };
  // ---- name_contains: 駅名部分一致モード(P2-a) ----
  // Vectorize metadataは部分一致検索できない → station:names表(9,035件)で候補idを確定し、
  // getByIdsでベクトル+metadataを取ってqでランキング。役割分担: name_contains=絞り込み / q=ランキング。
  const nameContains = (a.name_contains || '').trim();
  let rawMatches = null;
  let nameMatchesTotal = null;
  let nameTruncNote = null;
  if (nameContains) {
    const tbl = await env.TOILET_KV.get('station:names', 'json');
    if (!tbl) return { error: 'Station name table is not seeded on this deployment.', attribution: STATION_ATTR };
    const ncNorm = nameContains.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');
    let cand = tbl.filter((s) =>
      (s.nj && s.nj.includes(nameContains)) ||
      (ncNorm && s.n && s.n.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '').includes(ncNorm)));
    if (filter.pref) cand = cand.filter((s) => s.pref === filter.pref);
    nameMatchesTotal = cand.length;
    filter.name_contains = nameContains; // applied_filtersへの反映(表示用)
    if (!cand.length) {
      const meta0 = await env.TOILET_KV.get('ramen:meta', 'json').catch(() => null);
      return {
        query: q, count: 0, applied_filters: filter, name_matches_total: 0, stations: [],
        note: `No station name contains "${nameContains}"${filter.pref ? ` in ${filter.pref}` : ''}.`,
        notes: STATION_SEARCH_NOTES, ...(meta0 && meta0.data_as_of ? { stats_as_of: meta0.data_as_of } : {}),
        disclaimer: HAZARD_DISCLAIMER, attribution: STATION_ATTR,
      };
    }
    const CAND_CAP = 300; // getByIdsは20id/回上限 → 15サブリクエスト。超過分はid順で切る(切った事実はnoteで明示=無言の切り捨て禁止)
    if (cand.length > CAND_CAP) {
      nameTruncNote = `name_contains matched ${cand.length} stations; ranked within the first ${CAND_CAP} (by station_id). Narrow with pref or a longer substring for exhaustive coverage.`;
      cand = cand.slice(0, CAND_CAP);
    }
    const vecs = [];
    for (let i = 0; i < cand.length; i += 20) {
      const got = await env.VECTORIZE_STATION.getByIds(cand.slice(i, i + 20).map((s) => s.id));
      for (const g of got || []) vecs.push(g);
    }
    const qn = Math.sqrt(vector.reduce((s2, x) => s2 + x * x, 0));
    const cos = (v) => {
      let dot = 0, n2 = 0;
      for (let i = 0; i < v.length; i++) { dot += v[i] * vector[i]; n2 += v[i] * v[i]; }
      return n2 ? dot / (qn * Math.sqrt(n2)) : 0;
    };
    // 残りのhardフィルタ(ハザード/ラーメン等)をmetadata上で同義評価
    const mdMatch = (md) => Object.entries(filter).every(([k, cond]) => {
      if (k === 'pref' || k === 'name_contains') return true; // 適用済み
      const v = md[k];
      if (cond && typeof cond === 'object') {
        if ('$lte' in cond && !(Number(v ?? 0) <= cond.$lte)) return false;
        if ('$gte' in cond && !(Number(v ?? 0) >= cond.$gte)) return false;
        return true;
      }
      return Boolean(v ?? false) === Boolean(cond);
    });
    rawMatches = vecs
      .filter((g) => mdMatch(g.metadata || {}))
      .map((g) => ({ id: g.id, score: cos(g.values), metadata: g.metadata }))
      .sort((x, y) => y.score - x.score);
  }
  // softフィルタあり: プールを最大まで取り、スコア加算で緩やかにブースト。
  // 二分割(soft_matchedを第1ソートキー)にすると「他県が消える」が「他県が沈む」に変わるだけなので禁止 —
  // final_score = similarity + SOFT_FILTER_BOOST × (全soft条件一致 ? 1 : 0) の単一キー降順。
  // BOOSTはプール内のsimilarity幅(bge-m3で約0.02)より小さい同帯タイブレーク値であること。
  if (rawMatches === null) {
    const topK = softFilters.length ? 20 : cap; // 20 = Vectorize returnMetadata:'all' の上限
    const res = await env.VECTORIZE_STATION.query(vector, {
      topK, returnValues: false, returnMetadata: 'all',
      ...(Object.keys(filter).length ? { filter } : {}),
    });
    rawMatches = res && res.matches ? res.matches : [];
  }
  let stations;
  if (softFilters.length) {
    const softOK = (m) => softFilters.every((sf) => sf.test(m.metadata || {}));
    stations = rawMatches
      .map((m) => ({ m, ok: softOK(m), final: m.score + (softOK(m) ? SOFT_FILTER_BOOST : 0) }))
      .sort((x, y) => y.final - x.final)
      .slice(0, cap)
      .map(({ m, ok, final }) => ({
        ...toStation(m),
        soft_matched: ok,
        final_score: Math.round(final * 10000) / 10000,
      }));
  } else {
    stations = rawMatches.slice(0, cap).map(toStation);
  }
  // blend fallback: a wrong INFERRED filter may narrow results but must never empty them.
  // name_containsモードでは無効(緩和クエリは名前条件を持たず、非該当駅が混入するため)。
  if (!nameContains && inferred.length && stations.length < cap) {
    const resB = await env.VECTORIZE_STATION.query(vector, {
      topK: cap, returnValues: false, returnMetadata: 'all',
      ...(Object.keys(explicitFilter).length ? { filter: explicitFilter } : {}),
    });
    const seen = new Set(stations.map((s2) => s2.station_id));
    for (const m of (resB && resB.matches ? resB.matches : [])) {
      if (seen.has(m.id) || stations.length >= cap) continue;
      stations.push({ ...toStation(m), filter_matched: false });
    }
  }
  const meta = await env.TOILET_KV.get('ramen:meta', 'json').catch(() => null);
  const explicitCount = Object.keys(explicitFilter).length;
  const noteParts = [tasteNote, nameTruncNote].filter(Boolean);
  return {
    query: q, count: stations.length,
    applied_filters: filter,
    ...(nameMatchesTotal !== null ? { name_matches_total: nameMatchesTotal } : {}),
    ...(softFilters.length ? {
      soft_filters: softFilters.map((sf) => ({
        filter: sf.filter,
        mode: `boost — confirmed stations get +${SOFT_FILTER_BOOST} added to similarity (final_score); unknown/missing data is never excluded and can still outrank on similarity`,
        coverage: sf.coverage,
      })),
    } : {}),
    filter_source: inferred.length && explicitCount ? 'explicit+inferred' : inferred.length ? 'inferred' : explicitCount ? 'explicit' : 'none',
    stations,
    ...(noteParts.length ? { note: noteParts.join(' ') } : {}),
    notes: STATION_SEARCH_NOTES,
    ...(meta && meta.data_as_of ? { stats_as_of: meta.data_as_of } : {}),
    disclaimer: HAZARD_DISCLAIMER,
    attribution: STATION_ATTR,
  };
}

async function ramenShopPayload(env, id) {
  const idx = await env.TOILET_KV.get('ramen:ididx', 'json');
  let pref = idx ? idx[id] : null;
  let mergedInto = null;
  if (!pref) {
    // 統合済み旧ID: rk_はstable IDとして公開しているので404にせず正レコードへ解決(merged_into付き)。
    const aliases = await env.TOILET_KV.get('ramen:aliases', 'json').catch(() => null);
    const canon = aliases ? aliases[id] : null;
    if (!canon) return null;
    mergedInto = canon;
    pref = idx ? idx[canon] : null;
    if (!pref) return null;
    id = canon;
  }
  const arr = (await env.TOILET_KV.get(`ramen:pref:${pref}`, 'json')) || [];
  const shop = arr.find((s) => s.id === id);
  if (!shop) return null;
  const payload = { shop: ramenPublicShape(shop), definitions: RAMEN_DEFS, attribution: RAMEN_ATTR };
  if (mergedInto) {
    payload.merged_into = mergedInto;
    payload.note = `The requested id was merged into ${mergedInto} (duplicate-record consolidation 2026-07-31); returning the canonical record.`;
  }
  return payload;
}

async function ramenShopByName(env, name, pref, city) {
  pref = ramenNormalizePref(pref);
  if (!pref && city) {
    const r = await ramenResolvePrefFromCity(env, city);
    if (r.error) return { error: r.error, attribution: RAMEN_ATTR };
    pref = r.pref;
    city = r.city;
  }
  if (!pref) return { error: 'pref (e.g. 千葉県) or city (e.g. 松戸市) is required with name.', attribution: RAMEN_ATTR };
  let arr = await env.TOILET_KV.get(`ramen:pref:${pref}`, 'json');
  if (!arr) return { error: `No data for pref "${pref}".`, attribution: RAMEN_ATTR };
  if (city) arr = arr.filter((s) => (s.city || '').includes(city));
  const exact = arr.filter((s) => s.name === name);
  const partial = exact.length ? exact : arr.filter((s) => (s.name || '').includes(name));
  if (!partial.length) return { error: `No shop matched "${name}" in ${city || pref}.`, attribution: RAMEN_ATTR };
  return {
    shop: ramenPublicShape(partial[0]),
    other_matches: partial.slice(1, 10).map((s) => ({ id: s.id, name: s.name, city: s.city })),
    definitions: RAMEN_DEFS, attribution: RAMEN_ATTR,
  };
}

async function ramenChangesPayload(env, since, { maxEvents = 500, minDate = null } = {}) {
  const c = await env.TOILET_KV.get('ramen:changes', 'json');
  if (!c) return { error: 'Ramen changes feed is not initialized yet.', attribution: RAMEN_ATTR };
  let events = c.events || [];
  if (since) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) return { error: 'since must be YYYY-MM-DD.', attribution: RAMEN_ATTR };
    events = events.filter((e) => e.date >= since);
  }
  // No-auth: floor to a recent window so the full changes feed (a Pro deliverable) can't be bulk-pulled.
  if (minDate) events = events.filter((e) => e.date >= minDate);
  const sliced = events.slice(0, maxEvents);
  const r = {
    dataset: 'ramen', generated_at: c.generated_at || null, since: since || null,
    count: minDate ? sliced.length : events.length, events: sliced,
    definitions: RAMEN_DEFS, attribution: RAMEN_ATTR,
  };
  if (minDate) r.window = `No-auth preview: last 7 days, up to ${maxEvents} events. The full changes feed (all history) needs a key: ${RAMEN_UPGRADE_URL}`;
  return r;
}

// Dataset-level freshness date (ramen:meta.data_as_of). Attached to every ramen response so callers
// have an HONEST freshness signal without over-reading per-shop last_seen (which for active shops is
// just this same build date). null if meta not seeded.
async function ramenDataAsOf(env) {
  const m = await env.TOILET_KV.get('ramen:meta', 'json');
  return (m && m.data_as_of) || null;
}

// ---- ping payloads (freshness self-proof, read live from KV) -------------------------------------
// Unobtainable fields are OMITTED (not null) so the health check never lies about what it can prove.
async function pingRamenPayload(env) {
  const m = await env.TOILET_KV.get('ramen:meta', 'json');
  const active = m && m.status_counts && typeof m.status_counts.active === 'number' ? m.status_counts.active : null;
  const asOf = (m && m.data_as_of) || null;
  const p = { status: 'ok', server: 'Gachi-Ramen', version: BUILD_VERSION.commit };
  if (active != null) p.shops_active = active;         // ramen:meta.status_counts.active — live, not hardcoded
  if (asOf) p.last_weekly_crawl = asOf;                 // ramen:meta.data_as_of — latest dataset refresh date
  p.coverage = 'all 47 prefectures';
  p.rate_limit_noauth = '60 req/min per IP';
  return p;
}
async function pingApiPayload(env, toolCount) {
  const a = await readRealtime(env, 'alerts:active', ALERTS_MAX_AGE_S);
  const t = await readRealtime(env, 'train:status:_all', TRAIN_MAX_AGE_S);
  const realtime = {};
  if (a.fetched_at) realtime.jma_alerts_updated = a.fetched_at;
  if (t.fetched_at) realtime.train_status_updated = t.fetched_at;
  const p = {
    status: 'ok', server: 'Tokyo Restroom Finder (Gachi-DB)', version: BUILD_VERSION.commit,
    tools: toolCount, stations_covered: STATIONS_COVERED,
  };
  if (Object.keys(realtime).length) p.realtime_layers = realtime;
  p.rate_limit_noauth = '60 req/min per IP';
  return p;
}
function withRamenDataAsOf(payload, dataAsOf) {
  if (payload && typeof payload === 'object' && !payload.error && dataAsOf) payload.data_as_of = dataAsOf;
  return payload;
}

// Auth + shared metering for REST (same key + same monthly counter as MCP).
async function restAuthAndMeter(request, env, opts = {}) {
  const auth = await resolveAuth(request, env);
  if (!auth.ok) {
    return { error: restError('unauthorized', `Missing or invalid API key. Get a free key at ${UPGRADE_URL}`, 401) };
  }
  // Ramen product is entitlement-gated: a general Gachi Data API key must never reach it.
  if (opts.ramenOnly && auth.product !== 'ramen' && auth.product !== 'all') {
    return { error: restError('forbidden', 'This API key is not valid for the Ramen API. Get a ramen key at https://ramen.gachi-tokusuru.com', 403) };
  }
  const bl = await keyedBurstLimit(env, auth);
  if (!bl.ok) {
    return { error: restError('rate_limit_exceeded', `Rate limit exceeded (${bl.rps} req/s on ${auth.plan}). Slow the request rate — your monthly quota is unaffected.`, 429, { 'retry-after': '1' }) };
  }
  const m = await meterUsageFor(env, auth);
  if (!m.allowed) {
    const period = m.daily ? 'Daily' : 'Monthly';
    const suffix = m.daily ? `resets at 00:00 UTC — upgrade to Pro for unlimited: ${RAMEN_UPGRADE_URL}` : `Upgrade: ${UPGRADE_URL}`;
    return {
      error: restError(
        'rate_limit_exceeded',
        `${period} limit reached (${m.used}/${m.limit} on ${auth.plan}). ${suffix}`,
        429,
        { 'retry-after': '3600' },
      ),
    };
  }
  return { ok: true, auth };
}

// Ramen REST gate. Mirrors the MCP ramen policy so REST has the same open front door: a VALID ramen
// key gets full metered access (plan burst + monthly quota); no/invalid/expired key falls to the
// no-auth path — IP rate-limited (60/min) and served with the same reduced caps as MCP no-auth
// (search limit 20, nearby radius 2,000 m, changes last 7 days ≤50), across all 47 prefectures.
// The $500 Pro moat is full volume + the full change-history feed + higher limits, not REST access.
async function ramenRestGate(request, env, ctx) {
  const auth = await resolveAuth(request, env);
  if (auth.ok) {
    // A valid key for a different product must never reach the ramen data.
    if (auth.product !== 'ramen' && auth.product !== 'all') {
      return { error: restError('forbidden', 'This API key is not valid for the Ramen API. Get a ramen key at https://ramen.gachi-tokusuru.com', 403) };
    }
    const bl = await keyedBurstLimit(env, auth);
    if (!bl.ok) {
      return { error: restError('rate_limit_exceeded', `Rate limit exceeded (${bl.rps} req/s on ${auth.plan}). Slow the request rate — your monthly quota is unaffected.`, 429, { 'retry-after': '1' }) };
    }
    const m = await meterUsageFor(env, auth);
    if (!m.allowed) {
      const period = m.daily ? 'Daily' : 'Monthly';
      const suffix = m.daily ? `resets at 00:00 UTC — upgrade to Pro for unlimited: ${RAMEN_UPGRADE_URL}` : `Upgrade: ${UPGRADE_URL}`;
      return { error: restError('rate_limit_exceeded', `${period} limit reached (${m.used}/${m.limit} on ${auth.plan}). ${suffix}`, 429, { 'retry-after': '3600' }) };
    }
    return { ok: true, auth, noauth: false };
  }
  // No/invalid/expired key: serve the clamped no-auth path (same as MCP), IP rate-limited.
  const rl = await noauthCallLimit(env, request);
  if (!rl.ok) {
    return { error: restError('rate_limit_exceeded', 'Rate limit exceeded (60 requests/minute per IP). Slow down, or get a free key for higher, metered limits: ' + UPGRADE_URL, 429, { 'retry-after': '60' }) };
  }
  bumpNoauthStat(env, ctx, 'rest');
  return { ok: true, noauth: true };
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
    out.livability = { transit: { nearest_station_km: t.nearest_station_km ?? null, bus_stops_within_1km: t.bus_stops_within_1km ?? null, bus_stops_basis: 'count within 1 km of the municipality centroid (representative point) — density near the town centre, not whole-municipality coverage', source: BUSSTOP_ATTR.source, derived: 'nearest_station_km and bus_stops_within_1km are computed by gachi-tokusuru.com via spatial join from the municipality centroid; bus-stop points from ' + BUSSTOP_ATTR.source + ', nearest station from the Japan Station Master (ODPT + MLIT N02).' } };
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
  const bl = await keyedBurstLimit(env, auth);
  if (!bl.ok) return { error: restError('rate_limit_exceeded', `Rate limit exceeded (${bl.rps} req/s on ${auth.plan}). Slow the request rate — your monthly quota is unaffected.`, 429, { 'retry-after': '1' }) };
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
async function stationContextPayload(env, stationRef, fields) {
  const ref = (stationRef || '').trim();
  let sid = ref;
  let resolvedName = null;
  // Accept a station name (Japanese 新宿 or romaji Shinjuku) as well as an st_ id.
  if (sid && !/^st_/i.test(sid)) {
    const rec = await resolveStationByName(env, sid);
    if (rec && rec.id) { sid = rec.id; resolvedName = rec.n || rec.nj || null; }
    else return { error: `No station found for "${ref}". Pass a station name (Shinjuku / 新宿) or a Japan Station Master station_id (e.g. st_00001).` };
  }
  const code = sid ? await env.TOILET_KV.get(`stamuni:${sid}`) : null;
  if (!code) return { error: `Resolved station "${resolvedName || sid}" (${sid}), but no municipality context is mapped for it yet. Try a nearby major station, or query the municipality directly with get_municipality_context.` };
  const sta = await env.TOILET_KV.get(`sta:${sid}`, 'json');
  const ctx = await municipalityContextPayload(env, code, fields);
  if (!ctx.error) ctx.resolved_via_station = { station_id: sid, name: sta?.n || null, name_ja: sta?.nj || null };
  return ctx;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    // ramen.gachi-tokusuru.com is the standalone ramen product; api.* is the full data API.
    const isRamen = url.hostname === RAMEN_HOST;

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

    // Server icon (referenced from initialize serverInfo.icon; also usable as a favicon).
    if (request.method === 'GET' && (url.pathname === '/icon.svg' || url.pathname === '/favicon.svg')) {
      return new Response(isRamen ? RAMEN_ICON_SVG : API_ICON_SVG, {
        headers: { 'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': 'public, max-age=86400', ...CORS },
      });
    }

    // ---- OAuth 2.1 (remote MCP auth; enables claude.ai web / Desktop connectors) ----
    if (request.method === 'GET' && (url.pathname === '/.well-known/oauth-protected-resource' || url.pathname === '/.well-known/oauth-protected-resource/mcp')) {
      return Response.json(protectedResourceMetadata(isRamen), { headers: { ...CORS, 'cache-control': 'public, max-age=3600' } });
    }
    if (request.method === 'GET' && (url.pathname === '/.well-known/oauth-authorization-server' || url.pathname === '/.well-known/oauth-authorization-server/mcp')) {
      return Response.json(authServerMetadata(), { headers: { ...CORS, 'cache-control': 'public, max-age=3600' } });
    }
    // Dynamic Client Registration (RFC 7591): public client, no secret.
    if (request.method === 'POST' && url.pathname === '/register') {
      let b; try { b = await request.json(); } catch { b = {}; }
      const redirect_uris = Array.isArray(b?.redirect_uris) ? b.redirect_uris.filter((x) => typeof x === 'string').slice(0, 10) : [];
      const client_id = randToken('oc_');
      const client_secret = randToken('cs_'); // issued for confidential clients (e.g. claude.ai web); PKCE-only public clients may ignore it
      const authMethod = (b?.token_endpoint_auth_method === 'none') ? 'none' : 'client_secret_post';
      await env.TOILET_KV.put(`oauthclient:${client_id}`, JSON.stringify({ redirect_uris, client_secret, client_name: String(b?.client_name || '').slice(0, 120), created: new Date().toISOString() }), { expirationTtl: 34560000 });
      return Response.json({
        client_id, client_secret, client_id_issued_at: Math.floor(Date.now() / 1000), client_secret_expires_at: 0, redirect_uris,
        grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
        token_endpoint_auth_method: authMethod, client_name: String(b?.client_name || '') || undefined,
      }, { status: 201, headers: { ...CORS, 'cache-control': 'no-store' } });
    }
    // Authorization endpoint (PKCE S256 mandatory; explicit-consent via ?approve=1).
    if (request.method === 'GET' && url.pathname === '/authorize') {
      const q = url.searchParams;
      if ((q.get('response_type') || '') !== 'code') return oauthErrPage('unsupported_response_type', 'Only response_type=code is supported.');
      const cc = q.get('code_challenge') || '';
      if ((q.get('code_challenge_method') || '') !== 'S256' || !cc) return oauthErrPage('invalid_request', 'PKCE with code_challenge_method=S256 is required.');
      const client_id = q.get('client_id') || '';
      const client = client_id ? await env.TOILET_KV.get(`oauthclient:${client_id}`, 'json') : null;
      if (!client) return oauthErrPage('invalid_client', 'Unknown client_id — register at /register first.');
      const redirect_uri = q.get('redirect_uri') || '';
      if (!oauthRedirectAllowed(redirect_uri, client.redirect_uris || [])) return oauthErrPage('invalid_request', 'redirect_uri is not registered for this client.');
      if (q.get('approve') !== '1') return oauthConsentPage(url);
      const rl = await mintRateLimit(env, request);
      if (!rl.ok) return oauthErrPage('temporarily_unavailable', 'Too many connections from your network today. Please try again tomorrow.');
      const code = randToken('ac_');
      await env.TOILET_KV.put(`oauthcode:${code}`, JSON.stringify({ client_id, redirect_uri, code_challenge: cc, scope: q.get('scope') || OAUTH_SCOPE, resource: q.get('resource') || OAUTH_RESOURCE, created: Date.now() }), { expirationTtl: 600 });
      const back = new URL(redirect_uri);
      back.searchParams.set('code', code);
      if (q.get('state')) back.searchParams.set('state', q.get('state'));
      return Response.redirect(back.toString(), 302);
    }
    // Token endpoint: authorization_code (PKCE verify) + refresh_token (rotating). access_token = free key.
    if (request.method === 'POST' && url.pathname === '/token') {
      const form = new URLSearchParams(await request.text());
      const grant = form.get('grant_type') || '';
      // Client credentials may arrive via form (client_secret_post) or HTTP Basic (client_secret_basic).
      let cid = form.get('client_id') || '';
      let csecret = form.get('client_secret') || '';
      const basic = request.headers.get('authorization') || '';
      if (basic.startsWith('Basic ')) {
        try { const [u, p] = atob(basic.slice(6)).split(':'); cid = cid || decodeURIComponent(u || ''); csecret = csecret || decodeURIComponent(p || ''); } catch {}
      }
      if (grant === 'authorization_code') {
        const code = form.get('code') || '';
        const rec = code ? await env.TOILET_KV.get(`oauthcode:${code}`, 'json') : null;
        if (!rec) return oauthTokenErr('invalid_grant', 'Authorization code invalid or expired.');
        await env.TOILET_KV.delete(`oauthcode:${code}`); // single-use
        if (rec.client_id !== cid) return oauthTokenErr('invalid_grant', 'client_id mismatch.');
        if (rec.redirect_uri !== (form.get('redirect_uri') || '')) return oauthTokenErr('invalid_grant', 'redirect_uri mismatch.');
        // Confidential client: if a secret is presented, it must match the registered one (claude.ai web).
        const client = await env.TOILET_KV.get(`oauthclient:${cid}`, 'json');
        if (csecret && (!client || client.client_secret !== csecret)) return oauthTokenErr('invalid_client', 'Invalid client_secret.');
        const verifier = form.get('code_verifier') || '';
        if (!verifier || (await sha256b64url(verifier)) !== rec.code_challenge) return oauthTokenErr('invalid_grant', 'PKCE verification failed.');
        // Scope the OAuth key to the product the client asked for (RFC 8707 resource indicator).
        // Both products issue a standard Free key — nationwide, no trial. (The retired ramen trial
        // gated 3 prefectures; that gate is gone, so an OAuth connection is a plain Free connection.)
        const ramenScoped = typeof rec.resource === 'string' && rec.resource.includes(RAMEN_HOST);
        const accessToken = await issueFreeKey(env, 'oauth:' + (rec.client_id || 'connector'), ramenScoped ? 'ramen' : 'gachi');
        const refreshToken = randToken('rt_');
        await env.TOILET_KV.put(`oauthrefresh:${refreshToken}`, JSON.stringify({ key: accessToken, client_id: rec.client_id }), { expirationTtl: 34560000 });
        return Response.json({ access_token: accessToken, token_type: 'Bearer', expires_in: 2592000, refresh_token: refreshToken, scope: rec.scope || OAUTH_SCOPE }, { headers: { ...CORS, 'cache-control': 'no-store' } });
      }
      if (grant === 'refresh_token') {
        const rt = form.get('refresh_token') || '';
        const rr = rt ? await env.TOILET_KV.get(`oauthrefresh:${rt}`, 'json') : null;
        if (!rr) return oauthTokenErr('invalid_grant', 'Refresh token invalid.');
        await env.TOILET_KV.delete(`oauthrefresh:${rt}`); // rotate (OAuth 2.1 public-client)
        const newRt = randToken('rt_');
        await env.TOILET_KV.put(`oauthrefresh:${newRt}`, JSON.stringify({ key: rr.key, client_id: rr.client_id }), { expirationTtl: 34560000 });
        return Response.json({ access_token: rr.key, token_type: 'Bearer', expires_in: 2592000, refresh_token: newRt, scope: OAUTH_SCOPE }, { headers: { ...CORS, 'cache-control': 'no-store' } });
      }
      return oauthTokenErr('unsupported_grant_type', 'Supported: authorization_code, refresh_token.');
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
      const stAttr = found.layer === 'in_station_gate' ? EKINAI_ATTR : tool.attribution;
      return restJson({ ...(await toEnglishStation(env, found)), attribution: stAttr });
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

    // ---- Ramen DB (nationwide ramen shops with monthly freshness) ----
    // Ramen REST is scoped to the standalone product host only — not reachable via the general API.
    if (isRamen && request.method === 'GET' && url.pathname === '/v1/shops') {
      const gate = await ramenRestGate(request, env, ctx);
      if (gate.error) return gate.error;
      const near = (url.searchParams.get('near') || '').split(',');
      const lat = parseFloat(url.searchParams.get('lat') ?? near[0]);
      const lng = parseFloat(url.searchParams.get('lng') ?? near[1]);
      const payload = await ramenSearchPayload(env, {
        pref: (url.searchParams.get('pref') || '').trim() || null,
        city: (url.searchParams.get('city') || '').trim() || null,
        keito: (url.searchParams.get('keito') || '').trim() || null,
        status: (url.searchParams.get('status') || '').trim() || null,
        q: (url.searchParams.get('q') || '').trim() || null,
        chain: (url.searchParams.get('chain') || '').trim() || null,
        chainSub: (url.searchParams.get('chain_sub') || '').trim() || null,
        spiceLevel: (url.searchParams.get('spice_level') || '').trim().toLowerCase() || null,
        match: (url.searchParams.get('match') || '').trim() || null,
        lat, lng, radius: url.searchParams.get('radius'), limit: url.searchParams.get('limit'),
        // No-auth: all 47 prefectures, but limit capped 20 and nearby radius capped 2,000 m (clamped).
        ...(gate.noauth ? { maxLimit: 20, maxRadius: 2000 } : {}),
      });
      if (payload.error) return restError('bad_request', payload.error, 400);
      withRamenDataAsOf(payload, await ramenDataAsOf(env));
      return restJson(payload);
    }
    if (isRamen && request.method === 'GET' && (url.pathname === '/v1/shops/changes' || url.pathname === '/v1/changes')) {
      const gate = await ramenRestGate(request, env, ctx);
      if (gate.error) return gate.error;
      // No-auth: cap to the last 7 days and ≤50 events so the full changes feed (a Pro deliverable) can't be bulk-pulled.
      const changeOpts = gate.noauth
        ? { maxEvents: 50, minDate: new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10) }
        : {};
      const payload = await ramenChangesPayload(env, (url.searchParams.get('since') || '').trim() || null, changeOpts);
      if (payload.error) {
        return payload.error.includes('since') ? restError('bad_request', payload.error, 400)
          : restError('unavailable', payload.error, 503);
      }
      withRamenDataAsOf(payload, await ramenDataAsOf(env));
      return restJson(payload);
    }
    const shopMatch = url.pathname.match(/^\/v1\/shops\/(rk_\d+)$/);
    if (isRamen && request.method === 'GET' && shopMatch) {
      const gate = await ramenRestGate(request, env, ctx);
      if (gate.error) return gate.error;
      const payload = await ramenShopPayload(env, shopMatch[1]);
      if (!payload) return restError('not_found', `Unknown shop id "${shopMatch[1]}".`, 404);
      withRamenDataAsOf(payload, await ramenDataAsOf(env));
      return restJson(payload);
    }

    // OpenAPI spec + a tiny docs page pointing at it
    if (request.method === 'GET' && url.pathname === '/openapi.yaml') {
      return new Response(OPENAPI_YAML, { headers: { 'content-type': 'application/yaml; charset=utf-8', ...CORS } });
    }
    if (request.method === 'GET' && url.pathname === '/docs') {
      return new Response(DOCS_HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
    // Public 1,000-row sample, served on-domain (LP links here instead of a brand-external GitHub account).
    if (request.method === 'GET' && url.pathname === '/sample_1000.json') {
      return new Response(RAMEN_SAMPLE, { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=3600', 'content-disposition': 'inline; filename="sample_1000.json"', ...CORS } });
    }

    // llms.txt — sign-post for agents (project summary, endpoints, datasets, license)
    if (request.method === 'GET' && url.pathname === '/llms.txt') {
      return new Response(LLMS_TXT, { headers: { 'content-type': 'text/plain; charset=utf-8', ...CORS } });
    }

    // Landing page. no-cache so browsers/edge always revalidate — the page is a
    // small dynamic Worker response and must never show a stale pricing table.
    if (request.method === 'GET' && url.pathname === '/') {
      return new Response(isRamen ? RAMEN_LP_HTML : LANDING_HTML, {
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache, must-revalidate' },
      });
    }
    // Ramen technical story (linked from the LP). On-domain so the public site has no external deps.
    if (isRamen && request.method === 'GET' && (url.pathname === '/story' || url.pathname === '/story/')) {
      return new Response(RAMEN_STORY_HTML, {
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache, must-revalidate' },
      });
    }
    // Pro checkout entry (ramen). Redirects to the Stripe $500/mo Payment Link once it's set in
    // PAYMENT_LINKS.ramen_pro; until then, falls back to the contact form so the button is never dead.
    if (isRamen && request.method === 'GET' && url.pathname === '/subscribe') {
      // ?test=1 → Stripe test-mode link for sandbox payment testing (live default otherwise).
      const link = url.searchParams.get('test') === '1' ? PAYMENT_LINK_RAMEN_PRO_TEST : PAYMENT_LINKS.ramen_pro;
      const dest = /^https?:\/\//.test(link) ? link : `${RAMEN_UPGRADE_URL}/#contact`;
      return Response.redirect(dest, 302);
    }

    if (request.method === 'GET' && url.pathname === '/robots.txt') {
      const sm = isRamen ? 'https://ramen.gachi-tokusuru.com/sitemap.xml' : 'https://api.gachi-tokusuru.com/sitemap.xml';
      return new Response(
        `User-agent: *\nAllow: /\nSitemap: ${sm}\n`,
        { headers: { 'content-type': 'text/plain; charset=utf-8' } },
      );
    }

    if (request.method === 'GET' && url.pathname === '/sitemap.xml') {
      // lastmod is static — update when the LP/story content materially changes.
      const xml = isRamen
        ? '<?xml version="1.0" encoding="UTF-8"?>\n' +
          '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
          '  <url>\n    <loc>https://ramen.gachi-tokusuru.com/</loc>\n    <lastmod>2026-07-10</lastmod>\n    <changefreq>monthly</changefreq>\n    <priority>1.0</priority>\n  </url>\n' +
          '  <url>\n    <loc>https://ramen.gachi-tokusuru.com/story</loc>\n    <lastmod>2026-07-10</lastmod>\n    <changefreq>monthly</changefreq>\n    <priority>0.8</priority>\n  </url>\n' +
          '</urlset>\n'
        : '<?xml version="1.0" encoding="UTF-8"?>\n' +
          '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
          '  <url><loc>https://api.gachi-tokusuru.com/</loc></url>\n' +
          '  <url><loc>https://api.gachi-tokusuru.com/docs</loc></url>\n' +
          '</urlset>\n';
      return new Response(xml, { headers: { 'content-type': 'application/xml; charset=utf-8' } });
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
      const isRamenPlan = PLAN_META[r.plan]?.product === 'ramen';
      const lim = PLAN_LIMITS[r.plan];
      const quota = lim === Infinity ? 'unlimited requests' : `${lim.toLocaleString('en-US')} requests/month`;
      const host = isRamenPlan ? 'https://ramen.gachi-tokusuru.com' : 'https://api.gachi-tokusuru.com';
      const restEx = isRamenPlan
        ? `curl "${host}/v1/shops?pref=Tokyo&limit=3" \\\n  -H "Authorization: Bearer ${r.key}"`
        : `curl "${host}/v1/station-toilets/search?station=Shinjuku" \\\n  -H "Authorization: Bearer ${r.key}"`;
      const mcpEx = isRamenPlan
        ? `{"mcpServers":{"japan-ramen":{"url":"${host}/mcp","headers":{"Authorization":"Bearer ${r.key}"}}}}`
        : `{"mcpServers":{"gachi-data":{"url":"${host}/mcp","headers":{"Authorization":"Bearer ${r.key}"}}}}`;
      return new Response(activatePage(
        `<h1>✅ You're on ${label}</h1>`
        + `<p>Thanks for subscribing. Here is your API key (${quota}, MCP + REST):</p>`
        + `<div class="key" id="apikey">${r.key}</div>`
        + '<p><button type="button" id="copybtn" onclick="copyKey()">Copy key</button></p>'
        + '<p><b>Save it now</b> — treat it like a password. <b>Bookmark this page (this exact URL).</b> '
        + 'Reloading it shows the same key again — even if you close the tab before copying'
        + (r.emailed ? ", and we've also emailed it to you as a backup." : '.') + '</p>'
        + `<script>function copyKey(){var k=document.getElementById('apikey').textContent.trim();var b=document.getElementById('copybtn');function done(){b.textContent='Copied!';setTimeout(function(){b.textContent='Copy key';},2000);}function fb(){try{var r=document.createRange();r.selectNode(document.getElementById('apikey'));var s=window.getSelection();s.removeAllRanges();s.addRange(r);document.execCommand('copy');done();}catch(e){b.textContent='Select the key and press Ctrl+C';}}if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(k).then(done).catch(fb);}else{fb();}}</script>`
        + '<p>First call:</p>'
        + `<pre style="background:#f6f8f7;border:1px solid #e3e8e6;border-radius:8px;padding:12px;overflow-x:auto;font-size:13px">${restEx}</pre>`
        + '<p>MCP client config:</p>'
        + `<pre style="background:#f6f8f7;border:1px solid #e3e8e6;border-radius:8px;padding:12px;overflow-x:auto;font-size:13px">${mcpEx}</pre>`
        + `<p class="mut">${isRamenPlan ? 'Full docs: <a href="https://ramen.gachi-tokusuru.com/story">the story</a>.' : 'Full API docs: <a href="/docs">/docs</a>.'} This key works for both MCP and REST${lim === Infinity ? '.' : ' (shared monthly quota).'}</p>`
        + `<p class="mut">Manage or cancel your subscription anytime: <a href="${PORTAL_URL}">billing portal</a>. Questions? contact@gachi-tokusuru.com</p>`,
      ), { headers: htmlHeaders });
    }

    // Self-serve key. Both hosts mint the standard Free key (nationwide, 1,000/month, REST + MCP).
    if (request.method === 'POST' && url.pathname === '/keys') {
      let b;
      try { b = await request.json(); } catch { return Response.json({ error: 'invalid json' }, { status: 400 }); }
      const email = (b?.email || '').trim();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        return Response.json({ error: 'valid email required' }, { status: 400 });
      }
      const rl = await mintRateLimit(env, request);
      if (!rl.ok) return Response.json({ error: 'rate_limited', message: 'Too many keys created from your network today. Try again tomorrow, or contact us for higher volume.' }, { status: 429, headers: { 'retry-after': '3600', ...CORS } });
      if (isRamen) {
        const token = await issueFreeKey(env, email, 'ramen');
        return Response.json({
          api_key: token, plan: 'free', monthly_limit: PLAN_LIMITS.free, coverage: 'nationwide (all 47 prefectures)',
          note: `Free key: nationwide, ${PLAN_LIMITS.free} requests/month, REST + MCP. Upgrade to Pro for unlimited volume, higher QPS and a commercial licence: ${RAMEN_UPGRADE_URL}`,
        }, { headers: CORS });
      }
      const token = await issueFreeKey(env, email, 'gachi');
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
      const interestId = await saveInterest(env, email, useCase);
      // Fire-and-forget operator notification; must not block or fail the form response.
      ctx.waitUntil(sendInterestNotification(env, { email, useCase, id: interestId }));
      return Response.json({ ok: true });
    }

    // MCP endpoint — non-POST surface. Streamable HTTP says a server that offers no SSE stream on
    // GET MUST answer 405, not 404: 404 is reserved for "session expired", which sends clients into
    // a re-initialize loop and reads as unreachable to registry health checks.
    if (url.pathname === '/mcp' && request.method !== 'POST') {
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: MCP_CORS });
      return new Response(null, { status: 405, headers: { allow: 'POST, OPTIONS', ...MCP_CORS } });
    }

    // MCP endpoint
    if (request.method === 'POST' && url.pathname === '/mcp') {
      let body;
      try { body = await request.json(); } catch {
        return Response.json(rpcError(null, -32700, 'parse error'), { status: 400, headers: MCP_CORS });
      }
      // Our own scripts (benchmark eval, reflect_crawl health gate, ...) hit this same production
      // endpoint on purpose — but must never count as external usage. They self-identify via this
      // header; matching requests are excluded from every stat:*/stats:* KPI bucket below and land in
      // a single internal counter instead, so usage_history.csv stays a clean external-only signal.
      const isInternal = request.headers.get('x-gachi-internal') === '1';
      // Introspection is open — no key needed — so any client or directory can discover the tools.
      // Both api.* and ramen.* are callable no-auth (public/factual data), IP rate-limited. Metering
      // applies ONLY when a key is presented. ramen.* no-auth gets reduced caps (see ramenNoauth).
      let ramenNoauth = false;
      if (body?.method === 'tools/call') {
        // Scope the surface by host, both ways: ramen.* exposes ONLY the ramen tools; api.* exposes
        // everything EXCEPT them. An out-of-scope tool is simply "unknown" here (rejected before auth).
        const _nm = body?.params?.name;
        // ping is a host-neutral health check exposed on BOTH surfaces; everything else stays scoped.
        if (_nm !== 'ping' && ((isRamen && !RAMEN_TOOL_NAMES.has(_nm)) || (!isRamen && RAMEN_TOOL_NAMES.has(_nm)))) {
          return Response.json(rpcError(body.id ?? null, -32602, `unknown tool: ${_nm}`), { status: 200, headers: CORS });
        }
        const auth = await resolveAuth(request, env);
        if (!auth.ok) {
          // No/invalid key on either host: rate-limit every no-auth call by IP (NOAUTH_LIMITER covers
          // ALL tools, not a subset), then serve with no metering. On ramen.* the no-auth path runs
          // with reduced caps (limit 20, radius 2,000 m, changes truncated) but all 47 prefectures —
          // the $500 Pro moat is REST/feed keys + the bulk-proof interface shape, not MCP access.
          const rl = await noauthCallLimit(env, request);
          if (!rl.ok) {
            return Response.json(
              rpcError(body.id ?? null, -32005, 'Rate limit exceeded (60 requests/minute per IP). Slow down, or get a free key for higher, metered limits: ' + UPGRADE_URL),
              { status: 429, headers: { 'retry-after': '60', ...CORS } },
            );
          }
          ramenNoauth = isRamen;
          if (ramenNoauth && !isInternal) bumpNoauthStat(env, ctx, 'mcp');
          // fall through to handleRpc — public/factual data, no metering.
        } else {
          // Per-key burst limit (QPS by plan). Even "unlimited" plans get a speed ceiling; the
          // monthly quota is unaffected — this only throttles the request RATE.
          const bl = await keyedBurstLimit(env, auth);
          if (!bl.ok) {
            return Response.json(
              rpcError(body.id ?? null, -32005, `Rate limit exceeded (${bl.rps} req/s on ${auth.plan}). Slow the request rate — your monthly quota is unaffected.`),
              { status: 429, headers: { 'retry-after': '1', ...CORS } },
            );
          }
          // Ramen product entitlement: a general Gachi Data API key must NEVER reach the ramen tools.
          // ping is exempt — it's a host-neutral health check, callable with any (or no) key.
          if (isRamen && _nm !== 'ping' && auth.product !== 'ramen' && auth.product !== 'all') {
            return Response.json(
              rpcError(body.id ?? null, -32004, 'This key is not valid for the Ramen API. Get a ramen key at https://ramen.gachi-tokusuru.com'),
              { status: 403, headers: CORS },
            );
          }
          // Context API tools honour the same Free 1-municipality/day preview gate as REST.
          const toolName = body?.params?.name;
          if (auth.plan === 'free' && (toolName === 'get_municipality_context' || toolName === 'get_station_context')) {
            const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
            const dk = `ctxday:${auth.token}:${day}`;
            const dused = parseInt((await env.TOILET_KV.get(dk)) || '0', 10);
            if (dused >= 1) {
              return Response.json(
                rpcError(body.id ?? null, -32003, `Context API preview is 1 municipality/day on Free — upgrade for unlimited: ${UPGRADE_URL}`),
                { status: 429, headers: { 'retry-after': '86400' } },
              );
            }
            await env.TOILET_KV.put(dk, String(dused + 1), { expirationTtl: 172800 });
          }
          const m = await meterUsageFor(env, auth);
          if (!m.allowed) {
            const msg = m.daily
              ? `daily limit reached (${m.used}/${m.limit} on ${auth.plan}), resets 00:00 UTC. Upgrade to Pro for unlimited: ${RAMEN_UPGRADE_URL}`
              : `monthly limit reached (${m.used}/${m.limit} on ${auth.plan}). Upgrade to Pro: ${UPGRADE_URL}`;
            return Response.json(
              rpcError(body.id ?? null, -32002, msg),
              { status: 429, headers: { 'retry-after': '3600' } },
            );
          }
        }
      }
      if (isInternal) {
        // Keep a single low-cardinality counter so an internal-traffic spike is still visible, without
        // touching any of the external-usage buckets (call/list, ref attribution, per-tool retention).
        bumpInternalStat(env, ctx, isRamen ? 'ramen' : 'api', body?.method);
      } else {
        // Usage measurement: count tools/call (real use) vs tools/list (introspection) per host.
        bumpMcpMethodStat(env, ctx, isRamen ? 'ramen' : 'api', body?.method);
        // Channel attribution: if the MCP URL carried ?ref=<tag>, count initialize + tools/call per host,
        // per ref tag. Observation only — never affects the response; no-ref requests are not counted.
        bumpRefStat(env, ctx, isRamen ? 'ramen' : 'api', url.searchParams.get('ref'), body?.method);
        // Retention measurement (ramen host only): per-tool + initialize, keyed by JST date.
        if (isRamen) bumpRamenToolStat(env, ctx, body?.method, body?.params?.name);
      }
      const result = await handleRpc(body, env, { ramenOnly: isRamen, ramenNoauth });
      if (result === null) return new Response(null, { status: 202, headers: MCP_CORS });
      return Response.json(result, { headers: MCP_CORS });
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
      summary: Same municipality context, resolved from a station (id or name)
      parameters:
        - { name: id, in: path, required: true, schema: { type: string }, description: "Station master station_id (e.g. st_00001) OR a station name (Shinjuku / 新宿)." }
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
<p>Machine-readable spec: <a href="/openapi.yaml">/openapi.yaml</a>. Get a free key at <a href="/">the homepage</a>. MCP and REST share one monthly quota per key.</p>

<h2 id="auth">Do I need a key? <span style="font-weight:400;font-size:14px;color:#666">(read this first)</span></h2>
<table style="border-collapse:collapse;width:100%;font-size:14px;margin:8px 0">
<tr style="border-bottom:2px solid #e3e8e6">
  <th style="text-align:left;padding:8px 8px;width:50%">✅ No key — try right now</th>
  <th style="text-align:left;padding:8px 8px;border-left:1px solid #e3e8e6">🔑 Free key required</th>
</tr>
<tr style="vertical-align:top">
  <td style="padding:8px 8px">Fixed live samples, no setup:<br>
    <code>GET /example</code><br>
    <code>GET /example/train-status</code><br>
    <code>GET /example/alerts</code><br>
    MCP <code>initialize</code> / <code>tools/list</code></td>
  <td style="padding:8px 8px;border-left:1px solid #e3e8e6">Every real query (any station / city):<br>
    all <code>/v1/*</code> — toilets · hazard · context · alerts · lines<br>
    MCP <code>tools/call</code><br>
    <span style="color:#666">1,000 req/mo free — instant key at the <a href="/">homepage</a></span></td>
</tr>
</table>
<pre># No key — canned sample, real JSON:
curl https://api.gachi-tokusuru.com/example

# Free key — query any station (get one at the homepage):
curl "https://api.gachi-tokusuru.com/v1/station-toilets/search?station=Shinjuku" \\
  -H "Authorization: Bearer YOUR_API_KEY"</pre>
<p style="font-size:14px;color:#666">Rule of thumb: <code>/example*</code> = no key (fixed samples) · <code>/v1/*</code> = free key (query anything). Auth header on keyed calls: <code>Authorization: Bearer &lt;key&gt;</code>. A missing/invalid key on a <code>/v1/*</code> route returns <code>401</code> with a link to get one.</p>

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
<p><b>Alert coverage: nationwide.</b> Station-matching is prefecture-level and works nationwide (any station's <code>pref</code>) — or query directly by prefecture / JMA area code.</p>
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


<h2 id="prior-art">Prior art &amp; why we're different</h2>
<p>We're not the first to open up Japanese railway and station data, and we stand on the shoulders of the people who tried before us. A few we learned from and respect:</p>
<ul>
<li><a href="https://github.com/adieuadieu/japan-train-data" target="_blank" rel="noopener">adieuadieu/japan-train-data</a> — a circular object of Japanese train data with station geocoding and <b>machine translations</b>. Great for a map; the auto-translated English names are exactly the kind of quality gap we set out to close with per-name provenance.</li>
<li><a href="https://github.com/piuccio/open-data-jp-railway-stations" target="_blank" rel="noopener">piuccio/open-data-jp-railway-stations</a> — a clean list built from ekidata with <b>manually generated</b> codes to bridge naming conventions. Careful work, but hand-maintained crosswalks are hard to keep current across 6 operators and 20 years of mergers.</li>
<li><a href="https://github.com/IvanReyesO7/tokyo-stations-API" target="_blank" rel="noopener">IvanReyesO7/tokyo-stations-API</a> — a focused API for stations inside Tokyo prefecture. A solid Tokyo slice; nationwide, cross-operator entity resolution is the part that doesn't scale by hand.</li>
</ul>
<p>Most of these have seen little maintenance since around 2017. That's not a knock — keeping this data current is genuinely hard, which is the whole reason this exists.</p>
<p><b>Don't take our word for it — check yourself:</b></p>
<ul>
<li><code>station_members.csv</code> — see Shinjuku collapse from 13 raw operator records into 1 resolved <code>station_id</code>.</li>
<li><code>low_confidence_review.csv</code> — the 51 candidate pairs we <b>did not</b> auto-merge, kept out for human review rather than guessed.</li>
<li><code>name_source</code> flag — every English name is tagged <code>odpt</code> / <code>wikidata</code> / <code>romanized</code>; ~7% are romanized, and we disclose it rather than hide it.</li>
<li><code>CHANGELOG</code> — every dataset revision, dated.</li>
</ul>
<p>All of the above live in the open dataset repo: <a href="https://github.com/eng213035/gachi-open-datasets" target="_blank" rel="noopener">github.com/eng213035/gachi-open-datasets</a>.</p>

<p><a href="/">← Back to home &amp; pricing</a></p>
</body></html>`;

const LLMS_TXT = `# Gachi Data API — Japan Station & Accessibility Data (API · MCP · Open Datasets)

> Deep, obscure Japanese data you won't find anywhere else — stations, accessibility,
> vacancy, hazards. Hand-verified, English-first, built for AI agents.
> Free tier; MCP + REST share one key.

## API access
- MCP endpoint: https://api.gachi-tokusuru.com/mcp (JSON-RPC; tools: get_municipality_context, get_station_context, get_toilet_by_station, get_public_toilet_by_city, get_station_hazard, station_search, get_active_alerts, get_station_alerts, get_train_status)
- REST GET /v1/station-toilets/search?station=Shinjuku  (station name English or Japanese)
- REST GET /v1/toilets/nearby?lat=&lng=&radius=&wheelchair=&ostomate=&diaper=  (radius metres, max 2000)
- REST GET /v1/stations/{station_id}/hazard  (official MLIT hazard categories at a station, relayed live; station_id e.g. st_00001)
- REST GET /v1/municipalities/{code}/context · /v1/stations/{station_id}/context  (Municipality Context API: vacancy 2003-2023 × nearest-station ridership × hazard × land price × livability, one call per municipality or station; official values only, no scores; Free 1 municipality/day)
- Realtime Layer (live) — service status for 94 Tokyo-area train lines (delays, suspensions, resumptions) + nationwide JMA river flood forecasts & landslide warnings, station-matched. Alert coverage: nationwide. Station-matching: prefecture-level, nationwide (any station's pref) — or query by prefecture / JMA area code.
  - REST GET /v1/alerts/active · /v1/alerts/area/{code} · /v1/stations/{station_id}/alerts  (JMA river flood forecasts (levels 2-5) & landslide alerts ONLY — not general weather warnings, not earthquakes; each response has a coverage array; relay of official facts, not a warning we issue)
  - REST GET /v1/lines/status · /v1/lines/{line_id}/status · /v1/stations/{station_id}/lines/status  (ODPT train service status; enum normal/delayed/suspended/resumed)
  - Every realtime response carries fetched_at (+ source_published_at for trains); stale data is flagged stale:true or 503, never returned silently.
  - Provenance: facts observed from public web ramen listings; records cross-checked against Japanese municipality open data (© 各自治体オープンデータ, CC BY); municipality via reverse geocoding © 国土地理院 (GSI); freshness/keito/payment/romanization layers are original © gachi-tokusuru.com. Joins to the Japan Station Master via station.id (st_xxxx).
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
- Kaggle: https://www.kaggle.com/datasets/gachidata/japan-stations-ridership-and-akiya-2003-2025

## License & attribution
- Accessible & public toilets: Tokyo Metropolitan Government (Bureau of Social Welfare) https://portal.data.metro.tokyo.lg.jp/ & BODIK municipal open data (CC BY 4.0) https://www.bodik.jp/
- Station names & train service status: ODPT (Public Transportation Open Data Center), CC BY 4.0 — https://developer.odpt.org/
- Hazard categories, future population, land price: MLIT 不動産情報ライブラリ (Real Estate Information Library), official values relayed as-is per request; not a government-created dataset — https://www.reinfolib.mlit.go.jp/
- River flood forecasts & landslide alerts: JMA (Japan Meteorological Agency, 気象庁), relayed as published, not warnings issued by this service — https://www.jma.go.jp/bosai/
- Housing vacancy & municipality codes: Statistics Bureau of Japan (住宅・土地統計調査) via e-Stat https://www.stat.go.jp/data/jyutaku/ , & MIC (総務省).
- Nationwide stations & bus stops: MLIT 国土数値情報 N02/P11 https://nlftp.mlit.go.jp/ksj/ ; English station names partly via Wikidata (CC0) https://www.wikidata.org/
- Derived by gachi-tokusuru.com (distinct from official values above): nearest_exit, nearest_station_km, and bus-stop counts are computed via spatial join. Accuracy/completeness not guaranteed.
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

<p><b>新宿駅 (Shinjuku) — accessible toilets</b> <span class="mut">(live, no key)</span></p>
<div style="overflow-x:auto">
<table>
<tr><th>Toilet</th><th>Line</th><th>Floor</th><th>Nearest exit</th><th>Dist.</th><th>Equipment</th></tr>
<tr><td>Accessible Toilet</td><td>Marunouchi Line</td><td>B1F</td><td>Exit A8</td><td>11 m</td><td>♿ · ostomate · <span title="baby-changing table">👶</span></td></tr>
<tr><td>Multifunction Toilet</td><td>Keio Line</td><td>B1F</td><td>Exit S01</td><td>12 m</td><td>♿ · ostomate</td></tr>
<tr><td>Multipurpose Toilet</td><td>Yamanote Line / Chuo Line</td><td>B1F</td><td>East Gate</td><td>29 m</td><td>♿ · ostomate · <span title="baby-changing table">👶</span></td></tr>
</table>
</div>
<p class="mut"><b>nearest exit distance is first-party data — found nowhere else.</b> &nbsp;(<span title="wheelchair-accessible">♿</span> wheelchair · 👶 baby-changing table)</p>

<p><b>武蔵小杉駅 (Musashi-Kosugi) — official hazard categories</b> <span class="mut">(live MLIT relay)</span></p>
<div style="overflow-x:auto">
<table>
<tr><th>Hazard</th><th>Category at this station</th></tr>
<tr><td>Flood inundation</td><td>0.5–3.0 m <span class="mut">(rivers: 多摩川 · 大栗川 · 浅川)</span></td></tr>
<tr><td>Liquefaction</td><td>Somewhat prone — backmarsh landform <span class="mut">(後背湿地)</span></td></tr>
<tr><td>Storm surge</td><td>Within inundation area</td></tr>
</table>
</div>
<p class="mut">Official MLIT categories, relayed as-is — no derived score. Not a substitute for official hazard maps.</p>

<p><a href="/example" target="_blank" rel="noopener"><b>▼ See the raw JSON — this exact response, live</b></a> — no key needed. <span class="mut">(hazard JSON needs a free key — see <a href="/docs#auth">/docs</a>)</span></p>
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
<p class="mut">Coverage varies by design: station master, hazard &amp; alerts are nationwide; accessibility is Tokyo-first (where ~70% of visitors go); ridership expands nationwide next (MLIT source already verified).</p>

<h2>What can you build?</h2>
<ul>
<li>A travel agent that answers "wheelchair route + nearest accessible toilet + is my line running?" — one key, three calls</li>
<li>An akiya-listing site that shows, per property town: vacancy trend, station ridership decline, flood category — official sources, cited</li>
<li>A research notebook on 20 years of urban shrinkage, from citable datasets (DOI) — no scraping, no cleaning</li>
</ul>
<p><b>Interpretation is your agent's job. Guaranteed official facts are ours.</b></p>

<h2>Why this exists</h2>
<p>Why does this exist? The raw data is free — and fragmented across 6 operators' IDs, 47 prefectures' formats, and 20 years of municipal mergers. We did the weeks of entity resolution so your agent doesn't have to. Previous attempts: abandoned since 2017 — <a href="/docs#prior-art">see the evidence →</a></p>

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
<tr>
  <td class="price">Enterprise</td><td>from $2,500/yr</td><td>Bulk exports</td>
  <td><i>Bulk data &amp; redistribution rights</i><br>Full dataset exports (Parquet/CSV): station master, ridership, accessibility &amp; housing vacancy · commercial redistribution license · annual data updates included · invoice billing · best-effort email support. <span class="mut">(Hazard is live-API only — upstream license restricts bulk redistribution.)</span><br>
  <a href="#bizform-anchor"><button type="button">Contact us</button></a></td>
</tr>
</table>
<p class="mut">Fair use = we contact you before throttling, never silently. Hard caps are the numbers you see — no hidden limits.</p>
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
    "gachi-data": {
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
<li><a href="${DATASETS.zenodo_url}" target="_blank" rel="noopener">Zenodo</a> — DOI <code>${DATASETS.zenodo_doi}</code> (citable archive: station master + ridership 2000–2025 + municipality housing vacancy 2003–2023)</li>
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
<p><b>Sources &amp; attribution</b> (all official / open data, redistributed under their terms):</p>
<ul class="mut" style="font-size:13px">
<li><a href="https://portal.data.metro.tokyo.lg.jp/" target="_blank" rel="noopener">Tokyo Metropolitan Government</a> (Bureau of Social Welfare) &amp; <a href="https://www.bodik.jp/" target="_blank" rel="noopener">BODIK</a> — accessible &amp; public toilets (CC BY 4.0)</li>
<li><a href="https://developer.odpt.org/" target="_blank" rel="noopener">ODPT</a> (Public Transportation Open Data Center) — station names &amp; train information</li>
<li><a href="https://www.reinfolib.mlit.go.jp/" target="_blank" rel="noopener">MLIT 不動産情報ライブラリ</a> (Real Estate Information Library) — hazard categories, population, land price</li>
<li><a href="https://www.jma.go.jp/bosai/" target="_blank" rel="noopener">JMA</a> (Japan Meteorological Agency) — flood forecasts &amp; landslide alerts</li>
<li><a href="https://www.stat.go.jp/data/jyutaku/" target="_blank" rel="noopener">Statistics Bureau of Japan</a> (住宅・土地統計調査) &amp; MIC (総務省) — housing vacancy &amp; municipality codes</li>
<li>MLIT <a href="https://nlftp.mlit.go.jp/ksj/" target="_blank" rel="noopener">国土数値情報 N02/P11</a> — nationwide stations &amp; bus stops; English names partly via <a href="https://www.wikidata.org/" target="_blank" rel="noopener">Wikidata</a> (CC0)</li>
</ul>
<p><code>nearest_exit</code> is an original derived value by gachi-tokusuru.com. Timeliness, accuracy and completeness are not guaranteed.</p>
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
