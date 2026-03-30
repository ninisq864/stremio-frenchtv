const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors());

const HOST = 'https://iptv.vdfr.co.uk';
const USER = 'proxy_user';
const PASS = 'proxy_password';

const API_URL   = `${HOST}/player_api.php?username=${USER}&password=${PASS}`;
const M3U_URL   = `${HOST}/get.php?username=${USER}&password=${PASS}&type=m3u_plus`;
const CACHE_TTL = 5 * 60 * 1000;

let cache = { channels: [], lastFetch: 0 };

// ============================================================
//  AUTO-PING Render
// ============================================================
const RENDER_URL = process.env.RENDER_URL || null;
if (RENDER_URL) {
  setInterval(async () => {
    try { await fetch(`${RENDER_URL}/ping`); console.log('[PING] alive'); }
    catch (e) { console.log('[PING] failed:', e.message); }
  }, 14 * 60 * 1000);
}
app.get('/ping', (req, res) => res.json({ status: 'alive' }));

// ============================================================
//  GROUPES — organisation par chaîne/compétition
// ============================================================
const GROUPS = [
  { id: 'canalplus',  label: '📺 Canal+',     match: /canal\+|canal plus/i },
  { id: 'bein',       label: '🟡 BeIN Sports', match: /bein/i },
  { id: 'ligue1',     label: '⚽ Ligue 1',     match: /ligue\s*1|ligue1/i },
  { id: 'ligue2',     label: '⚽ Ligue 2',     match: /ligue\s*2|ligue2/i },
  { id: 'champions',  label: '🏆 Champions League', match: /champions|ucl/i },
  { id: 'eurosport',  label: '🎯 Eurosport',   match: /eurosport/i },
  { id: 'eleven',     label: '🎬 Eleven Sports', match: /eleven/i },
  { id: 'rmcsport',   label: '📡 RMC Sport',   match: /rmc\s*sport/i },
  { id: 'lequipe',    label: '🏃 L\'Équipe',   match: /l.equipe|lequipe/i },
  { id: 'autres',     label: '🏅 Autres Sport FR', match: null },
];

function getGroup(name) {
  for (const g of GROUPS) {
    if (g.match && g.match.test(name)) return g;
  }
  return GROUPS[GROUPS.length - 1]; // Autres
}

// ============================================================
//  FILTRE — uniquement sport FR
// ============================================================
const SPORT_KW = /sport|foot|football|soccer|bein|eurosport|ligue|champions|nba|tennis|rugby|moto|f1|formula|boxing|ufc|combat|basket|handball|canal\+|eleven|rmc|l.equipe|racing|atletico|cycling|golf|volley|padel/i;
const FR_KW    = /^FR[:\s|_]/i;
const BLACKLIST = /news|info|cinema|film|serie|documentaire|jeunesse|musique|comedie|adult|xxx|entertainment|discovery|national\s*geo|history|style|cuisine|voyage|tmc|tf1|france\s*[2345]|m6|w9|arte|c8|tfx|nrj|cherie|gulli|6ter|ab[12]/i;

function isFrSport(ch) {
  if (!FR_KW.test(ch.name)) return false;
  if (BLACKLIST.test(ch.name)) return false;
  if (!SPORT_KW.test(ch.name)) return false;
  return true;
}

// ============================================================
//  QUALITÉ & DEDUP
// ============================================================
function qualityScore(name) {
  if (/4K|UHD/i.test(name))   return 5;
  if (/FHD|1080/i.test(name)) return 4;
  if (/\bHD\b/i.test(name))   return 3;
  if (/\bSD\b/i.test(name))   return 2;
  return 1;
}

function dedup(channels) {
  const map = new Map();
  for (const ch of channels) {
    const key = ch.name
      .replace(/\b(4K|UHD|FHD|HD|SD|RAW|1080|720|\d+P)\b/gi, '')
      .replace(/\s+/g, ' ').trim().toLowerCase();
    const ex = map.get(key);
    if (!ex || qualityScore(ch.name) > qualityScore(ex.name)) map.set(key, ch);
  }
  return Array.from(map.values());
}

