/**
 * media.ts — tiny media writers used by the fake adapters and the disposable
 * test cases: a solid PNG and a silent WAV, both written with stdlib only.
 */

import fs from 'node:fs';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let crc = -1;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ -1) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** A real, valid PNG of one solid colour. Used by the fake media adapter. */
export function solidPng(width: number, height: number, colour: Rgb = { r: 11, g: 15, b: 23 }): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // colour type: truecolour
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;

  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * stride;
    raw[rowStart] = 0; // filter: none
    for (let x = 0; x < width; x += 1) {
      const offset = rowStart + 1 + x * 3;
      raw[offset] = colour.r;
      raw[offset + 1] = colour.g;
      raw[offset + 2] = colour.b;
    }
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A valid PCM WAV of silence, for disposable cases and fake speech. */
export function silentWav(seconds: number, sampleRate = 8000): Buffer {
  const samples = Math.max(1, Math.round(seconds * sampleRate));
  const data = Buffer.alloc(samples * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** Duration of a WAV written by `silentWav`, in seconds. */
export function wavDuration(buffer: Buffer): number {
  if (buffer.length < 44) return 0;
  const sampleRate = buffer.readUInt32LE(24);
  const channels = buffer.readUInt16LE(22);
  const bits = buffer.readUInt16LE(34);
  const byteRate = sampleRate * channels * (bits / 8);
  const dataBytes = buffer.readUInt32LE(40);
  return byteRate > 0 ? dataBytes / byteRate : 0;
}

export function checksum(filePath: string, algorithm = 'sha256'): string {
  return crypto.createHash(algorithm).update(fs.readFileSync(filePath)).digest('hex');
}
