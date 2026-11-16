import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Busboy from 'busboy';
import QRCode from 'qrcode';
import { scrubMediaMetadata } from './metadata-scrubber.mjs';
import { encryptMedia, decryptMedia, isEncryptedBuffer } from './crypto.mjs';
import { sendNotification, getDefaultStorageDir } from './platform.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');

/**
 * Checks if incoming request is strictly from localhost
 */
export function isLocalhost(req) {
  const ip = req.socket.remoteAddress || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

/**
 * Formats bytes to readable string
 */
function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

/**
 * Sanitizes file extension
 */
function getExtension(filename, mimeType) {
  const ext = path.extname(filename).toLowerCase();
  if (ext) return ext;
  if (mimeType.includes('jpeg') || mimeType.includes('jpg')) return '.jpg';
  if (mimeType.includes('png')) return '.png';
  if (mimeType.includes('webp')) return '.webp';
  if (mimeType.includes('gif')) return '.gif';
  if (mimeType.includes('mp4')) return '.mp4';
  if (mimeType.includes('quicktime') || mimeType.includes('mov')) return '.mov';
  return '.bin';
}

/**
 * Serves a static file with anti-caching privacy headers
 */
function serveStaticFile(res, filePath, contentType) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('File not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-store, no-cache, must-revalidate, private',
      'Pragma': 'no-cache',
      'Expires': '0',
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(data);
  });
}

/**
 * Creates and starts the VelvetVault HTTP server
 */
