/**
 * metadata-strip.util.test.js
 *
 * Security-hardening-pass addition (threat-catalog Category L — EXIF/
 * metadata leakage on national ID photos and selfies). Pure unit tests,
 * no database required: builds minimal-but-valid JPEG/PNG/WEBP buffers
 * with a metadata segment/chunk injected, and asserts the stripped output
 * (a) no longer contains the injected metadata bytes, and (b) still
 * parses as a well-formed file of the same type (structurally — this
 * suite doesn't decode pixels, but does verify the marker/chunk structure
 * survives intact around the removed segment).
 */

const {
  stripJpegMetadata,
  stripPngMetadata,
  stripWebpMetadata,
  stripMetadata,
} = require('../../src/shared/utils/metadata-strip.util');

describe('metadata-strip.util', () => {
  describe('stripJpegMetadata', () => {
    function buildJpegWithExif() {
      const soi = Buffer.from([0xff, 0xd8]);

      // APP1 (EXIF) segment carrying a fake GPS tag string so we have
      // something distinctive to assert is gone afterward.
      const exifPayload = Buffer.from('Exif\x00\x00FAKE_GPS_COORDINATES_37.7749_-122.4194', 'binary');
      const app1Length = exifPayload.length + 2;
      const app1 = Buffer.concat([
        Buffer.from([0xff, 0xe1]),
        Buffer.from([(app1Length >> 8) & 0xff, app1Length & 0xff]),
        exifPayload,
      ]);

      // APP0 (JFIF) — a normal, non-metadata segment that should survive.
      const jfifPayload = Buffer.from([0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
      const app0Length = jfifPayload.length + 2;
      const app0 = Buffer.concat([
        Buffer.from([0xff, 0xe0]),
        Buffer.from([(app0Length >> 8) & 0xff, app0Length & 0xff]),
        jfifPayload,
      ]);

      const sos = Buffer.from([0xff, 0xda, 0x00, 0x02]); // truncated but fine — everything from SOS on is copied verbatim
      const scanData = Buffer.from([0x01, 0x02, 0x03, 0x04]);
      const eoi = Buffer.from([0xff, 0xd9]);

      return Buffer.concat([soi, app0, app1, sos, scanData, eoi]);
    }

    it('removes every APPn segment (including EXIF) while preserving SOI/scan-data/EOI', () => {
      // By design, stripJpegMetadata removes ALL APPn segments (0xFFE0-
      // 0xFFEF), not just APP1/EXIF specifically — APP0/JFIF is harmless
      // but carries no information the decoder strictly needs either, and
      // treating the whole APPn range as "potentially metadata" is the
      // simpler, more conservative rule (see the function's doc comment).
      const original = buildJpegWithExif();
      const stripped = stripJpegMetadata(original);

      expect(stripped.includes('FAKE_GPS_COORDINATES')).toBe(false);
      expect(stripped.includes(Buffer.from([0x4a, 0x46, 0x49, 0x46]))).toBe(false); // "JFIF" (APP0) also stripped
      expect(stripped[0]).toBe(0xff);
      expect(stripped[1]).toBe(0xd8); // SOI preserved
      expect(stripped.subarray(stripped.length - 2).equals(Buffer.from([0xff, 0xd9]))).toBe(true); // EOI preserved
      expect(stripped.includes(Buffer.from([0x01, 0x02, 0x03, 0x04]))).toBe(true); // scan data preserved
      expect(stripped.length).toBeLessThan(original.length);
    });

    it('throws on a buffer that is not a valid JPEG, so callers fall back safely', () => {
      const notJpeg = Buffer.from('this is not an image', 'utf8');
      expect(() => stripJpegMetadata(notJpeg)).toThrow();
    });
  });

  describe('stripPngMetadata', () => {
    function crc32(buf) {
      // Minimal CRC32 implementation (PNG's checksum algorithm) — good
      // enough for building a syntactically valid test fixture; the
      // stripper itself doesn't validate CRCs, only chunk structure.
      let c;
      const table = [];
      for (let n = 0; n < 256; n++) {
        c = n;
        for (let k = 0; k < 8; k++) {
          c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        }
        table[n] = c;
      }
      let crc = 0xffffffff;
      for (let i = 0; i < buf.length; i++) {
        crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
      }
      return (crc ^ 0xffffffff) >>> 0;
    }

    function chunk(type, data) {
      const length = Buffer.alloc(4);
      length.writeUInt32BE(data.length, 0);
      const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
      const crc = Buffer.alloc(4);
      crc.writeUInt32BE(crc32(typeAndData), 0);
      return Buffer.concat([length, typeAndData, crc]);
    }

    function buildPngWithExif() {
      const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const ihdrData = Buffer.alloc(13); // minimal, doesn't need to be a decodable image for this test
      const ihdr = chunk('IHDR', ihdrData);
      const exif = chunk('eXIf', Buffer.from('FAKE_GPS_COORDINATES', 'ascii'));
      const idat = chunk('IDAT', Buffer.from([0x00, 0x01, 0x02]));
      const iend = chunk('IEND', Buffer.alloc(0));
      return Buffer.concat([signature, ihdr, exif, idat, iend]);
    }

    it('removes the eXIf chunk while preserving IHDR/IDAT/IEND', () => {
      const original = buildPngWithExif();
      const stripped = stripPngMetadata(original);

      expect(stripped.includes('FAKE_GPS_COORDINATES')).toBe(false);
      expect(stripped.includes(Buffer.from('IHDR', 'ascii'))).toBe(true);
      expect(stripped.includes(Buffer.from('IDAT', 'ascii'))).toBe(true);
      expect(stripped.includes(Buffer.from('IEND', 'ascii'))).toBe(true);
      expect(stripped.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true);
    });

    it('throws on a buffer that is not a valid PNG', () => {
      expect(() => stripPngMetadata(Buffer.from('not a png'))).toThrow();
    });
  });

  describe('stripWebpMetadata', () => {
    function chunk(fourCC, data) {
      const size = Buffer.alloc(4);
      size.writeUInt32LE(data.length, 0);
      const padded = data.length % 2 === 1 ? Buffer.concat([data, Buffer.from([0x00])]) : data;
      return Buffer.concat([Buffer.from(fourCC, 'ascii'), size, padded]);
    }

    function buildWebpWithExif() {
      const vp8Chunk = chunk('VP8 ', Buffer.from([0x01, 0x02, 0x03, 0x04]));
      const exifChunk = chunk('EXIF', Buffer.from('FAKE_GPS_COORDINATES', 'ascii'));
      const payload = Buffer.concat([Buffer.from('WEBP', 'ascii'), vp8Chunk, exifChunk]);
      const riffSize = Buffer.alloc(4);
      riffSize.writeUInt32LE(payload.length, 0);
      return Buffer.concat([Buffer.from('RIFF', 'ascii'), riffSize, payload]);
    }

    it('removes the EXIF chunk and rewrites the RIFF size', () => {
      const original = buildWebpWithExif();
      const stripped = stripWebpMetadata(original);

      expect(stripped.includes('FAKE_GPS_COORDINATES')).toBe(false);
      expect(stripped.toString('ascii', 0, 4)).toBe('RIFF');
      expect(stripped.toString('ascii', 8, 12)).toBe('WEBP');
      expect(stripped.includes(Buffer.from('VP8 ', 'ascii'))).toBe(true);

      const declaredSize = stripped.readUInt32LE(4);
      expect(declaredSize).toBe(stripped.length - 8); // RIFF size excludes the 'RIFF'+size fields themselves
    });

    it('throws on a buffer that is not a valid WEBP', () => {
      expect(() => stripWebpMetadata(Buffer.from('not a webp'))).toThrow();
    });
  });

  describe('stripMetadata (dispatcher, fail-safe behavior)', () => {
    it('falls back to returning the original buffer, unchanged, on a malformed input rather than throwing', () => {
      const malformed = Buffer.from([0xff, 0xd8, 0x00, 0x00, 0x00]); // looks like a JPEG SOI but is truncated garbage
      const result = stripMetadata(malformed, 'image/jpeg');
      expect(Buffer.isBuffer(result)).toBe(true);
      expect(result.equals(malformed)).toBe(true);
    });

    it('passes through unknown mime types unchanged', () => {
      const buf = Buffer.from([1, 2, 3]);
      expect(stripMetadata(buf, 'application/octet-stream')).toBe(buf);
    });
  });
});
