import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

const MAGIC_HEADER = Buffer.from('VV01'); // VelvetVault v1 header

/**
 * Derives a 32-byte key from a user password using scrypt
 */
function deriveKey(password, salt) {
  return scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 });
}

/**
 * Encrypts a media buffer using AES-256-GCM with the user's master password.
 */
export function encryptMedia(buffer, password) {
  if (!password || !Buffer.isBuffer(buffer)) {
    return { buffer, isEncrypted: false };
  }

  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = deriveKey(password, salt);

  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(buffer), cipher.final()]);
  const authTag = cipher.getAuthTag();

  const encryptedBuffer = Buffer.concat([
    MAGIC_HEADER,
    salt,
    iv,
    authTag,
    ciphertext
  ]);

  return { buffer: encryptedBuffer, isEncrypted: true };
}

/**
 * Decrypts a media buffer using AES-256-GCM with the user's master password.
 */
export function decryptMedia(buffer, password) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 48) {
    return buffer;
  }

  if (!buffer.subarray(0, 4).equals(MAGIC_HEADER)) {
    return buffer; // unencrypted file
  }

  if (!password) {
    throw new Error('This photo is encrypted. Master password is required to decrypt.');
  }

  const salt = buffer.subarray(4, 20);
  const iv = buffer.subarray(20, 32);
  const authTag = buffer.subarray(32, 48);
  const ciphertext = buffer.subarray(48);

  const key = deriveKey(password, salt);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);

  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * Checks if a buffer is encrypted with VelvetVault header
 */
export function isEncryptedBuffer(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length >= 48 && buffer.subarray(0, 4).equals(MAGIC_HEADER);
}
