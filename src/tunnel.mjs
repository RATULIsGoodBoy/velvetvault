import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getArch, isTermux } from './platform.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');

/**
 * Gets the primary local LAN IP address
 */
export function getLocalIP() {
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }
  return '127.0.0.1';
}

/**
 * Locates cloudflared executable (checks bin/cloudflared or PATH)
 */
function findCloudflared() {
  const localBinary = path.join(ROOT_DIR, 'bin', 'cloudflared');
  if (existsSync(localBinary)) {
    return localBinary;
  }
  return 'cloudflared';
}

/**
 * Starts a Cloudflare Quick Tunnel (Free, zero accounts needed)
 */
function startCloudflareTunnel(port) {
  return new Promise((resolve, reject) => {
    const binary = findCloudflared();
    const child = spawn(binary, ['tunnel', '--url', `http://127.0.0.1:${port}`], {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let settled = false;
    let urlFound = null;
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill('SIGTERM');
        reject(new Error('Cloudflare tunnel timed out after 18s'));
      }
    }, 18000);

    const onData = (data) => {
      const text = data.toString();
      const match = text.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
      if (match && !settled) {
        settled = true;
        clearTimeout(timeout);
        urlFound = match[0];
        resolve({
          type: 'Cloudflare Quick Tunnel',
          url: urlFound,
          process: child,
          stop: () => {
            try { child.kill('SIGTERM'); } catch (_) {}
          }
        });
      }
    };

    child.stdout.on('data', onData);
    child.stderr.on('data', onData);

    child.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(err);
      }
    });

    child.on('exit', (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(new Error(`cloudflared exited with code ${code}`));
      }
    });
  });
}

/**
 * Starts an SSH tunnel via Pinggy (Ultra-fast, works natively on Android/Termux)
 */
function startPinggyTunnel(port) {
  return new Promise((resolve, reject) => {
    const child = spawn('ssh', [
      '-p', '443',
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'ServerAliveInterval=30',
      '-R0:localhost:' + port,
      'a.pinggy.io'
    ], {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill('SIGTERM');
        reject(new Error('Pinggy tunnel timed out'));
      }
    }, 14000);

    const onData = (data) => {
      const text = data.toString();
      const match = text.match(/https:\/\/[a-zA-Z0-9-]+\.a\.pinggy\.link/);
      if (match && !settled) {
        settled = true;
        clearTimeout(timeout);
        resolve({
          type: 'SSH Tunnel (Pinggy)',
          url: match[0],
          process: child,
          stop: () => {
            try { child.kill('SIGTERM'); } catch (_) {}
          }
        });
      }
    };

    child.stdout.on('data', onData);
    child.stderr.on('data', onData);

    child.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(err);
      }
    });
  });
}

/**
 * Starts an SSH reverse tunnel via localhost.run
 */
function startLocalhostRunTunnel(port) {
  return new Promise((resolve, reject) => {
    const child = spawn('ssh', [
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'ServerAliveInterval=30',
      '-R', `80:127.0.0.1:${port}`,
      'nokey@localhost.run'
    ], {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill('SIGTERM');
        reject(new Error('localhost.run tunnel timed out'));
      }
    }, 14000);

    const onData = (data) => {
      const text = data.toString();
      const match = text.match(/https:\/\/[a-zA-Z0-9-]+\.lhr\.life/);
      if (match && !settled) {
        settled = true;
        clearTimeout(timeout);
        resolve({
          type: 'SSH Tunnel (localhost.run)',
          url: match[0],
          process: child,
          stop: () => {
            try { child.kill('SIGTERM'); } catch (_) {}
          }
        });
      }
    };

    child.stdout.on('data', onData);
    child.stderr.on('data', onData);

    child.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(err);
      }
    });
  });
}

/**
 * Main tunnel launcher with 3-tier fallback (Cloudflare -> Pinggy -> localhost.run -> LAN)
 */
export async function createTunnel(port) {
  const localIp = getLocalIP();
  const localUrl = `http://${localIp}:${port}`;

  // 1. Try Cloudflare Quick Tunnel
  try {
    const cf = await startCloudflareTunnel(port);
    return {
      publicUrl: cf.url,
      localUrl,
      type: cf.type,
      stop: cf.stop
    };
  } catch (_) {}

  // 2. Try Pinggy SSH Tunnel
  try {
    const pinggy = await startPinggyTunnel(port);
    return {
      publicUrl: pinggy.url,
      localUrl,
      type: pinggy.type,
      stop: pinggy.stop
    };
  } catch (_) {}

  // 3. Try localhost.run SSH Tunnel
  try {
    const lhr = await startLocalhostRunTunnel(port);
    return {
      publicUrl: lhr.url,
      localUrl,
      type: lhr.type,
      stop: lhr.stop
    };
  } catch (_) {}

  // 4. Fallback to Local LAN
  return {
    publicUrl: localUrl,
    localUrl,
    type: 'Local LAN Network',
    stop: () => {}
  };
}
