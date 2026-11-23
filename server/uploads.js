// uploads.js — admin-uploaded item images, stored as BLOBs in the database.
//
// Uploaded images live in the `uploads` table (id, filename, mime, data,
// created_at) in EVERY environment, so they persist wherever the database
// persists — including Turso on Vercel. There is no disk-based upload path
// any more: the old <project>/public/uploads/ and /tmp/sjc-uploads/
// directories are unused (files left in them from an earlier version are
// simply ignored; seeded dishes use remote Unsplash URLs and are
// unaffected).
//
// Images are served through GET /api/uploads/:name (mounted in app.js),
// never through express.static. Filenames are sanitised strictly: only
// the multer-generated `<uuid>.<ext>` shape is served, path traversal is
// rejected, and the content type comes from a small allowlist.
'use strict';

const path = require('path');
const lib = require('./lib');
const { nowIso } = require('./db');

const CONTENT_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp'
};

// Multer generates `<randomUUID>.<ext>`; accept only that shape.
const SAFE_FILENAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** True for URLs pointing at an uploaded image (new or legacy path). */
function isLocalUploadUrl(url) {
  return (
    typeof url === 'string' &&
    (url.startsWith('/api/uploads/') || url.startsWith('/uploads/'))
  );
}

/** The stored filename for an upload URL (basename, traversal-safe). */
function filenameFromUrl(url) {
  if (!isLocalUploadUrl(url)) return null;
  const name = path.basename(url);
  return SAFE_FILENAME_RE.test(name) && !name.includes('..') ? name : null;
}

/**
 * Store an uploaded image buffer in the database.
 * @returns {Promise<string>} the public URL (/api/uploads/<filename>)
 */
async function saveUpload(db, { filename, mime, buffer }) {
  await db.prepare(
    'INSERT OR REPLACE INTO uploads (id, filename, mime, data, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(filename, filename, mime, buffer, nowIso());
  return `/api/uploads/${filename}`;
}

/** Best-effort delete of an uploaded image, given its stored URL. */
async function deleteLocalUpload(db, url) {
  const name = filenameFromUrl(url);
  if (!name) return;
  try {
    await db.prepare('DELETE FROM uploads WHERE id = ?').run(name);
  } catch { /* row already gone */ }
}

async function serveUpload(db, req, res) {
  const name = req.params.name;
  if (!name || !SAFE_FILENAME_RE.test(name) || name.includes('..')) {
    return lib.fail(res, 400, 'VALIDATION_ERROR', 'Invalid file name');
  }
  const ext = path.extname(name).toLowerCase();
  const contentType = CONTENT_TYPES[ext];
  if (!contentType) {
    return lib.fail(res, 404, 'NOT_FOUND', 'Not found');
  }
  try {
    const row = await db.prepare('SELECT mime, data FROM uploads WHERE id = ?').get(name);
    if (!row) {
      return lib.fail(res, 404, 'NOT_FOUND', 'Not found');
    }
    // libsql returns BLOB values as ArrayBuffer; convert to a Buffer.
    const data = Buffer.isBuffer(row.data) ? row.data : Buffer.from(row.data);
    res.setHeader('Content-Type', row.mime || contentType);
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Content-Length', data.length);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.send(data);
  } catch (err) {
    console.error('serveUpload failed:', err);
    return lib.fail(res, 500, 'INTERNAL_ERROR', 'Something went wrong');
  }
}

module.exports = { isLocalUploadUrl, filenameFromUrl, saveUpload, deleteLocalUpload, serveUpload };
