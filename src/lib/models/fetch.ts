// Pinned, checksummed model download with Cache Storage (spec §2.1, §11.3). Rejects HTML
// responses (a redirect to a login or error page) and any file whose SHA-256 differs from the
// registry. Download progress is reported in bytes.
import { modelById, type ModelSpec } from "./registry";

const CACHE = "lantern-models-v1";

export interface ModelStatus { id: string; cached: boolean; bytes: number }

async function sha256(buf: ArrayBuffer): Promise<string> {
  const h = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(h), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function modelStatus(id: string): Promise<ModelStatus> {
  const m = modelById(id);
  if (!m) return { id, cached: false, bytes: 0 };
  try {
    const c = await caches.open(CACHE);
    const r = await c.match(m.url);
    if (!r) return { id, cached: false, bytes: m.bytes };
    const len = Number(r.headers.get("x-lantern-bytes") ?? r.headers.get("content-length") ?? m.bytes);
    return { id, cached: true, bytes: len };
  } catch {
    return { id, cached: false, bytes: m.bytes };
  }
}

export async function deleteModel(id: string): Promise<void> {
  const m = modelById(id);
  if (!m) return;
  try { await (await caches.open(CACHE)).delete(m.url); } catch { /* no cache */ }
}

/** The model's bytes, from the cache or the network (verified, then cached). */
export async function fetchModel(id: string, onProgress?: (done: number, total: number) => void): Promise<ArrayBuffer> {
  const m = modelById(id);
  if (!m) throw new Error(`unknown model ${id}`);
  let cache: Cache | null = null;
  try { cache = await caches.open(CACHE); } catch { cache = null; }
  const hit = await cache?.match(m.url);
  if (hit) {
    const buf = await hit.arrayBuffer();
    if (!m.sha256 || (await sha256(buf)) === m.sha256) return buf;
    await cache?.delete(m.url);
  }
  const buf = await download(m, onProgress);
  const digest = await sha256(buf);
  if (m.sha256 && digest !== m.sha256) throw new Error(`${m.name}: checksum mismatch (expected ${m.sha256.slice(0, 12)}…, got ${digest.slice(0, 12)}…)`);
  if (cache) {
    const headers = new Headers({ "content-type": "application/octet-stream", "x-lantern-bytes": String(buf.byteLength), "x-lantern-sha256": digest });
    await cache.put(m.url, new Response(buf.slice(0), { headers }));
  }
  return buf;
}

async function download(m: ModelSpec, onProgress?: (done: number, total: number) => void): Promise<ArrayBuffer> {
  const res = await fetch(m.url, { mode: "cors", credentials: "omit" });
  if (!res.ok) throw new Error(`${m.name}: HTTP ${res.status}`);
  const type = res.headers.get("content-type") ?? "";
  if (type.includes("text/html")) throw new Error(`${m.name}: the model host returned a web page instead of the file`);
  const total = Number(res.headers.get("content-length") ?? m.bytes);
  if (!res.body) return res.arrayBuffer();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let done = 0;
  for (;;) {
    const { value, done: end } = await reader.read();
    if (end) break;
    chunks.push(value); done += value.byteLength;
    onProgress?.(done, total);
  }
  const out = new Uint8Array(done);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.byteLength; }
  return out.buffer;
}

/** A same-origin blob URL for libraries that load a model by URL (MediaPipe). */
export async function modelBlobUrl(id: string, onProgress?: (done: number, total: number) => void): Promise<string> {
  const buf = await fetchModel(id, onProgress);
  return URL.createObjectURL(new Blob([buf], { type: "application/octet-stream" }));
}
