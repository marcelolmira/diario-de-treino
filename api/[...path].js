'use strict';
// Vercel: todas as rotas /api/* passam por aqui.
const { handleApi } = require('../lib/api');

module.exports = (req, res) => handleApi(req, res);
