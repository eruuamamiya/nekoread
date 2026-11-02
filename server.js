// Butuh Node.js 18+ (fetch bawaan)
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 6767;
// Alamat Shinigami REST API (tanpa /api di belakang)
const API_BASE = (process.env.API_BASE || 'https://apiread.pedeblue.my.id').replace(/\/+$/, '');
const enc = encodeURIComponent;

// ---------- Helper ----------
function send(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

async function upstream(p) {
  const r = await fetch(API_BASE + p, { signal: AbortSignal.timeout(20000) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* bukan JSON */ }
  if (!r.ok) {
    const err = new Error((json && (json.message || json.error)) || `API membalas ${r.status}`);
    err.status = r.status;
    throw err;
  }
  return json;
}

function readBody(req, limit = 10000) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > limit) { reject(new Error('body terlalu besar')); req.destroy(); }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const pick = (o, keys) => {
  if (!o || typeof o !== 'object') return undefined;
  for (const k of keys) {
    const v = o[k];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
};

function findArray(v, depth = 0) {
  if (Array.isArray(v)) return v;
  if (!v || typeof v !== 'object' || depth > 3) return [];
  for (const k of ['data', 'mangas', 'results', 'items', 'manga', 'list', 'chapters', 'pages', 'images']) {
    if (k in v) {
      const a = findArray(v[k], depth + 1);
      if (a.length) return a;
    }
  }
  for (const val of Object.values(v)) if (Array.isArray(val) && val.length) return val;
  for (const val of Object.values(v)) {
    if (val && typeof val === 'object') {
      const a = findArray(val, depth + 1);
      if (a.length) return a;
    }
  }
  return [];
}

// Semua gambar dilewatkan lewat image proxy milik API
const imgUrl = (u) => (u ? `/api/image?url=${enc(u)}` : '');

function fmtChapter(v) {
  if (v === undefined || v === null || v === '') return '';
  if (typeof v === 'object') v = pick(v, ['chapter_number', 'number', 'chapter', 'title']);
  if (v === undefined) return '';
  return /^[\d.]+$/.test(String(v)) ? `Chapter ${v}` : String(v);
}

function fmtDate(v) {
  if (!v) return '';
  const d = new Date(v);
  return isNaN(d) ? String(v) : d.toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' });
}

// ---------- Normalisasi ----------
function normItem(m) {
  return {
    param: String(pick(m, ['manga_id', 'mangaId', 'id', 'slug', '_id', 'url']) ?? ''),
    title: pick(m, ['title', 'name', 'manga_title']) || 'Tanpa judul',
    description: pick(m, ['description', 'synopsis']) || '',
    latest_chapter: fmtChapter(pick(m, ['latest_chapter_number', 'latest_chapter', 'last_chapter', 'lastChapter', 'chapter'])),
    // thumbnail: pakai URL asli dari API, tanpa proxy
    thumbnail: pick(m, ['thumbnail', 'cover_portrait_url', 'cover_image_url', 'cover', 'image', 'poster', 'thumb']) || '',
  };
}

function normList(json, page) {
  const data = findArray(json).map(normItem).filter((x) => x.param);
  const flag = pick(json && json.data, ['hasNextPage']) ?? pick(json, ['hasNextPage']);
  return { page: Number(page) || 1, hasNext: flag === undefined ? data.length > 0 : !!flag, data };
}

function normDetail(json) {
  const d0 = json && json.data && typeof json.data === 'object' && !Array.isArray(json.data) ? json.data : json;
  const d = d0 && d0.manga && typeof d0.manga === 'object' ? d0.manga : d0;
  const rawGenres = pick(d, ['genres', 'genre']) || (d && d.taxonomy && d.taxonomy.Genre) || [];
  const genre = (Array.isArray(rawGenres) ? rawGenres : [])
    .map((g) => (typeof g === 'string' ? g : pick(g, ['name', 'title', 'label'])))
    .filter(Boolean);
  const status = pick(d, ['status']);
  return {
    data: {
      param: String(pick(d, ['manga_id', 'mangaId', 'id', 'slug', '_id', 'url']) ?? ''),
      title: pick(d, ['title', 'name']) || '',
      thumbnail: pick(d, ['thumbnail', 'cover_portrait_url', 'cover_image_url', 'cover', 'image', 'poster']) || '',
      genre,
      synopsis: pick(d, ['description', 'synopsis']) || '',
      status: typeof status === 'string' ? status : '',
    },
  };
}

function normChapters(json) {
  const rows = findArray(json).map((c) => {
    const num = pick(c, ['chapter_number', 'number', 'chapter']);
    const title = pick(c, ['chapter_title', 'title', 'name']);
    let label = num !== undefined ? `Chapter ${num}` : title || 'Chapter';
    if (num !== undefined && title && String(title) !== String(num) && !/^chapter/i.test(title)) label += ` - ${title}`;
    return {
      param: String(pick(c, ['chapter_id', 'chapterId', 'id', '_id', 'slug', 'url']) ?? ''),
      chapter: label,
      release: fmtDate(pick(c, ['release_date', 'created_at', 'updated_at', 'date', 'release'])),
      _n: parseFloat(num),
    };
  }).filter((c) => c.param);
  // urutkan terbaru -> terlama kalau semua punya nomor
  if (rows.length && rows.every((c) => !isNaN(c._n))) rows.sort((a, b) => b._n - a._n);
  return { data: rows.map(({ _n, ...c }) => c) };
}

function normPages(json) {
  const d = json && json.data && typeof json.data === 'object' ? json.data : json;
  let arr = Array.isArray(d) ? d : [];
  if (!arr.length && d && d.chapter && Array.isArray(d.chapter.data)) arr = d.chapter.data;
  if (!arr.length) arr = findArray(json);
  // urutkan berdasarkan "index" kalau ada, lalu pakai URL gambar asli dari API (tanpa proxy)
  if (arr.every((i) => i && typeof i === 'object' && typeof i.index === 'number')) {
    arr = [...arr].sort((a, b) => a.index - b.index);
  }
  const pages = arr
    .map((i) => (typeof i === 'string' ? i : pick(i, ['imageUrl', 'image_url', 'url', 'image', 'src', 'img', 'page_url'])))
    .filter(Boolean);
  return { data: pages };
}

// ---------- Server ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  const qp = (k, d = '') => url.searchParams.get(k) || d;

  try {
    if (p === '/api/list') {
      const type = qp('type') === 'latest' ? 'latest' : 'popular';
      const page = qp('page', '1');
      return send(res, 200, normList(await upstream(`/api/manga/${type}?page=${enc(page)}`), page));
    }
    if (p === '/api/search') {
      const page = qp('page', '1');
      return send(res, 200, normList(await upstream(`/api/manga/search?q=${enc(qp('q'))}&page=${enc(page)}`), page));
    }
    if (p.startsWith('/api/detail/')) {
      const id = decodeURIComponent(p.slice('/api/detail/'.length));
      return send(res, 200, normDetail(await upstream(`/api/manga/${enc(id)}`)));
    }
    if (p.startsWith('/api/chapters/')) {
      const id = decodeURIComponent(p.slice('/api/chapters/'.length));
      return send(res, 200, normChapters(await upstream(`/api/manga/${enc(id)}/chapters`)));
    }
    if (p.startsWith('/api/pages/')) {
      const id = decodeURIComponent(p.slice('/api/pages/'.length));
      return send(res, 200, normPages(await upstream(`/api/manga/chapter/${enc(id)}/pages`)));
    }
    if (p === '/api/image') {
      const u = qp('url');
      if (!u) return send(res, 400, { error: 'url kosong' });
      const grab = async (target, headers = {}) => {
        const r = await fetch(target, { headers, signal: AbortSignal.timeout(30000) });
        const type = r.headers.get('content-type') || '';
        if (!r.ok || !(type.startsWith('image/') || type.startsWith('application/octet-stream'))) return null;
        return { buf: Buffer.from(await r.arrayBuffer()), type: type.startsWith('image/') ? type : 'image/jpeg' };
      };
      let img = null;
      // 1) lewat image proxy milik API
      try { img = await grab(`${API_BASE}/api/manga/image?url=${enc(u)}`); } catch { /* lanjut */ }
      // 2) langsung ke sumber gambar
      if (!img && /^https?:\/\//i.test(u)) {
        try { img = await grab(u, { Referer: 'https://app.shinigami.asia/', 'User-Agent': 'Mozilla/5.0' }); } catch { /* lanjut */ }
      }
      // 3) terakhir: biar browser yang ambil langsung
      if (!img) {
        if (!/^https?:\/\//i.test(u)) { res.writeHead(404); return res.end(); }
        res.writeHead(302, { Location: u });
        return res.end();
      }
      res.writeHead(200, { 'Content-Type': img.type, 'Cache-Control': 'public, max-age=86400' });
      return res.end(img.buf);
    }
    // Debug: lihat respons asli API, contoh /api/raw?path=/api/manga/popular?page=1
    if (p === '/api/raw') {
      const target = qp('path');
      if (!target.startsWith('/api/')) return send(res, 400, { error: 'path harus diawali /api/' });
      return send(res, 200, await upstream(target));
    }

    // Tukar kode OAuth2 Discord -> access_token (untuk Rich Presence di Activity)
    // Butuh env DISCORD_CLIENT_SECRET (client id dikirim dari /discord.js, atau env DISCORD_CLIENT_ID)
    if (p === '/api/token' && req.method === 'POST') {
      let body = {};
      try { body = JSON.parse(await readBody(req)); } catch { /* body kosong / bukan JSON */ }
      if (!body.code) return send(res, 400, { error: 'code kosong' });
      const clientId = String(body.client_id || process.env.DISCORD_CLIENT_ID || '');
      const secret = process.env.DISCORD_CLIENT_SECRET || '';
      if (!clientId || !secret) return send(res, 500, { error: 'DISCORD_CLIENT_SECRET belum di-set di server' });
      const r = await fetch('https://discord.com/api/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: clientId, client_secret: secret, grant_type: 'authorization_code', code: String(body.code) }),
        signal: AbortSignal.timeout(15000),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.access_token) return send(res, 400, { error: 'Tukar token gagal', detail: j.error_description || j.error || r.status });
      return send(res, 200, { access_token: j.access_token });
    }

    if (p === '/discord.js') {
      return fs.readFile(path.join(__dirname, 'discord.js'), (err, js) => {
        if (err) { res.writeHead(404); return res.end('discord.js belum di-build'); }
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
        res.end(js);
      });
    }

    if (p === '/' || p === '/index.html') {
      return fs.readFile(path.join(__dirname, 'index.html'), (err, html) => {
        if (err) { res.writeHead(500); return res.end('Gagal memuat index.html'); }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      });
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 - Halaman tidak ditemukan');
  } catch (e) {
    send(res, e.status || 502, { error: 'Gagal menghubungi API', detail: String(e.message || e) });
  }
});

server.listen(PORT, () => {
  console.log(`Web jalan di http://localhost:${PORT}`);
  console.log(`API sumber: ${API_BASE}`);
});
