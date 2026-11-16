import { exec } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Checks if running inside Termux on Android
 */
export const isTermux = Boolean(
  process.env.TERMUX_VERSION ||
  existsSync('/data/data/com.termux') ||
  process.env.PREFIX?.includes('com.termux')
);

/**
 * Returns normalized architecture: 'arm64', 'x64', 'arm'
 */
export function getArch() {
  const arch = process.arch;
  if (arch === 'arm64' || arch === 'aarch64') return 'arm64';
  if (arch === 'x64' || arch === 'amd64') return 'x64';
  if (arch === 'arm') return 'arm';
  return arch;
}

/**
 * Gets best default storage directory depending on platform
 */
export function getDefaultStorageDir() {
  const home = os.homedir();

  if (isTermux) {
    // Check if Android shared storage is mounted
    const sharedPictures = path.join(home, 'storage', 'shared', 'Pictures', 'Vault');
    const termuxPictures = path.join(home, 'storage', 'pictures', 'Vault');
    const sdcardPictures = '/sdcard/Pictures/Vault';

    if (existsSync(path.join(home, 'storage', 'shared', 'Pictures'))) {
      return sharedPictures;
    }
    if (existsSync(path.join(home, 'storage', 'pictures'))) {
      return termuxPictures;
    }
    if (existsSync('/sdcard/Pictures')) {
      return sdcardPictures;
    }
    return path.join(home, '.velvetvault-storage', 'inbox');
  }

  // Linux / macOS desktop
  const desktopPictures = path.join(home, 'Pictures', 'Vault');
  if (existsSync(path.join(home, 'Pictures'))) {
    return desktopPictures;
  }
  return path.join(home, '.velvetvault-storage', 'inbox');
}

/**
 * Sends a system notification with optional vibration
 */
export function sendNotification(title, message) {
  if (isTermux) {
    // Termux:API native notification + vibration
    const safeTitle = title.replace(/"/g, '\\"');
    const safeMsg = message.replace(/"/g, '\\"');
    exec(`termux-notification --title "${safeTitle}" --content "${safeMsg}" --vibrate 500,200,500 2>/dev/null`, () => {});
    return;
  }

  if (process.platform === 'linux') {
    exec(`notify-send -a "VelvetVault" -i camera-photo "${title}" "${message}" 2>/dev/null`, () => {});
  } else if (process.platform === 'darwin') {
    exec(`osascript -e 'display notification "${message}" with title "${title}"' 2>/dev/null`, () => {});
  }
}

/**
 * Copies text to system clipboard (Wayland, X11, macOS, Termux)
 */
export function copyToClipboard(text) {
  try {
    if (isTermux) {
      const proc = exec('termux-clipboard-set 2>/dev/null');
      proc.stdin.write(text);
      proc.stdin.end();
      return true;
    }

    if (process.platform === 'darwin') {
      const proc = exec('pbcopy 2>/dev/null');
      proc.stdin.write(text);
      proc.stdin.end();
      return true;
    }

    const proc = exec('wl-copy 2>/dev/null || xclip -selection clipboard 2>/dev/null');
    proc.stdin.write(text);
    proc.stdin.end();
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Opens browser url on Termux, Linux, or macOS
 */
export function openBrowser(url) {
  if (isTermux) {
    exec(`termux-open-url "${url}" 2>/dev/null`);
    return;
  }
  if (process.platform === 'darwin') {
    exec(`open "${url}" 2>/dev/null`);
    return;
  }
  exec(`xdg-open "${url}" 2>/dev/null || open "${url}" 2>/dev/null`);
}

/**
 * Prevents Android OS from putting CPU to sleep during active session
 */
export function acquireWakeLock() {
  if (isTermux) {
    exec('termux-wake-lock 2>/dev/null');
  }
}

/**
 * Releases Android wake lock when session finishes
 */
export function releaseWakeLock() {
  if (isTermux) {
    exec('termux-wake-unlock 2>/dev/null');
  }
}
