// Derived files in the Origin Private File System (spec §8.1): /m/<hash>/thumb.webp, proxy.webp,
// analysis-size proxies, and later depth and mattes. Falls back to IndexedDB blobs where OPFS is
// unavailable (Safari private mode, old browsers).
import { blobDb } from "./db";

let root: FileSystemDirectoryHandle | null | undefined;

async function dir(): Promise<FileSystemDirectoryHandle | null> {
  if (root !== undefined) return root;
  try {
    root = await navigator.storage.getDirectory();
  } catch {
    root = null;
  }
  return root;
}

export async function opfsAvailable(): Promise<boolean> { return !!(await dir()); }

async function mediaDir(hash: string, create: boolean): Promise<FileSystemDirectoryHandle | null> {
  const r = await dir();
  if (!r) return null;
  try {
    const m = await r.getDirectoryHandle("m", { create });
    return await m.getDirectoryHandle(hash, { create });
  } catch {
    return null;
  }
}

export async function putFile(hash: string, name: string, blob: Blob): Promise<void> {
  const d = await mediaDir(hash, true);
  if (!d) { await blobDb.put(`${hash}/${name}`, blob); return; }
  const f = await d.getFileHandle(name, { create: true });
  const w = await f.createWritable();
  await w.write(blob);
  await w.close();
}

export async function getFile(hash: string, name: string): Promise<Blob | null> {
  const d = await mediaDir(hash, false);
  if (!d) return (await blobDb.get(`${hash}/${name}`)) ?? null;
  try {
    const f = await d.getFileHandle(name);
    return await f.getFile();
  } catch {
    return null;
  }
}

export async function removeMedia(hash: string): Promise<void> {
  const r = await dir();
  if (!r) { await blobDb.removePrefix(hash + "/"); return; }
  try {
    const m = await r.getDirectoryHandle("m");
    await m.removeEntry(hash, { recursive: true });
  } catch { /* already gone */ }
}

export async function clearAll(): Promise<void> {
  const r = await dir();
  if (r) { try { await r.removeEntry("m", { recursive: true }); } catch { /* none */ } }
  await blobDb.clear();
}

export async function storageEstimate(): Promise<{ usage: number; quota: number; persisted: boolean }> {
  const e = await navigator.storage.estimate?.();
  const persisted = (await navigator.storage.persisted?.()) ?? false;
  return { usage: e?.usage ?? 0, quota: e?.quota ?? 0, persisted };
}

export async function requestPersist(): Promise<boolean> {
  try { return (await navigator.storage.persist?.()) ?? false; } catch { return false; }
}
