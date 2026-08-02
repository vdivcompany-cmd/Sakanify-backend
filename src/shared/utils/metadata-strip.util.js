/**
 * metadata-strip.util.js
 *
 * Security-hardening-pass addition (Aug 2026, threat-catalog Category L —
 * "File-Upload-Specific Threats: EXIF/metadata leakage"). A phone-camera
 * national ID photo or selfie can carry embedded EXIF metadata — most
 * importantly GPS coordinates and device make/model — inside the image
 * file itself, independent of anything the application code does with the
 * pixels. Storing that file as-is means anyone who later gets access to it
 * (a signed URL, a backup, a future export) also gets the uploader's exact
 * location and device, which this project has no legitimate use for and
 * never asked users to share. This strips that metadata at upload time,
 * before the buffer ever reaches file-storage.adapter.storeFile()'s write.
 *
 * Deliberately implemented as a small, dependency-free byte-level strip
 * rather than pulling in an image-processing library (e.g. sharp): sharp
 * is a native addon (large install footprint, another thing to keep
 * patched) and this project doesn't otherwise need image
 * decoding/re-encoding anywhere — CLAUDE.md's "prioritize additive/narrow
 * fixes" guidance for this pass favors the smaller, dependency-free
 * change. If real server-side image processing (resizing/thumbnailing) is
 * ever added later, that's the point to revisit this and let a proper
 * image library subsume it (see threat-catalog Category L's
 * decompression/image-parsing note).
 *
 * Supports exactly the 3 formats this project accepts (see
 * file-upload.util.js's ALLOWED_MIME_TYPES / file-storage.adapter.js's
 * MAGIC_BYTES): JPEG, PNG, WEBP. Fails safe: if a buffer doesn't parse the
 * way a well-formed file of its claimed type should, the original buffer
 * is returned unchanged (with a logged warning) rather than throwing or
 * producing a corrupted image — availability of a real KYC submission
 * matters more than this defense-in-depth layer, and the file has already
 * passed magic-byte content-type sniffing before this ever runs.
 */

/** JPEG: strip every APPn (0xFFE0-0xFFEF) and COM (0xFFFE) segment — the
 * only places EXIF (APP1), Photoshop/XMP (APP13), and free-text comments
 * can live. SOI/SOF/DHT/DQT/DRI and the entropy-coded scan data (SOS
 * onward) are always copied through untouched, so image pixels are never
 * altered. */
function stripJpegMetadata(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    throw new Error('Not a valid JPEG (missing SOI marker)');
  }

  const chunks = [buffer.subarray(0, 2)]; // SOI
  let offset = 2;

  while (offset < buffer.length) {
    if (buffer[offset] !== 0xff) {
      throw new Error(`Malformed JPEG: expected marker prefix 0xFF at offset ${offset}`);
    }

    const marker = buffer[offset + 1];

    // EOI — end of image, nothing follows.
    if (marker === 0xd9) {
      chunks.push(buffer.subarray(offset, offset + 2));
      offset += 2;
      break;
    }

    // SOS — start of entropy-coded scan data. No more metadata segments
    // can appear after this; copy everything remaining (scan data + EOI)
    // through as-is rather than trying to parse compressed data.
    if (marker === 0xda) {
      chunks.push(buffer.subarray(offset));
      offset = buffer.length;
      break;
    }

    // Standalone markers with no length field (RSTn 0xD0-0xD7, TEM 0x01
    // — not expected before SOS, but handled defensively).
    if (marker >= 0xd0 && marker <= 0xd7) {
      chunks.push(buffer.subarray(offset, offset + 2));
      offset += 2;
      continue;
    }

    if (offset + 4 > buffer.length) {
      throw new Error('Malformed JPEG: truncated segment length');
    }

    const length = buffer.readUInt16BE(offset + 2); // includes the 2 length bytes
    const segmentEnd = offset + 2 + length;
    if (length < 2 || segmentEnd > buffer.length) {
      throw new Error('Malformed JPEG: segment length out of bounds');
    }

    const isMetadataSegment = (marker >= 0xe0 && marker <= 0xef) || marker === 0xfe; // APPn / COM
    if (!isMetadataSegment) {
      chunks.push(buffer.subarray(offset, segmentEnd));
    }

    offset = segmentEnd;
  }

  return Buffer.concat(chunks);
}