export async function createVaultServer({
  durationMinutes = 15,
  storageDir = null,
  masterPassword = '',
  publicUrl = '',
  localUrl = '',
  onUpload = null,
  onExpire = null,
  port = 4040
} = {}) {
  const targetDir = storageDir || getDefaultStorageDir();
  await fsp.mkdir(targetDir, { recursive: true, mode: 0o700 });

  const durationMs = durationMinutes * 60 * 1000;
  const now = Date.now();
  const expiresAt = now + durationMs;
  const token = randomBytes(24).toString('base64url');

  const defaultDir = getDefaultStorageDir();
  const isCustomDir = path.resolve(targetDir) !== path.resolve(defaultDir);
  const dateStr = new Date(now).toISOString().replace(/T/, '_').replace(/:/g, '-').slice(0, 19);
  const sessionId = isCustomDir ? 'custom' : `${dateStr}_${randomBytes(4).toString('hex')}`;
  const sessionDir = isCustomDir ? targetDir : path.join(targetDir, sessionId);
  await fsp.mkdir(sessionDir, { recursive: true, mode: 0o700 });

  const session = {
    token,
    sessionId,
    createdAt: now,
    expiresAt,
    durationMs,
    totalFiles: 0,
    active: true,
    closedEarly: false,
    storageDir: targetDir,
    sessionDir,
    masterPassword,
    hasEncryption: Boolean(masterPassword),
    publicUrl,
    localUrl,
    items: []
  };

  const sseClients = new Set();

  function broadcastSSE(event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of sseClients) {
      try {
        client.write(payload);
      } catch (_) {
        sseClients.delete(client);
      }
    }
  }

  // Periodic countdown tick
  const tickInterval = setInterval(() => {
    const remaining = Math.max(0, Math.floor((session.expiresAt - Date.now()) / 1000));
    if (session.active && remaining <= 0) {
      session.active = false;
      broadcastSSE('session-expired', { reason: 'time_up' });
      clearInterval(tickInterval);
      if (typeof onExpire === 'function') {
        onExpire('time_up');
      }
    } else if (session.active) {
      broadcastSSE('tick', { remainingSeconds: remaining, totalFiles: session.totalFiles });
    }
  }, 1000);

  const server = http.createServer(async (req, res) => {
    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = parsedUrl.pathname;
    const reqToken = parsedUrl.searchParams.get('token') || req.headers['x-vault-token'];
    const fromLocalhost = isLocalhost(req);

    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('Clear-Site-Data', '"cache"');

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, DELETE, HEAD',
        'Access-Control-Allow-Headers': 'Content-Type, x-vault-token, x-vault-password'
      });
      res.end();
      return;
    }

    // 1. Static assets
    if (pathname.startsWith('/public/')) {
      const safePath = path.normalize(path.join(PUBLIC_DIR, pathname.replace(/^\/public\//, '')));
      if (!safePath.startsWith(PUBLIC_DIR)) {
        res.writeHead(403);
        return res.end('Forbidden');
      }
      let cType = 'text/plain';
      if (safePath.endsWith('.js')) cType = 'application/javascript';
      else if (safePath.endsWith('.css')) cType = 'text/css';
      else if (safePath.endsWith('.svg')) cType = 'image/svg+xml';
      else if (safePath.endsWith('.png')) cType = 'image/png';
      return serveStaticFile(res, safePath, cType);
    }

    // 2. Main Entry: GET or HEAD /
    if (pathname === '/' && (req.method === 'GET' || req.method === 'HEAD')) {
      if (fromLocalhost && !reqToken) {
        return serveStaticFile(res, path.join(PUBLIC_DIR, 'portal.html'), 'text/html');
      }

      const remainingSeconds = Math.max(0, Math.floor((session.expiresAt - Date.now()) / 1000));
      const isValid = session.active && remainingSeconds > 0 && reqToken === session.token;

      if (!isValid) {
        res.writeHead(403, { 'Content-Type': 'text/html' });
        return res.end(`
          <!DOCTYPE html>
          <html lang="en">
          <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Vault Locked</title>
            <style>
              body { background: #090a0f; color: #e2e8f0; font-family: system-ui, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; padding: 16px; text-align: center; }
              .card { background: #14161f; border: 1px solid rgba(255,255,255,0.08); border-radius: 24px; padding: 40px 24px; max-width: 380px; box-shadow: 0 20px 40px rgba(0,0,0,0.6); }
              .icon { font-size: 48px; margin-bottom: 16px; }
              h1 { font-size: 20px; font-weight: 600; margin: 0 0 8px; color: #f43f5e; }
              p { font-size: 14px; color: #94a3b8; line-height: 1.5; margin: 0; }
            </style>
          </head>
          <body>
            <div class="card">
              <div class="icon">🔒</div>
              <h1>Vault is Locked</h1>
              <p>This upload session has expired or is invalid. The connection was closed for privacy.</p>
            </div>
          </body>
          </html>
        `);
      }

      return serveStaticFile(res, path.join(PUBLIC_DIR, 'index.html'), 'text/html');
    }

    // 3. Localhost Host Control Portal
    if ((pathname === '/portal' || pathname === '/view' || pathname === '/admin') && (req.method === 'GET' || req.method === 'HEAD')) {
      if (!fromLocalhost) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        return res.end('Access denied: Localhost only');
      }
      return serveStaticFile(res, path.join(PUBLIC_DIR, 'portal.html'), 'text/html');
    }

    // 4. API: Session info
    if (pathname === '/api/session' && req.method === 'GET') {
      const remainingSeconds = Math.max(0, Math.floor((session.expiresAt - Date.now()) / 1000));
      const isValid = session.active && remainingSeconds > 0 && reqToken === session.token;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        valid: isValid,
        active: session.active,
        remainingSeconds,
        totalFiles: session.totalFiles,
        expiresAt: session.expiresAt
      }));
    }

    // 5. API: Server-Sent Events (SSE)
    if (pathname === '/api/events' && req.method === 'GET') {
      if (reqToken !== session.token && !fromLocalhost) {
        res.writeHead(403);
        return res.end('Invalid token');
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*'
      });
      res.write(':\n\n');
      sseClients.add(res);
      req.on('close', () => { sseClients.delete(res); });
      return;
    }

    // 6. API: Upload media
    if (pathname === '/api/upload' && req.method === 'POST') {
      const remainingSeconds = Math.max(0, Math.floor((session.expiresAt - Date.now()) / 1000));
      if (!session.active || remainingSeconds <= 0 || reqToken !== session.token) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Session expired or invalid token' }));
      }

      const busboy = Busboy({
        headers: req.headers,
        limits: { fileSize: 100 * 1024 * 1024, files: 30 }
      });

      const uploadedFiles = [];
      let note = '';
      const filePromises = [];

      busboy.on('field', (name, val) => {
        if (name === 'note') note = val.slice(0, 500);
      });

      busboy.on('file', (name, fileStream, info) => {
        const { filename, mimeType } = info;
        const fileExt = getExtension(filename, mimeType);
        const uniqueId = `${Date.now()}_${randomUUID().slice(0, 6)}`;
        const saveName = `${uniqueId}${fileExt}${session.hasEncryption ? '.enc' : ''}`;
        const savePath = path.join(sessionDir, saveName);

        const chunks = [];
        const filePromise = new Promise((resolve, reject) => {
          fileStream.on('data', (d) => chunks.push(d));
          fileStream.on('end', async () => {
            try {
              const rawBuffer = Buffer.concat(chunks);
              // Scrub EXIF GPS / location metadata
              const scrubbedBuffer = scrubMediaMetadata(rawBuffer, mimeType);

              // Encrypt if masterPassword is set
              const { buffer: finalBuffer, isEncrypted } = encryptMedia(scrubbedBuffer, session.masterPassword);

              await fsp.writeFile(savePath, finalBuffer, { mode: 0o600 });

              const fileInfo = {
                id: uniqueId,
                filename: saveName,
                originalName: filename,
                size: rawBuffer.length,
                storedSize: finalBuffer.length,
                mimeType,
                isEncrypted,
                time: new Date().toISOString()
              };

              let metaContent = JSON.stringify({ ...fileInfo, note }, null, 2);
              if (session.hasEncryption) {
                const encMeta = encryptMedia(Buffer.from(metaContent), session.masterPassword);
                await fsp.writeFile(`${savePath}.meta.enc`, encMeta.buffer, { mode: 0o600 });
              } else {
                await fsp.writeFile(`${savePath}.meta.json`, metaContent, { mode: 0o600 });
              }

              uploadedFiles.push(fileInfo);
              session.totalFiles += 1;
              session.items.push({ ...fileInfo, note });

              // Send system notification + vibration (Android & Linux)
              sendNotification(
                'VelvetVault Photo Received! 📸',
                `${filename} (${formatBytes(rawBuffer.length)})${note ? `\n"${note}"` : ''}`
              );

              if (typeof onUpload === 'function') {
                onUpload({
                  filename: saveName,
                  originalName: filename,
                  size: rawBuffer.length,
                  note,
                  path: savePath,
                  isEncrypted
                });
              }

              resolve();
            } catch (err) {
              reject(err);
            }
          });
          fileStream.on('error', reject);
        });

        filePromises.push(filePromise);
      });

      busboy.on('finish', async () => {
        try {
          await Promise.all(filePromises);
          broadcastSSE('upload-received', { count: uploadedFiles.length, total: session.totalFiles });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, count: uploadedFiles.length, total: session.totalFiles }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });

      busboy.on('error', (err) => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      });

      req.pipe(busboy);
      return;
    }

    // 7. API: Lock Vault early
    if (pathname === '/api/lock' && req.method === 'POST') {
      if (reqToken !== session.token && !fromLocalhost) {
        res.writeHead(403);
        return res.end('Invalid token');
      }
      session.active = false;
      session.closedEarly = true;
      broadcastSSE('session-locked', { reason: 'locked_by_user' });
      clearInterval(tickInterval);
      if (typeof onExpire === 'function') {
        onExpire('locked_by_user');
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: true, message: 'Vault sealed' }));
    }

    // 8. API: Localhost Portal Info
    if (pathname === '/api/admin/portal-info' && req.method === 'GET') {
      if (!fromLocalhost) {
        res.writeHead(403);
        return res.end('Localhost only');
      }

      const remainingSeconds = Math.max(0, Math.floor((session.expiresAt - Date.now()) / 1000));
      const publicLink = session.publicUrl ? `${session.publicUrl}/?token=${session.token}` : '';
      const localLink = session.localUrl ? `${session.localUrl}/?token=${session.token}` : '';

      let qrDataUrl = '';
      if (publicLink) {
        try {
          qrDataUrl = await QRCode.toDataURL(publicLink, { margin: 1, width: 280, color: { dark: '#000000', light: '#ffffff' } });
        } catch (_) {}
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        active: session.active,
        remainingSeconds,
        totalFiles: session.totalFiles,
        publicLink,
        localLink,
        storageDir: session.storageDir,
        sessionDir: session.sessionDir,
        hasEncryption: session.hasEncryption,
        masterPassword: session.masterPassword,
        qrDataUrl
      }));
    }

    // 9. API: Localhost List Sessions & Photos
    if (pathname === '/api/admin/sessions' && req.method === 'GET') {
      if (!fromLocalhost) {
        res.writeHead(403);
        return res.end('Localhost only');
      }

      const reqPassword = req.headers['x-vault-password'] || parsedUrl.searchParams.get('password') || session.masterPassword;

      try {
        const sessionsData = [];
        const isCustom = isCustomDir;

        if (isCustom) {
          // Read directly from target folder
          const files = await fsp.readdir(sessionDir);
          const mediaFiles = files.filter(f => !f.endsWith('.meta.json') && !f.endsWith('.meta.enc'));
          const items = [];

          for (const mFile of mediaFiles) {
            const mPath = path.join(sessionDir, mFile);
            const mStat = await fsp.stat(mPath);
            const isEnc = mFile.endsWith('.enc');
            let meta = { note: '', originalName: mFile, mimeType: 'image/jpeg' };

            if (isEnc) {
              try {
                const encMetaBuffer = await fsp.readFile(`${mPath}.meta.enc`);
                const decMeta = decryptMedia(encMetaBuffer, reqPassword);
                meta = JSON.parse(decMeta.toString('utf8'));
              } catch (_) {}
            } else {
              try {
                const rawMeta = await fsp.readFile(`${mPath}.meta.json`, 'utf8');
                meta = JSON.parse(rawMeta);
              } catch (_) {}
            }

            items.push({
              filename: mFile,
              size: mStat.size,
              formattedSize: formatBytes(mStat.size),
              time: mStat.mtime.toISOString(),
              note: meta.note || '',
              originalName: meta.originalName || mFile,
              mimeType: meta.mimeType || 'image/jpeg',
              isEncrypted: isEnc
            });
          }

          sessionsData.push({
            id: 'current',
            time: new Date().toISOString(),
            isCurrent: true,
            files: items
          });
        } else {
          // Multi-session folders
          const sessionFolders = await fsp.readdir(targetDir);
          for (const sFolder of sessionFolders.sort().reverse()) {
            const sPath = path.join(targetDir, sFolder);
            const stat = await fsp.stat(sPath);
            if (!stat.isDirectory()) continue;

            const files = await fsp.readdir(sPath);
            const mediaFiles = files.filter(f => !f.endsWith('.meta.json') && !f.endsWith('.meta.enc'));
            const items = [];

            for (const mFile of mediaFiles) {
              const mPath = path.join(sPath, mFile);
              const mStat = await fsp.stat(mPath);
              const isEnc = mFile.endsWith('.enc');
              let meta = { note: '', originalName: mFile, mimeType: 'image/jpeg' };

              if (isEnc) {
                try {
                  const encMetaBuffer = await fsp.readFile(`${mPath}.meta.enc`);
                  const decMeta = decryptMedia(encMetaBuffer, reqPassword);
                  meta = JSON.parse(decMeta.toString('utf8'));
                } catch (_) {}
              } else {
                try {
                  const rawMeta = await fsp.readFile(`${mPath}.meta.json`, 'utf8');
                  meta = JSON.parse(rawMeta);
                } catch (_) {}
              }

              items.push({
                filename: mFile,
                size: mStat.size,
                formattedSize: formatBytes(mStat.size),
                time: mStat.mtime.toISOString(),
                note: meta.note || '',
                originalName: meta.originalName || mFile,
                mimeType: meta.mimeType || 'image/jpeg',
                isEncrypted: isEnc
              });
            }

            sessionsData.push({
              id: sFolder,
              time: stat.mtime.toISOString(),
              isCurrent: sFolder === session.sessionId,
              files: items
            });
          }
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ sessions: sessionsData, hasEncryption: session.hasEncryption }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // 10. API: Localhost Media Stream
    if (pathname.startsWith('/api/admin/media/') && req.method === 'GET') {
      if (!fromLocalhost) {
        res.writeHead(403);
        return res.end('Localhost only');
      }

      const parts = pathname.replace('/api/admin/media/', '').split('/');
      if (parts.length < 2) {
        res.writeHead(400);
        return res.end('Invalid path');
      }

      const [sId, mFile] = parts;
      const safePath = sId === 'current'
        ? path.normalize(path.join(sessionDir, mFile))
        : path.normalize(path.join(targetDir, sId, mFile));

      try {
        const fileBuffer = await fsp.readFile(safePath);
        const reqPassword = req.headers['x-vault-password'] || parsedUrl.searchParams.get('password') || session.masterPassword;

        let outputBuffer = fileBuffer;
        if (isEncryptedBuffer(fileBuffer)) {
          try {
            outputBuffer = decryptMedia(fileBuffer, reqPassword);
          } catch (_) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'Master password incorrect or missing.' }));
          }
        }

        const ext = path.extname(mFile.replace(/\.enc$/, '')).toLowerCase();
        let cType = 'image/jpeg';
        if (ext === '.png') cType = 'image/png';
        else if (ext === '.webp') cType = 'image/webp';
        else if (ext === '.gif') cType = 'image/gif';
        else if (ext === '.mp4') cType = 'video/mp4';
        else if (ext === '.mov') cType = 'video/quicktime';

        res.writeHead(200, {
          'Content-Type': cType,
          'Content-Length': outputBuffer.length,
          'Cache-Control': 'no-store, no-cache, private'
        });
        res.end(outputBuffer);
      } catch (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('File not found: ' + err.message);
      }
      return;
    }

    // 11. API: Delete media
    if (pathname.startsWith('/api/admin/media/') && req.method === 'DELETE') {
      if (!fromLocalhost) {
        res.writeHead(403);
        return res.end('Localhost only');
      }
      const parts = pathname.replace('/api/admin/media/', '').split('/');
      const [sId, mFile] = parts;
      const safePath = sId === 'current'
        ? path.normalize(path.join(sessionDir, mFile))
        : path.normalize(path.join(targetDir, sId, mFile));

      try {
        await fsp.unlink(safePath);
        try { await fsp.unlink(`${safePath}.meta.json`); } catch (_) {}
        try { await fsp.unlink(`${safePath}.meta.enc`); } catch (_) {}
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  });

  return new Promise((resolve, reject) => {
    let currentPort = port;
    const onError = (err) => {
      if (err.code === 'EADDRINUSE') {
        currentPort++;
        server.listen(currentPort);
      } else {
        reject(err);
      }
    };

    server.on('error', onError);
    server.once('listening', () => {
      server.removeListener('error', onError);
      resolve({
        server,
        session,
        port: currentPort,
        updateUrls: (pub, loc) => {
          session.publicUrl = pub;
          session.localUrl = loc;
        },
        close: () => {
          clearInterval(tickInterval);
          session.active = false;
          broadcastSSE('session-expired', { reason: 'manual_stop' });
          for (const client of sseClients) {
            try { client.end(); } catch (_) {}
          }
          return new Promise(res => server.close(res));
        }
      });
    });

    server.listen(currentPort);
  });
}
