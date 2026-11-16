#!/usr/bin/env node

import path from 'node:path';
import os from 'node:os';
import fsp from 'node:fs/promises';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import qrcode from 'qrcode-terminal';
import { createVaultServer } from './server.mjs';
import { createTunnel } from './tunnel.mjs';
import { isEncryptedBuffer, decryptMedia } from './crypto.mjs';
import {
  isTermux,
  getDefaultStorageDir,
  copyToClipboard,
  openBrowser,
  acquireWakeLock,
  releaseWakeLock
} from './platform.mjs';

const SESSION_FILE = path.join(os.homedir(), '.velvetvault-session.json');

/**
 * Parses duration strings like 15m, 30m, 1h, 45s, forever, unlimited
 */
function parseDuration(input) {
  if (!input) return 15;
  const str = input.toString().trim().toLowerCase();
  if (str === 'forever' || str === 'unlimited' || str === '0' || str === 'max') {
    return 525600; // 1 year
  }
  if (str.endsWith('h')) return parseFloat(str) * 60;
  if (str.endsWith('m')) return parseFloat(str);
  if (str.endsWith('s')) return parseFloat(str) / 60;
  const num = parseFloat(str);
  return isNaN(num) ? 15 : num;
}

/**
 * Formats seconds into mm:ss
 */
function formatTime(sec) {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  const remainder = s % 60;
  return `${m.toString().padStart(2, '0')}:${remainder.toString().padStart(2, '0')}`;
}

/**
 * Formats bytes
 */
function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

