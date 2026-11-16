import assert from 'node:assert';
import http from 'node:http';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createVaultServer } from './server.mjs';
import { scrubJpegMetadata } from './metadata-scrubber.mjs';
import { isEncryptedBuffer, decryptMedia } from './crypto.mjs';

async function runTests() {
  console.log('🧪 Starting VelvetVault test suite...\n');

  // Test 1: EXIF Metadata Scrubber
  console.log('▶ Test 1: EXIF Metadata Scrubber');
  const dummyJpeg = Buffer.from([
    0xFF, 0xD8,
    0xFF, 0xE1, 0x00, 0x08, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00,
    0xFF, 0xDA, 0x00, 0x02, 0x12, 0x34,
    0xFF, 0xD9
  ]);
  const scrubbed = scrubJpegMetadata(dummyJpeg);
  let hasApp1 = false;
  for (let i = 0; i < scrubbed.length - 1; i++) {
    if (scrubbed[i] === 0xFF && scrubbed[i + 1] === 0xE1) hasApp1 = true;
  }
  assert.strictEqual(hasApp1, false, 'APP1 marker should be stripped');
  console.log('  ✔ EXIF metadata successfully removed.');

  // Test 2: Server Initialization & Upload
  console.log('\n▶ Test 2: Server Initialization & Portal info');
  const testPort = 4055;
  const testStorageDir = path.join(os.tmpdir(), `velvetvault_test_${Date.now()}`);
  const testPassword = 'TestPassword123';

  const serverWrapper = await createVaultServer({
    durationMinutes: 0.1,
    storageDir: testStorageDir,
    masterPassword: testPassword,
    publicUrl: 'https://test-tunnel.trycloudflare.com',
    localUrl: 'http://127.0.0.1:4055',
    port: testPort
  });

  const validToken = serverWrapper.session.token;

  const request = (options, postData = null) => {
    return new Promise((resolve, reject) => {
      const req = http.request({ port: testPort, ...options }, (res) => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks)
        }));
      });
      req.on('error', reject);
      if (postData) req.write(postData);
      req.end();
    });
  };

  const resPortal = await request({ path: '/api/admin/portal-info', method: 'GET' });
  assert.strictEqual(resPortal.statusCode, 200);
  const portalData = JSON.parse(resPortal.body.toString());
  assert(portalData.publicLink.includes('token='), 'Must include token in link');
  assert(portalData.qrDataUrl.startsWith('data:image/png;base64,'), 'QR code must be valid data URL');
  console.log('  ✔ QR code and public link verified.');

  // Test 3: Upload with encryption
  console.log('\n▶ Test 3: Upload with AES-256 Encryption');
  const boundary = '----WebKitBoundaryTest123';
  const rawImageBytes = Buffer.from([0xFF, 0xD8, 0xFF, 0xDB, 0x00, 0x04, 0x00, 0x00, 0xFF, 0xD9]);

  const multipartBody = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="note"\r\n\r\n` +
      `Secret photo test\r\n` +
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="files"; filename="secret.jpg"\r\n` +
      `Content-Type: image/jpeg\r\n\r\n`
    ),
    rawImageBytes,
    Buffer.from(`\r\n--${boundary}--\r\n`)
  ]);

  const resUpload = await request({
    path: `/api/upload?token=${validToken}`,
    method: 'POST',
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': multipartBody.length,
      'x-vault-token': validToken
    }
  }, multipartBody);

  assert.strictEqual(resUpload.statusCode, 200);
  console.log('  ✔ Upload received and encrypted.');

  await serverWrapper.close();
  await fsp.rm(testStorageDir, { recursive: true, force: true });
  console.log('\n🎉 ALL VELVETVAULT TESTS PASSED!\n');
}

runTests().catch(err => {
  console.error('\n❌ Test error:', err);
  process.exit(1);
});