// ============================================================
//  FETCH CHANNELS
// ============================================================
async function getChannels() {
  const now = Date.now();
  if (now - cache.lastFetch < CACHE_TTL && cache.channels.length > 0) return cache.channels;

  console.log('[SYNC] Fetching channels...');
  let channels = [];

  try {
    const res  = await fetch(`${API_URL}&action=get_live_streams`, { timeout: 10000 });
    const data = await res.json();
    if (Array.isArray(data) && data.length > 0) {
      channels = data.map(ch => ({
        id:   `xc_${ch.stream_id}`,
        name: ch.name,
        logo: ch.stream_icon || '',
        url:  `${HOST}/live/${USER}/${PASS}/${ch.stream_id}.m3u8`,
      }));
    }
  } catch (e) {
    try {
      const res  = await fetch(M3U_URL, { timeout: 15000 });
      const text = await res.text();
      channels   = parseM3U(text);
    } catch (e2) { console.error('[SYNC] failed:', e2.message); }
  }

  const filtered = dedup(channels.filter(isFrSport));
  console.log(`[SYNC] ${channels.length} total → ${filtered.length} sport FR après dedup`);
  cache = { channels: filtered, lastFetch: Date.now() };
  return filtered;
}

function parseM3U(text) {
  const lines = text.split('\n'), out = [];
  let cur = null;
  for (const line of lines) {
    const l = line.trim();
    if (l.startsWith('#EXTINF')) {
      const name  = (l.match(/,(.+)$/)               || [])[1]?.trim() || '';
      const logo  = (l.match(/tvg-logo="([^"]+)"/)   || [])[1] || '';
      const id    = (l.match(/tvg-id="([^"]+)"/)     || [])[1] || `ch_${out.length}`;
      cur = { id: id.replace(/[^a-zA-Z0-9]/g, '_'), name, logo };
    } else if (l.startsWith('http') && cur) {
      cur.url = l; out.push(cur); cur = null;
    }
  }
  return out;
}

// ============================================================
//  MANIFEST
// ============================================================
const GROUP_LABELS = GROUPS.map(g => g.label);

app.get('/manifest.json', (req, res) => res.json({
  id:          'com.frenchtv.sport.stremio',
  version:     '2.0.0',
  name:        '📺 FRENCH-TV Sport',
  description: 'Canal+, BeIN, Ligue 1, Eurosport... 100% FR, auto-sync',
  types:       ['tv'],
  catalogs: [{
    type:  'tv', id: 'frenchtv-sport', name: '📺 Sport FR',
    extra: [
      { name: 'genre',  isRequired: false, options: GROUP_LABELS },
      { name: 'search', isRequired: false },
    ]
  }],
  resources:  ['catalog', 'meta', 'stream'],
  idPrefixes: ['frtv_'],
  logo: 'https://i.imgur.com/your-logo.png',
}));

// ============================================================
//  CATALOG
// ============================================================
app.get('/catalog/tv/frenchtv-sport.json', async (req, res) => {
  const all   = await getChannels();
  const genre = req.query.genre;
  const filtered = genre
    ? all.filter(ch => getGroup(ch.name).label === genre)
    : all;
  console.log(`[CATALOG] ${filtered.length} chaînes${genre ? ` (${genre})` : ''}`);
  res.json({ metas: filtered.map(ch => ({
    id:          `frtv_${ch.id}`,
    type:        'tv',
    name:        ch.name,
    poster:      ch.logo || `https://placehold.co/300x300/0a0a1a/white?text=${encodeURIComponent(ch.name)}`,
    posterShape: 'square',
    genres:      [getGroup(ch.name).label],
  }))});
});

// ============================================================
//  META
// ============================================================
app.get('/meta/tv/:id.json', async (req, res) => {
  const all   = await getChannels();
  const rawId = req.params.id.replace('frtv_', '');
  const ch    = all.find(c => c.id === rawId);
  if (!ch) return res.json({ meta: null });
  res.json({ meta: {
    id: `frtv_${ch.id}`, type: 'tv', name: ch.name,
    poster: ch.logo, posterShape: 'square',
    genres: [getGroup(ch.name).label],
  }});
});

// ============================================================
//  STREAM
// ============================================================
app.get('/stream/tv/:id.json', async (req, res) => {
  const all   = await getChannels();
  const rawId = req.params.id.replace('frtv_', '');
  const ch    = all.find(c => c.id === rawId);
  if (!ch?.url) return res.json({ streams: [] });
  res.json({ streams: [{
    url:   ch.url,
    title: `📡 ${ch.name}`,
    name:  'FRENCH-TV',
    behaviorHints: { notWebReady: false },
  }]});
});

const PORT = process.env.PORT || 7000;
app.listen(PORT, () => {
  console.log(`\n✅ FRENCH-TV Sport v2.0`);
  console.log(`📡 http://localhost:${PORT}/manifest.json\n`);
  if (RENDER_URL) console.log(`🔄 Auto-ping → ${RENDER_URL}`);
});