async function handleOpen(rawArgs) {
  // Check if session is already running
  if (existsSync(SESSION_FILE)) {
    try {
      const existing = JSON.parse(readFileSync(SESSION_FILE, 'utf8'));
      if (existing.pid) {
        try {
          process.kill(existing.pid, 0);
          console.log('\n⚠️  A VelvetVault session is already running!');
          console.log(`🔗 Link: ${existing.publicLink}`);
          console.log(`💻 Host Portal: ${existing.portalLink || 'http://127.0.0.1:4040/portal'}`);
          console.log(`Run 'vault close' to terminate it first.\n`);
          process.exit(1);
        } catch (_) {}
      }
    } catch (_) {}
  }

  // Parse arguments: duration, folder path, --password, --no-encrypt
  let durationArg = '15m';
  let storageDir = getDefaultStorageDir();
  let masterPassword = '';
  let noEncrypt = false;

  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (arg === '--dir' || arg === '-d') {
      const next = rawArgs[++i] || '';
      storageDir = path.resolve(next.replace(/^~(?=$|\/)/, os.homedir()));
    } else if (arg === '--password' || arg === '-p') {
      masterPassword = rawArgs[++i] || '';
    } else if (arg === '--no-encrypt' || arg === '--plain' || arg === '-u' || arg === '--no-enc') {
      noEncrypt = true;
    } else if (arg.startsWith('/') || arg.startsWith('~') || arg.startsWith('./') || (arg.includes('/') && !arg.startsWith('-'))) {
      storageDir = path.resolve(arg.replace(/^~(?=$|\/)/, os.homedir()));
    } else if (/^\d+[smh]?$/i.test(arg) || arg === 'forever' || arg === 'unlimited') {
      durationArg = arg;
    } else if (!arg.startsWith('-')) {
      durationArg = arg;
    }
  }

  if (noEncrypt) {
    masterPassword = '';
  } else if (!masterPassword) {
    masterPassword = randomBytes(6).toString('hex'); // 12-char hex passkey
  }

  const durationMinutes = parseDuration(durationArg);
  const port = 4040;

  console.log(`\n⏳ Initializing VelvetVault (${isTermux ? 'Android / Termux' : 'Linux'} Mode)...`);
  console.log(`⏱️  Duration: ${durationArg}`);
  console.log(`📂 Destination Folder: ${storageDir}`);
  if (noEncrypt) {
    console.log(`🔓 Encryption: OFF (Saving directly as regular viewable .jpg / .mp4 files)`);
  } else {
    console.log(`🔒 Encryption: ON (AES-256-GCM encrypted at rest)`);
  }

  // Prevent Android sleep
  acquireWakeLock();

  let serverInstance = null;
  let tunnelInstance = null;
  let timerInterval = null;

  const cleanup = async (reason = 'manual') => {
    if (timerInterval) clearInterval(timerInterval);
    process.stdout.write('\r\x1b[K');

    console.log(`\n🔒 Sealing VelvetVault (${reason})...`);
    releaseWakeLock();

    if (tunnelInstance && tunnelInstance.stop) {
      try { tunnelInstance.stop(); } catch (_) {}
    }
    if (serverInstance && serverInstance.close) {
      try { await serverInstance.close(); } catch (_) {}
    }
    if (existsSync(SESSION_FILE)) {
      try { unlinkSync(SESSION_FILE); } catch (_) {}
    }
    console.log(`✨ Vault closed cleanly. Server and tunnel terminated.\n`);
    process.exit(0);
  };

  process.on('SIGINT', () => cleanup('Ctrl+C pressed'));
  process.on('SIGTERM', () => cleanup('Terminated'));

  try {
    // 1. Boot local server
    serverInstance = await createVaultServer({
      durationMinutes,
      storageDir,
      masterPassword,
      port,
      onUpload: (file) => {
        process.stdout.write('\r\x1b[K');
        const time = new Date().toLocaleTimeString();
        const encLabel = file.isEncrypted
          ? '\x1b[33m[AES Encrypted]\x1b[0m'
          : '\x1b[32m[Regular File - Viewable in Gallery]\x1b[0m';
        console.log(`📸 [${time}] Received: ${file.originalName} (${formatBytes(file.size)}) ${encLabel}`);
        if (file.note) console.log(`   💌 Note: "${file.note}"`);
      },
      onExpire: (reason) => {
        cleanup(reason === 'time_up' ? 'Time expired' : 'Locked by user');
      }
    });

    // 2. Establish tunnel
    console.log('🌐 Opening secure HTTPS tunnel...');
    tunnelInstance = await createTunnel(serverInstance.port);

    const token = serverInstance.session.token;
    const publicLink = `${tunnelInstance.publicUrl}/?token=${token}`;
    const localLink = `${tunnelInstance.localUrl}/?token=${token}`;
    const portalLink = `http://127.0.0.1:${serverInstance.port}/portal`;

    serverInstance.updateUrls(tunnelInstance.publicUrl, tunnelInstance.localUrl);

    // Auto-copy to clipboard
    const copied = copyToClipboard(publicLink);

    // Save session info
    await fsp.writeFile(SESSION_FILE, JSON.stringify({
      pid: process.pid,
      port: serverInstance.port,
      token,
      publicLink,
      localLink,
      portalLink,
      storageDir,
      masterPassword,
      startedAt: Date.now(),
      expiresAt: serverInstance.session.expiresAt,
      sessionDir: serverInstance.session.sessionDir
    }, null, 2));

    // Save link file to home directory for easy retrieval
    try {
      const linkFile = path.join(os.homedir(), 'vault-link.txt');
      await fsp.writeFile(linkFile, publicLink + '\n', 'utf8');
    } catch (_) {}

    console.clear();
    const termCols = process.stdout.columns || 44;
    const border = '═'.repeat(Math.min(termCols, 52));

    console.log(border);
    console.log('  ✨ VELVETVAULT ACTIVE');
    console.log(border);
    console.log(`  ⏱️  Duration:   ${durationArg}`);
    console.log(`  📂 Saving to:   ${serverInstance.session.sessionDir}`);
    console.log(`  🛡️  Mode:        ${noEncrypt ? 'Normal .jpg/.mp4 (Gallery)' : 'AES-256 Encrypted'}`);
    if (!noEncrypt) {
      console.log(`  🔑 Passkey:     \x1b[33m${masterPassword}\x1b[0m`);
    }
    console.log(border);
    console.log('  🔗 UPLOAD LINK (Send to her):');
    console.log(`  \x1b[36;1m${publicLink}\x1b[0m`);
    console.log(border);
    if (copied) {
      console.log('  ✔ Link automatically copied to clipboard!');
    }
    console.log(`  📱 Host Portal: \x1b[35m${portalLink}\x1b[0m\n`);

    const termRows = process.stdout.rows || 24;
    if (!isTermux && termRows >= 34) {
      console.log('  📱 QR Code for your GF to scan with her phone:\n');
      qrcode.generate(publicLink, { small: true });
      console.log('');
    } else {
      console.log('  💡 Tip: Open Host Portal in browser to view QR & gallery.');
      console.log('  💡 Tip: Tap & hold link above to copy, or run "vault link".\n');
    }

    // Live terminal countdown timer — strictly stays on ONE line, never wraps
    timerInterval = setInterval(() => {
      const remainingSec = (serverInstance.session.expiresAt - Date.now()) / 1000;
      if (remainingSec <= 0) {
        clearInterval(timerInterval);
        return;
      }
      const count = serverInstance.session.totalFiles;
      const timeStr = formatTime(remainingSec);
      process.stdout.write(`\r\x1b[2K  ⏱️  [ ${timeStr} ]  📸 ${count} photo${count === 1 ? '' : 's'}`);
    }, 1000);

  } catch (err) {
    console.error('\n❌ Failed to start VelvetVault:', err.message);
    releaseWakeLock();
    if (serverInstance) serverInstance.close();
    if (tunnelInstance) tunnelInstance.stop();
    process.exit(1);
  }
}