/** PNG: drop ancillary text/EXIF chunk types that can carry arbitrary
 * metadata (eXIf, tEXt, zTXt, iTXt); every other chunk (including
 * rendering-relevant ancillary ones like pHYs/gAMA/sRGB) passes through
 * unchanged, so the decoded image is identical. */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_METADATA_CHUNK_TYPES = new Set(['eXIf', 'tEXt', 'zTXt', 'iTXt']);

function stripPngMetadata(buffer) {
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('Not a valid PNG (missing signature)');
  }

  const chunks = [PNG_SIGNATURE];
  let offset = 8;

  while (offset < buffer.length) {
    if (offset + 8 > buffer.length) {
      throw new Error('Malformed PNG: truncated chunk header');
    }

    const dataLength = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const chunkEnd = offset + 8 + dataLength + 4; // header + data + CRC

    if (chunkEnd > buffer.length) {
      throw new Error(`Malformed PNG: chunk "${type}" length out of bounds`);
    }

    if (!PNG_METADATA_CHUNK_TYPES.has(type)) {
      chunks.push(buffer.subarray(offset, chunkEnd));
    }

    offset = chunkEnd;

    if (type === 'IEND') break;
  }

  return Buffer.concat(chunks);
}

/** WEBP: RIFF container — drop EXIF/XMP chunks and rewrite the outer RIFF
 * size field to match. */
function stripWebpMetadata(buffer) {
  if (
    buffer.length < 12
    || buffer.toString('ascii', 0, 4) !== 'RIFF'
    || buffer.toString('ascii', 8, 12) !== 'WEBP'
  ) {
    throw new Error('Not a valid WEBP (missing RIFF/WEBP header)');
  }

  const chunks = [buffer.subarray(8, 12)]; // 'WEBP' (RIFF header itself is rebuilt at the end)
  let offset = 12;

  while (offset < buffer.length) {
    if (offset + 8 > buffer.length) {
      throw new Error('Malformed WEBP: truncated chunk header');
    }

    const fourCC = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const paddedSize = size + (size % 2); // chunks are padded to even length
    const chunkEnd = offset + 8 + paddedSize;

    if (chunkEnd > buffer.length) {
      throw new Error(`Malformed WEBP: chunk "${fourCC}" length out of bounds`);
    }

    const isMetadataChunk = fourCC === 'EXIF' || fourCC === 'XMP ';
    if (!isMetadataChunk) {
      chunks.push(buffer.subarray(offset, chunkEnd));
    }

    offset = chunkEnd;
  }

  const payload = Buffer.concat(chunks);
  const riffSize = Buffer.alloc(4);
  riffSize.writeUInt32LE(payload.length, 0); // payload already includes 'WEBP' + chunks, matches RIFF size semantics

  return Buffer.concat([Buffer.from('RIFF', 'ascii'), riffSize, payload]);
}

/**
 * stripMetadata(buffer, mime) -> Buffer
 *
 * Dispatches to the right format-specific stripper based on the
 * magic-byte-sniffed mime type (never the client-supplied one — callers
 * pass the value returned by file-storage.adapter.sniffContentType).
 * Never throws: on any parse failure, logs a warning and returns the
 * original buffer unchanged so the upload still succeeds.
 */
function stripMetadata(buffer, mime) {
  try {
    if (mime === 'image/jpeg') return stripJpegMetadata(buffer);
    if (mime === 'image/png') return stripPngMetadata(buffer);
    if (mime === 'image/webp') return stripWebpMetadata(buffer);
    return buffer;
  } catch (err) {
    console.warn(`[metadata-strip.util] Failed to strip metadata for ${mime}, storing original buffer: ${err.message}`);
    return buffer;
  }
}

module.exports = {
  stripMetadata,
  stripJpegMetadata,
  stripPngMetadata,
  stripWebpMetadata,
};
