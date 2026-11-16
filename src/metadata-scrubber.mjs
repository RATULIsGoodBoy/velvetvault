/**
 * Pure Node.js metadata & EXIF GPS scrubber.
 * Strips location tags, camera metadata, and comments from JPEG images
 * without re-encoding pixels or losing quality.
 */

export function scrubJpegMetadata(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) {
    return buffer;
  }

  // Check JPEG SOI (Start of Image) marker: 0xFF 0xD8
  if (buffer[0] !== 0xFF || buffer[1] !== 0xD8) {
    return buffer;
  }

  const chunks = [Buffer.from([0xFF, 0xD8])];
  let offset = 2;

  while (offset < buffer.length) {
    if (buffer[offset] !== 0xFF) {
      chunks.push(buffer.subarray(offset));
      break;
    }

    const marker = buffer[offset + 1];
    offset += 2;

    if (marker === 0xD9) {
      chunks.push(Buffer.from([0xFF, 0xD9]));
      break;
    }

    if (marker === 0x00 || (marker >= 0xD0 && marker <= 0xD7)) {
      chunks.push(Buffer.from([0xFF, marker]));
      continue;
    }

    if (offset + 2 > buffer.length) {
      chunks.push(buffer.subarray(offset - 2));
      break;
    }

    const length = buffer.readUInt16BE(offset);
    const segmentStart = offset - 2;
    const segmentEnd = offset + length;

    if (segmentEnd > buffer.length) {
      chunks.push(buffer.subarray(segmentStart));
      break;
    }

    // 0xE1 = APP1 (Exif, GPS, XMP)
    // 0xED = APP13 (Photoshop IPTC)
    // 0xFE = COM (Comments)
    if (marker === 0xE1 || marker === 0xED || marker === 0xFE) {
      // Strip metadata segment
      offset += length;
      continue;
    }

    // 0xDA = SOS (Start of Scan) - all following bytes are image data
    if (marker === 0xDA) {
      chunks.push(buffer.subarray(segmentStart));
      break;
    }

    chunks.push(buffer.subarray(segmentStart, segmentEnd));
    offset += length;
  }

  return Buffer.concat(chunks);
}

/**
 * Strips metadata according to MIME type
 */
export function scrubMediaMetadata(buffer, mimeType) {
  if (!mimeType) return buffer;
  if (mimeType === 'image/jpeg' || mimeType === 'image/jpg') {
    return scrubJpegMetadata(buffer);
  }
  return buffer;
}
