// server.js — runnable entry point: creates the app and listens on
// PORT (env) or 3000.
'use strict';

// Load .env first so PORT and friends are visible below.
require('./env').loadEnvFile();

const { createApp } = require('./app');

const PORT = Number(process.env.PORT || 3000);

const { app } = createApp();

app.listen(PORT, () => {
  console.log(`Sai Jyothsna Caterers server listening on http://localhost:${PORT}`);
});