async function handleClose() {
  releaseWakeLock();
  if (!existsSync(SESSION_FILE)) {
    console.log('ℹ️  No active VelvetVault session found.');
    return;
  }

  try {
    const session = JSON.parse(readFileSync(SESSION_FILE, 'utf8'));
    if (session.pid) {
      process.kill(session.pid, 'SIGINT');
      console.log(`🛑 Stopping active VelvetVault session (PID ${session.pid})...`);
    }
  } catch (e) {
    console.log('Session already terminated.');
  }

  try { unlinkSync(SESSION_FILE); } catch (_) {}
  console.log('✅ VelvetVault is closed.');
}

async function handleStatus() {
  if (!existsSync(SESSION_FILE)) {
    console.log('ℹ️  VelvetVault is currently OFFLINE.');
    return;
  }

  try {
    const session = JSON.parse(readFileSync(SESSION_FILE, 'utf8'));
    const remaining = Math.max(0, Math.floor((session.expiresAt - Date.now()) / 1000));
    if (remaining <= 0) {
      console.log('ℹ️  Session has expired.');
      try { unlinkSync(SESSION_FILE); } catch (_) {}
      return;
    }

    console.log('🟢 VelvetVault is ONLINE:');
    console.log(`   🔗 Upload Link:     ${session.publicLink}`);
    console.log(`   💻 Host Portal:     ${session.portalLink}`);
    console.log(`   ⏱️  Remaining:       ${formatTime(remaining)}`);
    console.log(`   📂 Storage:         ${session.sessionDir || session.storageDir}`);
  } catch (e) {
    console.log('Error reading status:', e.message);
  }
}

async function handlePortal() {
  if (existsSync(SESSION_FILE)) {
    try {
      const session = JSON.parse(readFileSync(SESSION_FILE, 'utf8'));
      const url = session.portalLink || 'http://127.0.0.1:4040/portal';
      console.log(`Opening VelvetVault Host Portal: ${url}`);
      openBrowser(url);
      return;
    } catch (_) {}
  }

  console.log('🚀 Starting standalone Host Portal...');
  const { server } = await createVaultServer({ durationMinutes: 1440, port: 4040 });
  const portalUrl = 'http://127.0.0.1:4040/portal';
  console.log(`💻 Host Portal available at: ${portalUrl}`);
  openBrowser(portalUrl);
  console.log('Press Ctrl+C to close.');
  process.on('SIGINT', () => {
    server.close();
    process.exit(0);
  });
}

async function handleLink() {
  if (!existsSync(SESSION_FILE)) {
    console.log('\n❌ No active vault session found. Run "vault open" first.\n');
    return;
  }
  try {
    const session = JSON.parse(readFileSync(SESSION_FILE, 'utf8'));
    if (!session.publicLink) {
      console.log('\n❌ No public link available in active session.\n');
      return;
    }
    const copied = copyToClipboard(session.publicLink);
    console.log('\n🔗 VelvetVault Upload Link:');
    console.log(`\x1b[36;1m${session.publicLink}\x1b[0m\n`);
    if (copied) {
      console.log('✔ Copied to clipboard!\n');
    }
  } catch (err) {
    console.error('Error reading session:', err.message);
  }
}

async function handleQR() {
  if (!existsSync(SESSION_FILE)) {
    console.log('\n❌ No active vault session found. Run "vault open" first.\n');
    return;
  }
  try {
    const session = JSON.parse(readFileSync(SESSION_FILE, 'utf8'));
    if (!session.publicLink) {
      console.log('\n❌ No public link available in active session.\n');
      return;
    }
    console.log('\n📱 Scan QR Code with Phone Camera:\n');
    qrcode.generate(session.publicLink, { small: true });
    console.log(`\n🔗 ${session.publicLink}\n`);
  } catch (err) {
    console.error('Error reading session:', err.message);
  }
}

