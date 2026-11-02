// A STORE-only zip writer (PKWARE APPNOTE 6.3.10, §4.3): no compression, UTF-8 names, no zip64. The lecture
// package is mostly PNGs, which do not compress, and text, which is small, so deflate would buy little for a
// dependency. Limits: under 65 535 entries and 4 GiB, far beyond a lecture.

export interface ZipEntry {
  /** Path inside the archive, forward slashes, no leading slash. */
  path: string;
  data: Uint8Array | string;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 (IEEE 802.3), as zip stores it. */
export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** MS-DOS date and time of `d` in local time (zip's only mandatory timestamp). */
function dosTime(d: Date): { time: number; date: number } {
  const year = Math.min(2107, Math.max(1980, d.getFullYear()));
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

const UTF8_NAMES = 0x0800;
const VERSION = 20;

/** The archive's bytes, in parts (a Blob takes them without one big copy). */
export function zipParts(entries: readonly ZipEntry[], when = new Date()): Uint8Array[] {
  const enc = new TextEncoder();
  const { time, date } = dosTime(when);
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.path)) throw new Error(`duplicate zip entry ${entry.path}`);
    seen.add(entry.path);
    const name = enc.encode(entry.path);
    const data = typeof entry.data === "string" ? enc.encode(entry.data) : entry.data;
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, VERSION, true);
    local.setUint16(6, UTF8_NAMES, true);
    local.setUint16(8, 0, true); // stored
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true);
    parts.push(new Uint8Array(local.buffer), name, data);

    const dir = new DataView(new ArrayBuffer(46));
    dir.setUint32(0, 0x02014b50, true);
    dir.setUint16(4, VERSION, true);
    dir.setUint16(6, VERSION, true);
    dir.setUint16(8, UTF8_NAMES, true);
    dir.setUint16(10, 0, true);
    dir.setUint16(12, time, true);
    dir.setUint16(14, date, true);
    dir.setUint32(16, crc, true);
    dir.setUint32(20, data.length, true);
    dir.setUint32(24, data.length, true);
    dir.setUint16(28, name.length, true);
    // extra, comment, disk, internal and external attributes: 0
    dir.setUint32(42, offset, true);
    central.push(new Uint8Array(dir.buffer), name);
    offset += 30 + name.length + data.length;
  }
  const dirSize = central.reduce((n, p) => n + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, dirSize, true);
  end.setUint32(16, offset, true);
  return [...parts, ...central, new Uint8Array(end.buffer)];
}

export function zipBlob(entries: readonly ZipEntry[], when = new Date()): Blob {
  return new Blob(zipParts(entries, when) as BlobPart[], { type: "application/zip" });
}

/**
 * Read a STORE-only archive back (what zipParts writes), checking each entry's CRC: for tests, and for anyone
 * checking a package without unzip.
 */
export function readStoredZip(bytes: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dec = new TextDecoder();
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i--)
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  if (eocd < 0) throw new Error("not a zip archive");
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const out = new Map<string, Uint8Array>();
  for (let n = 0; n < count; n++) {
    if (view.getUint32(p, true) !== 0x02014b50) throw new Error("bad central directory");
    if (view.getUint16(p + 10, true) !== 0) throw new Error("only stored entries are read");
    const crc = view.getUint32(p + 16, true);
    const size = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const skip = view.getUint16(p + 30, true) + view.getUint16(p + 32, true);
    const local = view.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const data = bytes.subarray(start, start + size);
    if (crc32(data) !== crc) throw new Error(`CRC mismatch in ${name}`);
    out.set(name, data);
    p += 46 + nameLen + skip;
  }
  return out;
}
