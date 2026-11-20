// uploads.js — admin-uploaded item images.
//
// Storage location:
//   * Local / VPS: <project>/public/uploads/ (persistent, as before).
//   * Vercel (VERCEL=1): <os.tmpdir()>/sjc-uploads/ — only /tmp is writable
//     on serverless, and it is ephemeral per instance, so uploaded images
//     reset with the instance (documented demo limitation; seeded dishes
//     use remote Unsplash URLs and are unaffected).
//
// Images are served through GET /api/uploads/:name (mounted in app.js),
// never through express.static, so the route works identically in both
// environments. Filenames are sanitised strictly: only the multer-generated
// `<uuid>.<ext>` shape is served, path traversal is rejected, and the
// content type is set from a small allowlist.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const lib = require('./lib');

const CONTENT_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp'
};

// Multer generates `<randomUUID>.<ext>`; accept only that shape.
const SAFE_FILENAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function getUploadsDir() {
  if (process.env.VERCEL === '1') {
    return path.join(os.tmpdir(), 'sjc-uploads');
  }
  return path.join(__dirname, '..', 'public', 'uploads');
}

function ensureUploadsDir() {
  const dir = getUploadsDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** True for URLs pointing at a locally uploaded image (new or legacy path). */
function isLocalUploadUrl(url) {
  return (
    typeof url === 'string' &&
    (url.startsWith('/api/uploads/') || url.startsWith('/uploads/'))
  );
}

/** Best-effort delete of a locally uploaded image, given its stored URL. */
function deleteLocalUpload(url) {
  if (!isLocalUploadUrl(url)) return;
  try {
    fs.unlinkSync(path.join(getUploadsDir(), path.basename(url)));
  } catch { /* file already gone */ }
}

function serveUpload(req, res) {
  const name = req.params.name;
  if (!name || !SAFE_FILENAME_RE.test(name) || name.includes('..')) {
    return lib.fail(res, 400, 'VALIDATION_ERROR', 'Invalid file name');
  }
  const ext = path.extname(name).toLowerCase();
  const contentType = CONTENT_TYPES[ext];
  if (!contentType) {
    return lib.fail(res, 404, 'NOT_FOUND', 'Not found');
  }
  const uploadsDir = getUploadsDir();
  const resolved = path.resolve(uploadsDir, name);
  if (!resolved.startsWith(uploadsDir + path.sep)) {
    return lib.fail(res, 400, 'VALIDATION_ERROR', 'Invalid file name');
  }
  return res.sendFile(resolved, {
    headers: {
      'Content-Type': contentType,
      'Content-Disposition': 'inline',
      'Cache-Control': 'public, max-age=86400'
    }
  }, (err) => {
    if (err && !res.headersSent) {
      lib.fail(res, 404, 'NOT_FOUND', 'Not found');
    }
  });
}

module.exports = { getUploadsDir, ensureUploadsDir, isLocalUploadUrl, deleteLocalUpload, serveUpload };
