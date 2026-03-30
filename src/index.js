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
//  AUTO-PING — garde Render éveillé toutes les 14 min
// ============================================================
const RENDER_URL = process.env.RENDER_URL || null;
if (RENDER_URL) {
  setInterval(async () => {
    try {
      await fetch(`${RENDER_URL}/ping`);
      console.log('[PING] Keep-alive sent');
    } catch (e) {
      console.log('[PING] Failed:', e.message);
    }
  }, 14 * 60 * 1000);
}
app.get('/ping', (req, res) => res.json({ status: 'alive' }));

// ============================================================
//  DÉTECTION QUALITÉ
// ============================================================
function qualityScore(name) {
  if (/4K|UHD/i.test(name))  return 5;
  if (/FHD|1080/i.test(name)) return 4;
  if (/HD/i.test(name))       return 3;
  if (/SD/i.test(name))       return 2;
  if (/RAW/i.test(name))      return 1;
  return 1;
}

// ============================================================
//  SUPPRESSION DES DOUBLONS — garde la meilleure qualité
// ============================================================
function dedup(channels) {
  const map = new Map();
  for (const ch of channels) {
    // Clé = nom normalisé sans qualité
    const key = ch.name
      .replace(/\b(4K|UHD|FHD|HD|SD|RAW|1080|720|\d+P)\b/gi, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
    const existing = map.get(key);
    if (!existing || qualityScore(ch.name) > qualityScore(existing.name)) {
      map.set(key, ch);
    }
  }
  return Array.from(map.values());
}

// ============================================================
//  DÉTECTION DU SPORT
// ============================================================
function detectSport(name) {
  if (/foot|football|soccer|ligue|champions|premier league|liga|serie a|bundesliga/i.test(name)) return '⚽ Football';
  if (/tennis/i.test(name))                     return '🎾 Tennis';
  if (/f1|formula|moto|nascar|rally|racing/i.test(name)) return '🏎️ Motorsport';
  if (/basket|nba|euroleague/i.test(name))      return '🏀 Basket';
  if (/rugby/i.test(name))                      return '🏉 Rugby';
  if (/box|boxing|ufc|combat|mma/i.test(name))  return '🥊 Combat';
  if (/golf/i.test(name))                       return '⛳ Golf';
  if (/handball/i.test(name))                   return '🤾 Handball';
  if (/volley/i.test(name))                     return '🏐 Volleyball';
  if (/cycl|velo|tour de france/i.test(name))   return '🚴 Cyclisme';
  if (/ski|snow|winter/i.test(name))            return '⛷️ Sports Hiver';
  return '🏆 Multi-Sport';
}

function isFrSport(ch) {
  const frKw    = /^FR[:\s|_]/i;
  const sportKw = /sport|foot|football|soccer|bein|eurosport|ligue|champions|nba|tennis|rugby|moto|f1|formula|boxing|ufc|combat|basket|handball|canal\+|eleven/i;
  return frKw.test(ch.name) && sportKw.test(ch.name);
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
        id:    `xc_${ch.stream_id}`,
        name:  ch.name,
        logo:  ch.stream_icon || '',
        group: ch.category_name || 'General',
        url:   `${HOST}/live/${USER}/${PASS}/${ch.stream_id}.m3u8`,
      }));
      console.log(`[SYNC] Xtream API: ${channels.length} channels (avant dedup)`);
    }
  } catch (e) {
    console.log('[SYNC] Xtream failed, trying M3U...');
  }

  if (channels.length === 0) {
    try {
      const res  = await fetch(M3U_URL, { timeout: 15000 });
      const text = await res.text();
      channels   = parseM3U(text);
    } catch (e) {
      console.error('[SYNC] M3U failed:', e.message);
    }
  }

  channels = dedup(channels);
  console.log(`[SYNC] ${channels.length} channels après dedup`);
  cache = { channels, lastFetch: Date.now() };
  return channels;
}

function parseM3U(text) {
  const lines = text.split('\n');
  const out   = [];
  let cur     = null;
  for (const line of lines) {
    const l = line.trim();
    if (l.startsWith('#EXTINF')) {
      const name  = (l.match(/,(.+)$/)               || [])[1]?.trim() || '';
      const logo  = (l.match(/tvg-logo="([^"]+)"/)   || [])[1] || '';
      const group = (l.match(/group-title="([^"]+)"/) || [])[1] || 'General';
      const id    = (l.match(/tvg-id="([^"]+)"/)     || [])[1] || `ch_${out.length}`;
      cur = { id: id.replace(/[^a-zA-Z0-9]/g, '_'), name, logo, group };
    } else if (l.startsWith('http') && cur) {
      cur.url = l;
      out.push(cur);
      cur = null;
    }
  }
  return out;
}

// ============================================================
//  MANIFEST
// ============================================================
const SPORTS = [
  '⚽ Football','🎾 Tennis','🏎️ Motorsport','🏀 Basket',
  '🏉 Rugby','🥊 Combat','⛳ Golf','🤾 Handball',
  '🏐 Volleyball','🚴 Cyclisme','⛷️ Sports Hiver','🏆 Multi-Sport'
];

app.get('/manifest.json', (req, res) => res.json({
  id:          'com.frenchtv.sport.stremio',
  version:     '1.1.0',
  name:        '🏆 FRENCH-TV Sport',
  description: 'Canal+, BeIN Sports, Eurosport FR — auto-sync, sans doublons',
  types:       ['tv'],
  catalogs: [{
    type:  'tv', id: 'frenchtv-sport', name: '🏆 Sport FR',
    extra: [
      { name: 'genre',  isRequired: false, options: SPORTS },
      { name: 'search', isRequired: false },
    ]
  }],
  resources:  ['catalog', 'meta', 'stream'],
  idPrefixes: ['frtv_'],
}));

// ============================================================
//  CATALOG
// ============================================================
app.get('/catalog/tv/frenchtv-sport.json', async (req, res) => {
  const all    = await getChannels();
  const sports = all.filter(isFrSport);
  const genre  = req.query.genre;
  const filtered = genre ? sports.filter(ch => detectSport(ch.name) === genre) : sports;
  console.log(`[CATALOG] ${filtered.length} chaînes${genre ? ` (${genre})` : ''}`);
  res.json({ metas: filtered.map(ch => ({
    id:          `frtv_${ch.id}`,
    type:        'tv',
    name:        ch.name,
    poster:      ch.logo || `https://placehold.co/300x300/0a0a1a/white?text=${encodeURIComponent(ch.name)}`,
    posterShape: 'square',
    genres:      [detectSport(ch.name)],
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
    genres: [detectSport(ch.name)],
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
  console.log(`\n✅ FRENCH-TV Sport Addon v1.1`);
  console.log(`📡 http://localhost:${PORT}/manifest.json\n`);
  if (RENDER_URL) console.log(`🔄 Auto-ping actif → ${RENDER_URL}`);
});