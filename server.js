'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

const PORT = 3210;
const HOST = '127.0.0.1';
const ROOT = __dirname;

// ==================== IN-MEMORY CACHE ====================
const cache = new Map(); // key = contact_key, value = contact object

function contactKey(item) {
  return item.id || item.org_url || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function ingestBatch(body) {
  const items = Array.isArray(body?.items) ? body.items : [];
  let accepted = 0;
  let updated = 0;

  for (const raw of items) {
    const key = contactKey(raw);
    const existing = cache.get(key);
    const contact = {
      contact_key: key,
      id: raw.id || '',
      org_url: raw.org_url || '',
      name: raw.name || '',
      description: raw.description || '',
      address: raw.address || '',
      phone: raw.phone || '',
      website: raw.website || '',
      telegram: raw.telegram || '',
      whatsapp: raw.whatsapp || '',
      vk: raw.vk || '',
      max: raw.max || '',
      logo: raw.logo || '',
      photos: raw.photos || '',
      saved_at: raw.saved_at || new Date().toISOString(),
      source: raw.source || '',
      created_at: existing?.created_at || new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    if (existing) {
      updated++;
    } else {
      accepted++;
    }
    cache.set(key, contact);
  }

  return {
    ok: true,
    accepted,
    updated,
    total: cache.size,
    source: body?.source || 'unknown',
  };
}

function queryContacts(searchParams) {
  const pageSize = Math.min(10000, Math.max(1, parseInt(searchParams.get('pageSize') || '500', 10)));
  const q = (searchParams.get('q') || '').toLowerCase().trim();

  let items = [...cache.values()];

  if (q) {
    items = items.filter(c =>
      (c.name || '').toLowerCase().includes(q) ||
      (c.phone || '').includes(q) ||
      (c.address || '').toLowerCase().includes(q) ||
      (c.description || '').toLowerCase().includes(q)
    );
  }

  items.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));

  const total = items.length;
  const itemsPage = items.slice(0, pageSize);

  return {
    items: itemsPage,
    total,
    pageSize,
    globalStats: {
      totalContacts: total,
      withPhone: items.filter(c => c.phone && c.phone !== '-').length,
      totalCities: new Set(items.map(c => (c.address || '').split(',')[0].trim()).filter(Boolean)).size,
    },
  };
}

function clearAll() {
  const count = cache.size;
  cache.clear();
  return { ok: true, deleted: count };
}

function deleteById(id) {
  if (cache.has(id)) {
    cache.delete(id);
    return { ok: true, deleted: 1 };
  }
  return { ok: false, deleted: 0, error: 'Not found' };
}

function deleteByIds(ids) {
  let deleted = 0;
  for (const id of ids) {
    if (cache.has(id)) {
      cache.delete(id);
      deleted++;
    }
  }
  return { ok: true, deleted };
}

// ==================== HTTP SERVER ====================
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    ...CORS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

async function readBody(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 8_000_000) throw new Error('Too large');
  }
  return JSON.parse(raw || '{}');
}

const server = http.createServer(async (req, res) => {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${req.method} ${req.url}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return;
  }

  try {
    const url = new URL(req.url, `http://${HOST}:${PORT}`);

    // POST /api/batch — принять контакты
    if (req.method === 'POST' && url.pathname === '/api/batch') {
      const body = await readBody(req);
      sendJson(res, 200, ingestBatch(body));
      return;
    }

    // GET /api/contacts — получить контакты
    if (req.method === 'GET' && url.pathname === '/api/contacts') {
      sendJson(res, 200, queryContacts(url.searchParams));
      return;
    }

    // DELETE /api/contacts — очистить все
    if (req.method === 'DELETE' && url.pathname === '/api/contacts') {
      sendJson(res, 200, clearAll());
      return;
    }

    // DELETE /api/contacts/batch — удалить выбранные (массив ID в body)
    if (req.method === 'DELETE' && url.pathname === '/api/contacts/batch') {
      const body = await readBody(req);
      const ids = Array.isArray(body?.ids) ? body.ids : [];
      sendJson(res, 200, deleteByIds(ids));
      return;
    }

    // DELETE /api/contacts/:id — удалить один
    if (req.method === 'DELETE' && url.pathname.startsWith('/api/contacts/')) {
      const id = url.pathname.split('/api/contacts/')[1];
      sendJson(res, 200, deleteById(id));
      return;
    }

    // GET /api/health
    if (req.method === 'GET' && url.pathname === '/api/health') {
      sendJson(res, 200, { ok: true, total: cache.size });
      return;
    }

    // Static files
    if (req.method === 'GET') {
      const safePath = url.pathname === '/' ? '/dashboard.html' : url.pathname;
      const normalized = path.normalize(safePath).replace(/^([.][.][/\\])+/, '');
      const fullPath = path.join(ROOT, normalized);

      if (fullPath.startsWith(ROOT) && fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
        const ext = path.extname(fullPath).toLowerCase();
        const mime = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.ico': 'image/x-icon' }[ext] || 'application/octet-stream';
        const content = fs.readFileSync(fullPath);
        res.writeHead(200, { ...CORS, 'Content-Type': mime, 'Content-Length': content.length });
        res.end(content);
        return;
      }
    }

    sendJson(res, 404, { error: 'Not found' });
  } catch (err) {
    console.error('Error:', err.message);
    sendJson(res, 500, { error: err.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`🚀 Cache server running at http://${HOST}:${PORT}`);
  console.log(`   POST   /api/batch          — receive contacts`);
  console.log(`   GET    /api/contacts        — list contacts`);
  console.log(`   DELETE /api/contacts        — clear all`);
  console.log(`   DELETE /api/contacts/batch  — delete selected`);
  console.log(`   DELETE /api/contacts/:id    — delete one`);
});
