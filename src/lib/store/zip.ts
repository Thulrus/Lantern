// A minimal zip for .lantern project packages (spec §8.1): entries are stored, not compressed
// (photos, videos, songs and WebP proxies are compressed already; the JSON is small), names are
// UTF-8, and the archive is built from Blob slices, so nothing large is copied into memory.
// Reading handles only stored entries without zip64, which is all the writer produces.

const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();

export function crc32(data: Uint8Array, crc = 0): number {
  let c = ~crc >>> 0;
  for (let i = 0; i < data.length; i++) c = TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

async function crcBlob(b: Blob): Promise<number> {
  let crc = 0;
  const CHUNK = 8 << 20;
  for (let o = 0; o < b.size; o += CHUNK) crc = crc32(new Uint8Array(await b.slice(o, o + CHUNK).arrayBuffer()), crc);
  return crc;
}

/** The writer refuses archives past this size (no zip64). */
export const ZIP_MAX = 0xffffffff;

export interface ZipEntry { name: string; data: Blob }

/** Build a stored zip from the entries. onProgress gets bytes checksummed so far and the total. */
export async function writeZip(entries: ZipEntry[], onProgress?: (done: number, total: number) => void): Promise<Blob> {
  const enc = new TextEncoder();
  const total = entries.reduce((s, e) => s + e.data.size, 0);
  const parts: BlobPart[] = [], central: Uint8Array[] = [];
  let offset = 0, done = 0;
  for (const e of entries) {
    const name = enc.encode(e.name), size = e.data.size;
    const crc = await crcBlob(e.data);
    done += size; onProgress?.(done, total);
    const local = new Uint8Array(30 + name.length), lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, 0x0800, true);  // version, flags: UTF-8 names
    lv.setUint16(8, 0, true); lv.setUint32(10, 0x00210000, true);                                    // stored; 1980-01-01 00:00
    lv.setUint32(14, crc, true); lv.setUint32(18, size, true); lv.setUint32(22, size, true);
    lv.setUint16(26, name.length, true); lv.setUint16(28, 0, true);
    local.set(name, 30);
    const cen = new Uint8Array(46 + name.length), cv = new DataView(cen.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true); cv.setUint32(12, 0x00210000, true);
    cv.setUint32(16, crc, true); cv.setUint32(20, size, true); cv.setUint32(24, size, true);
    cv.setUint16(28, name.length, true); cv.setUint32(42, offset, true);
    cen.set(name, 46);
    parts.push(local, e.data); central.push(cen);
    offset += local.length + size;
    if (offset > ZIP_MAX) throw new Error("This package would be larger than 4 GB. Leave out the original files, or split the show.");
  }
  const cdSize = central.reduce((s, c) => s + c.length, 0);
  const end = new Uint8Array(22), ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, entries.length, true); ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true); ev.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end] as BlobPart[], { type: "application/zip" });
}

/** List a zip's entries as lazy slices of the file. Throws on anything the writer would not produce. */
export async function readZip(file: Blob): Promise<Map<string, Blob>> {
  const tailLen = Math.min(file.size, 22 + 0xffff);
  const tail = new Uint8Array(await file.slice(file.size - tailLen).arrayBuffer());
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 0x05 && tail[i + 3] === 0x06) { eocd = i; break; }
  if (eocd < 0) throw new Error("This is not a Lantern package (no zip directory found).");
  const ev = new DataView(tail.buffer, eocd);
  const count = ev.getUint16(10, true), cdSize = ev.getUint32(12, true), cdOff = ev.getUint32(16, true);
  const cd = new DataView(await file.slice(cdOff, cdOff + cdSize).arrayBuffer());
  const dec = new TextDecoder();
  const out = new Map<string, Blob>();
  let p = 0;
  for (let k = 0; k < count; k++) {
    if (cd.getUint32(p, true) !== 0x02014b50) throw new Error("The package's zip directory is damaged.");
    const method = cd.getUint16(p + 10, true), size = cd.getUint32(p + 24, true);
    const nl = cd.getUint16(p + 28, true), xl = cd.getUint16(p + 30, true), cl = cd.getUint16(p + 32, true);
    const off = cd.getUint32(p + 42, true);
    const name = dec.decode(new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nl));
    if (method !== 0) throw new Error(`"${name}" in the package is compressed; Lantern packages store files uncompressed.`);
    const lh = new DataView(await file.slice(off, off + 30).arrayBuffer());
    if (lh.getUint32(0, true) !== 0x04034b50) throw new Error("The package's zip entries are damaged.");
    const start = off + 30 + lh.getUint16(26, true) + lh.getUint16(28, true);
    out.set(name, file.slice(start, start + size));
    p += 46 + nl + xl + cl;
  }
  return out;
}
