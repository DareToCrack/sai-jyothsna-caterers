// env.js — tiny dependency-free `.env` loader (no dotenv dependency).
//
// Loads `<project>/.env` into process.env when the file exists. Rules:
//   * `KEY=value` lines only; `#` comments and blank lines are skipped.
//   * Surrounding single/double quotes are stripped from values.
//   * Variables already set in the real environment are never overridden.
//   * A missing `.env` file is fine — the app runs on defaults + real env.
// Required first by server.js, seed.js and reset-admin.js (the CLI entries).
'use strict';

const fs = require('fs');
const path = require('path');

function loadEnvFile() {
  const envPath = path.join(__dirname, '..', '.env');
  let text;
  try {
    text = fs.readFileSync(envPath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return false;
    throw err;
  }
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key && !(key in process.env)) process.env[key] = value;
  }
  return true;
}

module.exports = { loadEnvFile };
