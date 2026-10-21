'use strict';
// Servidor para rodar localmente ou em hospedagem com processo contínuo (ex.: Railway).
// Na Vercel não é usado: lá o app sai de public/ e a API de api/[...path].js.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { handleApi, migrate } = require('../lib/api');

const PORT = process.env.PORT || 3000;
const INDEX = path.join(__dirname, '..', 'public', 'index.html');

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) return handleApi(req, res);
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    return res.end(fs.readFileSync(INDEX));
  }
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Não encontrado.');
});

migrate()
  .then(() => server.listen(PORT, () => console.log('Diário de Treino na porta ' + PORT)))
  .catch(err => { console.error('Falha ao preparar o banco:', err); process.exit(1); });