async function handleExport(rawArgs) {
  let destDir = path.join(os.homedir(), 'Pictures', 'VelvetVault_Saved');
  let password = '';

  for (let i = 0; i < rawArgs.length; i++) {
    const a = rawArgs[i];
    if (a === '--password' || a === '-p') {
      password = rawArgs[++i] || '';
    } else if (!a.startsWith('-')) {
      if (!destDir || destDir.endsWith('VelvetVault_Saved')) {
        destDir = path.resolve(a.replace(/^~(?=$|\/)/, os.homedir()));
      } else if (!password) {
        password = a;
      }
    }
  }

  if (!password && existsSync(SESSION_FILE)) {
    try {
      const sess = JSON.parse(readFileSync(SESSION_FILE, 'utf8'));
      if (sess.masterPassword) password = sess.masterPassword;
    } catch (_) {}
  }

  if (!password) {
    const readline = await import('node:readline/promises');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    password = await rl.question('🔑 Enter Master Password to decrypt photos: ');
    rl.close();
  }

  console.log(`\n📂 Exporting and decrypting photos to: \x1b[36m${destDir}\x1b[0m...`);
  await fsp.mkdir(destDir, { recursive: true });

  const storageBase = getDefaultStorageDir();
  if (!existsSync(storageBase)) {
    console.log('No photos found in vault storage.');
    return;
  }

  let exported = 0;
  const sessionFolders = await fsp.readdir(storageBase);
  for (const sFolder of sessionFolders) {
    const sPath = path.join(storageBase, sFolder);
    const stat = await fsp.stat(sPath);
    if (!stat.isDirectory()) continue;

    const files = await fsp.readdir(sPath);
    for (const file of files) {
      if (file.endsWith('.meta.enc') || file.endsWith('.meta.json')) continue;
      const filePath = path.join(sPath, file);
      const raw = await fsp.readFile(filePath);

      let cleanBuffer = raw;
      if (isEncryptedBuffer(raw)) {
        try {
          cleanBuffer = decryptMedia(raw, password.trim());
        } catch (e) {
          console.error(`  ⚠️ Could not decrypt ${file} with this password.`);
          continue;
        }
      }

      const outName = file.replace(/\.enc$/, '');
      const outPath = path.join(destDir, outName);
      await fsp.writeFile(outPath, cleanBuffer);
      exported++;
      console.log(`  ✔ Decrypted & saved: ${outName} (${formatBytes(cleanBuffer.length)})`);
    }
  }

  if (exported > 0) {
    console.log(`\n🎉 Successfully exported ${exported} photo(s) to:`);
    console.log(`   \x1b[32m${destDir}\x1b[0m\n`);
    openBrowser(destDir);
  } else {
    console.log('\n❌ No photos could be exported (check your password or folder).\n');
  }
}

// Main CLI router
const args = process.argv.slice(2);
const command = args[0] || 'open';

if (command === '--help' || command === '-h' || command === 'help') {
  console.log(`
✨ VelvetVault — Ephemeral Self-Hosted Photo Vault (Android & Linux)

Usage: vault [command] [options]
       vault.sh [command] [options]

Commands:
  open [duration] [folder] [options]   Start vault session (e.g. 20m, 1h, forever)
  link                                 Show and copy upload link of active session
  qr                                   Display scan-able QR code of active session
  portal                               Open local Web Portal (Copy link, QR code, and photos)
  export [folder]                      Decrypt all photos and save to a normal folder
  close                                Stop active session and close tunnel immediately
  status                               Check if session is currently active

Options:
  --no-encrypt                         Save directly as regular viewable .jpg / .mp4 files
  --password, -p <pass>                Set custom Master Password for AES-256 encryption
  --dir, -d <path>                     Designated storage folder (or pass path directly)

Examples:
  vault open 20m
  vault open 30m ~/storage/shared/Pictures/Vault --no-encrypt
  vault open forever --no-encrypt
  vault link
  vault export ~/Pictures/SavedPhotos
  vault portal
  vault close
  `);
  process.exit(0);
}

switch (command) {
  case 'open':
  case 'start':
    handleOpen(args.slice(1));
    break;
  case 'link':
  case 'url':
  case 'copy':
    handleLink();
    break;
  case 'qr':
  case 'qrcode':
    handleQR();
    break;
  case 'close':
  case 'stop':
    handleClose();
    break;
  case 'status':
    handleStatus();
    break;
  case 'portal':
  case 'view':
  case 'gallery':
    handlePortal();
    break;
  case 'export':
  case 'decrypt':
  case 'save':
    handleExport(args.slice(1));
    break;
  default:
    if (/^\d+[smh]?$/i.test(command) || command.startsWith('-') || command.startsWith('/') || command.startsWith('~') || command.startsWith('.')) {
      handleOpen(args);
    } else {
      console.log(`Unknown command: ${command}. Run 'vault --help' for usage.`);
    }
}
