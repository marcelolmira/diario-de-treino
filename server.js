'use strict';
// Servidor do Diário de Treino: entrega o app e guarda os registros no Postgres.
// Variáveis: DATABASE_URL (Postgres), APP_PIN (código de acesso), PORT.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

const PORT = process.env.PORT || 3000;
const PIN = process.env.APP_PIN || '';
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) { console.error('DATABASE_URL não definida.'); process.exit(1); }
if (!PIN) { console.error('APP_PIN não definida.'); process.exit(1); }

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: /sslmode=require/.test(DATABASE_URL) ? { rejectUnauthorized: false } : undefined,
  max: 5
});

async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS logs (
      ex_id      TEXT PRIMARY KEY,
      sessions   JSONB NOT NULL DEFAULT '[]'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    -- Cada gravação também entra aqui, para nada se perder por engano.
    CREATE TABLE IF NOT EXISTS logs_history (
      id         BIGSERIAL PRIMARY KEY,
      ex_id      TEXT NOT NULL,
      sessions   JSONB NOT NULL,
      saved_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS logs_history_ex ON logs_history (ex_id, saved_at DESC);
  `);
}

const EX_ID = /^[a-z]{3}-[1-9]$/;

function validSessions(s) {
  if (!Array.isArray(s) || s.length > 500) return false;
  return s.every(x => x && typeof x === 'object'
    && typeof x.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x.date)
    && (x.load === null || (typeof x.load === 'number' && x.load >= 0 && x.load < 10000))
    && Array.isArray(x.reps) && x.reps.length <= 10
    && x.reps.every(r => typeof r === 'number' && r >= 0 && r < 10000));
}

function pinOk(req) {
  const given = Buffer.from(String(req.headers['x-app-pin'] || ''));
  const want = Buffer.from(PIN);
  return given.length === want.length && crypto.timingSafeEqual(given, want);
}

// Freio simples contra tentativas de adivinhar o código.
const fails = new Map();
function tooMany(ip) {
  const f = fails.get(ip);
  return f && f.count >= 10 && Date.now() - f.first < 15 * 60 * 1000;
}
function noteFail(ip) {
  const f = fails.get(ip);
  if (!f || Date.now() - f.first > 15 * 60 * 1000) fails.set(ip, { count: 1, first: Date.now() });
  else f.count++;
}

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  res.writeHead(status, {
    'Content-Type': isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers
  });
  res.end(isJson ? JSON.stringify(body) : body);
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('too_large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { reject(new Error('bad_json')); } });
    req.on('error', reject);
  });
}

const INDEX = path.join(__dirname, 'public', 'index.html');

async function allLogs() {
  const { rows } = await pool.query('SELECT ex_id, sessions, updated_at FROM logs');
  const out = {};
  for (const r of rows) out[r.ex_id] = r.sessions;
  return out;
}

async function saveLog(client, id, sessions) {
  await client.query(
    `INSERT INTO logs (ex_id, sessions, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (ex_id) DO UPDATE SET sessions = EXCLUDED.sessions, updated_at = now()`,
    [id, JSON.stringify(sessions)]
  );
  await client.query('INSERT INTO logs_history (ex_id, sessions) VALUES ($1, $2)', [id, JSON.stringify(sessions)]);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      const html = fs.readFileSync(INDEX);
      return send(res, 200, html, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    }
    if (req.method === 'GET' && url.pathname === '/health') {
      await pool.query('SELECT 1');
      return send(res, 200, { ok: true });
    }

    if (url.pathname.startsWith('/api/')) {
      if (tooMany(ip)) return send(res, 429, { error: 'Muitas tentativas. Aguarde 15 minutos.' });
      if (!pinOk(req)) { noteFail(ip); return send(res, 401, { error: 'Código de acesso incorreto.' }); }

      if (req.method === 'GET' && url.pathname === '/api/logs') {
        return send(res, 200, { logs: await allLogs() });
      }

      const m = url.pathname.match(/^\/api\/logs\/([a-z]{3}-[1-9])$/);
      if (m && req.method === 'PUT') {
        const body = await readBody(req);
        if (!validSessions(body.sessions)) return send(res, 400, { error: 'Registro inválido.' });
        const client = await pool.connect();
        try { await client.query('BEGIN'); await saveLog(client, m[1], body.sessions); await client.query('COMMIT'); }
        catch (e) { await client.query('ROLLBACK'); throw e; }
        finally { client.release(); }
        return send(res, 200, { ok: true });
      }

      if (req.method === 'GET' && url.pathname === '/api/export') {
        const data = { app: 'diario-de-treino', exportedAt: new Date().toISOString(), logs: await allLogs() };
        return send(res, 200, data, { 'Content-Disposition': 'attachment; filename="diario-de-treino-' + new Date().toISOString().slice(0, 10) + '.json"' });
      }

      if (req.method === 'POST' && url.pathname === '/api/import') {
        const body = await readBody(req, 5 * 1024 * 1024);
        const logs = body && body.logs;
        if (!logs || typeof logs !== 'object') return send(res, 400, { error: 'Arquivo de backup inválido.' });
        const entries = Object.entries(logs);
        if (!entries.every(([id, s]) => EX_ID.test(id) && validSessions(s))) return send(res, 400, { error: 'Arquivo de backup inválido.' });
        const client = await pool.connect();
        try { await client.query('BEGIN'); for (const [id, s] of entries) await saveLog(client, id, s); await client.query('COMMIT'); }
        catch (e) { await client.query('ROLLBACK'); throw e; }
        finally { client.release(); }
        return send(res, 200, { ok: true, imported: entries.length });
      }

      return send(res, 404, { error: 'Não encontrado.' });
    }

    return send(res, 404, 'Não encontrado.');
  } catch (err) {
    console.error(err);
    if (err.message === 'too_large') return send(res, 413, { error: 'Envio grande demais.' });
    if (err.message === 'bad_json') return send(res, 400, { error: 'Dados inválidos.' });
    return send(res, 500, { error: 'Erro no servidor. Tente de novo.' });
  }
});

migrate()
  .then(() => server.listen(PORT, () => console.log('Diário de Treino na porta ' + PORT)))
  .catch(err => { console.error('Falha ao preparar o banco:', err); process.exit(1); });
