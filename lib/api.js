'use strict';
// Rotas da API do Diário de Treino. Usado pela Vercel (api/[...path].js)
// e pelo servidor local/Railway (bin/server.js).
// Variáveis: DATABASE_URL (Postgres), APP_PIN (código de acesso).

const crypto = require('crypto');
const { Pool } = require('pg');

let pool = null;
let ready = null;

function getPool() {
  if (pool) return pool;
  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!url) throw new Error('missing_db');
  pool = new Pool({
    connectionString: url,
    ssl: /sslmode=require|neon\.tech/.test(url) ? { rejectUnauthorized: false } : undefined,
    max: 3
  });
  return pool;
}

function migrate() {
  if (!ready) {
    ready = getPool().query(`
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
    `).catch(err => { ready = null; throw err; });
  }
  return ready;
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
  const pin = process.env.APP_PIN || '';
  if (!pin) return false;
  const given = Buffer.from(String(req.headers['x-app-pin'] || ''));
  const want = Buffer.from(pin);
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
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers
  });
  res.end(JSON.stringify(body));
}

function readBody(req, limit = 1024 * 1024) {
  // Na Vercel o corpo pode já vir lido em req.body.
  if ('body' in req && req.body !== undefined) {
    const b = req.body;
    if (typeof b === 'string') { try { return Promise.resolve(JSON.parse(b || '{}')); } catch (_) { return Promise.reject(new Error('bad_json')); } }
    if (Buffer.isBuffer(b)) { try { return Promise.resolve(JSON.parse(b.toString('utf8') || '{}')); } catch (_) { return Promise.reject(new Error('bad_json')); } }
    return Promise.resolve(b || {});
  }
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('too_large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { reject(new Error('bad_json')); } });
    req.on('error', reject);
  });
}

async function allLogs() {
  const { rows } = await getPool().query('SELECT ex_id, sessions FROM logs');
  const out = {};
  for (const r of rows) out[r.ex_id] = r.sessions;
  return out;
}

async function saveMany(entries) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    for (const [id, sessions] of entries) {
      const json = JSON.stringify(sessions);
      await client.query(
        `INSERT INTO logs (ex_id, sessions, updated_at) VALUES ($1, $2, now())
         ON CONFLICT (ex_id) DO UPDATE SET sessions = EXCLUDED.sessions, updated_at = now()`,
        [id, json]
      );
      await client.query('INSERT INTO logs_history (ex_id, sessions) VALUES ($1, $2)', [id, json]);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function handleApi(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname.replace(/\/+$/, '');
  const ip = String(req.headers['x-forwarded-for'] || (req.socket && req.socket.remoteAddress) || '').split(',')[0].trim();

  try {
    if (req.method === 'GET' && p === '/api/health') {
      await migrate(); await getPool().query('SELECT 1');
      return send(res, 200, { ok: true, pin: Boolean(process.env.APP_PIN) });
    }

    if (!process.env.APP_PIN) return send(res, 503, { error: 'Defina a variável APP_PIN no servidor.' });
    if (tooMany(ip)) return send(res, 429, { error: 'Muitas tentativas. Aguarde 15 minutos.' });
    if (!pinOk(req)) { noteFail(ip); return send(res, 401, { error: 'Código de acesso incorreto.' }); }

    await migrate();

    if (req.method === 'GET' && p === '/api/logs') {
      return send(res, 200, { logs: await allLogs() });
    }

    const m = p.match(/^\/api\/logs\/([a-z]{3}-[1-9])$/);
    if (m && req.method === 'PUT') {
      const body = await readBody(req);
      if (!validSessions(body.sessions)) return send(res, 400, { error: 'Registro inválido.' });
      await saveMany([[m[1], body.sessions]]);
      return send(res, 200, { ok: true });
    }

    if (req.method === 'GET' && p === '/api/export') {
      const data = { app: 'diario-de-treino', exportedAt: new Date().toISOString(), logs: await allLogs() };
      return send(res, 200, data, { 'Content-Disposition': 'attachment; filename="diario-de-treino-' + new Date().toISOString().slice(0, 10) + '.json"' });
    }

    if (req.method === 'POST' && p === '/api/import') {
      const body = await readBody(req, 5 * 1024 * 1024);
      const logs = body && body.logs;
      if (!logs || typeof logs !== 'object') return send(res, 400, { error: 'Arquivo de backup inválido.' });
      const entries = Object.entries(logs);
      if (!entries.every(([id, s]) => EX_ID.test(id) && validSessions(s))) return send(res, 400, { error: 'Arquivo de backup inválido.' });
      await saveMany(entries);
      return send(res, 200, { ok: true, imported: entries.length });
    }

    return send(res, 404, { error: 'Não encontrado.' });
  } catch (err) {
    console.error(err);
    if (err.message === 'too_large') return send(res, 413, { error: 'Envio grande demais.' });
    if (err.message === 'bad_json') return send(res, 400, { error: 'Dados inválidos.' });
    if (err.message === 'missing_db') return send(res, 503, { error: 'Banco de dados não configurado (DATABASE_URL).' });
    return send(res, 500, { error: 'Erro no servidor. Tente de novo.' });
  }
}

module.exports = { handleApi, migrate };
