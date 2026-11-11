// IndexedDB "lantern" (spec §8.1): projects, media records, analysis results, songs, people.
import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { MediaAnalysis, MediaInfo, MusicAnalysis, Project, SongInfo } from "$lib/planner/types";

export interface MediaRecord { info: MediaInfo; handle?: FileSystemFileHandle; flags: string[]; added: number; hasOriginal: boolean }
export interface AnalysisRecord { key: string; hash: string; stage: string; model: string; params: string; version: number; status: "ok" | "error"; result: unknown; error?: string; updated: number }
export interface SongRecord { info: SongInfo; analysis?: MusicAnalysis; handle?: FileSystemFileHandle }
export interface PersonRecord { id: string; name?: string; faceHashes: string[]; cover: string }

interface Schema extends DBSchema {
  projects: { key: string; value: Project; indexes: { updated: number } };
  media: { key: string; value: MediaRecord };
  analysis: { key: string; value: AnalysisRecord; indexes: { hash: string } };
  songs: { key: string; value: SongRecord };
  people: { key: string; value: PersonRecord };
  blobs: { key: string; value: { key: string; blob: Blob } };
  originals: { key: string; value: { hash: string; blob: Blob } };
}

let dbp: Promise<IDBPDatabase<Schema>> | null = null;

export function db(): Promise<IDBPDatabase<Schema>> {
  dbp ??= openDB<Schema>("lantern", 1, {
    upgrade(d) {
      d.createObjectStore("projects", { keyPath: "id" }).createIndex("updated", "updated");
      d.createObjectStore("media", { keyPath: "info.hash" });
      d.createObjectStore("analysis", { keyPath: "key" }).createIndex("hash", "hash");
      d.createObjectStore("songs", { keyPath: "info.hash" });
      d.createObjectStore("people", { keyPath: "id" });
      d.createObjectStore("blobs", { keyPath: "key" });
      d.createObjectStore("originals", { keyPath: "hash" });
    },
  });
  return dbp;
}

export const projectsDb = {
  async list(): Promise<Project[]> { const d = await db(); const all = await d.getAllFromIndex("projects", "updated"); return all.reverse(); },
  async get(id: string): Promise<Project | undefined> { return (await db()).get("projects", id); },
  async put(p: Project): Promise<void> { await (await db()).put("projects", p); },
  async remove(id: string): Promise<void> { await (await db()).delete("projects", id); },
};

export const mediaDb = {
  async get(hash: string): Promise<MediaRecord | undefined> { return (await db()).get("media", hash); },
  async getMany(hashes: string[]): Promise<Map<string, MediaRecord>> {
    const d = await db(), out = new Map<string, MediaRecord>();
    await Promise.all(hashes.map(async (h) => { const r = await d.get("media", h); if (r) out.set(h, r); }));
    return out;
  },
  async all(): Promise<MediaRecord[]> { return (await db()).getAll("media"); },
  async put(r: MediaRecord): Promise<void> { await (await db()).put("media", r); },
  async remove(hash: string): Promise<void> { await (await db()).delete("media", hash); },
};

export const analysisDb = {
  key: (hash: string, stage: string, model: string, params: string) => `${hash}|${stage}|${model}|${params}`,
  async get(hash: string, stage: string, model: string, params: string): Promise<AnalysisRecord | undefined> {
    return (await db()).get("analysis", analysisDb.key(hash, stage, model, params));
  },
  async forHash(hash: string): Promise<AnalysisRecord[]> { return (await db()).getAllFromIndex("analysis", "hash", hash); },
  async put(r: AnalysisRecord): Promise<void> { await (await db()).put("analysis", r); },
  async clear(): Promise<void> { await (await db()).clear("analysis"); },
  async removeForHash(hash: string): Promise<void> {
    const d = await db();
    for (const r of await d.getAllFromIndex("analysis", "hash", hash)) await d.delete("analysis", r.key);
  },
};

export const songsDb = {
  async get(hash: string): Promise<SongRecord | undefined> { return (await db()).get("songs", hash); },
  async all(): Promise<SongRecord[]> { return (await db()).getAll("songs"); },
  async put(r: SongRecord): Promise<void> { await (await db()).put("songs", r); },
  async remove(hash: string): Promise<void> { await (await db()).delete("songs", hash); },
};

export const peopleDb = {
  async all(): Promise<PersonRecord[]> { return (await db()).getAll("people"); },
  async put(r: PersonRecord): Promise<void> { await (await db()).put("people", r); },
  async remove(id: string): Promise<void> { await (await db()).delete("people", id); },
};

/** Fallback blob store for browsers without OPFS. */
export const blobDb = {
  async put(key: string, blob: Blob): Promise<void> { await (await db()).put("blobs", { key, blob }); },
  async get(key: string): Promise<Blob | undefined> { return (await (await db()).get("blobs", key))?.blob; },
  async removePrefix(prefix: string): Promise<void> {
    const d = await db();
    for (const k of await d.getAllKeys("blobs")) if (k.startsWith(prefix)) await d.delete("blobs", k);
  },
  async clear(): Promise<void> { await (await db()).clear("blobs"); },
};

/** Original files kept for the session's project when the browser has no directory handles
 *  (everything except Chromium): the source for 4K export and video playback. */
export const originalsDb = {
  async put(hash: string, blob: Blob): Promise<void> { await (await db()).put("originals", { hash, blob }); },
  async get(hash: string): Promise<Blob | undefined> { return (await (await db()).get("originals", hash))?.blob; },
  async remove(hash: string): Promise<void> { await (await db()).delete("originals", hash); },
  async clear(): Promise<void> { await (await db()).clear("originals"); },
};

export async function wipeEverything(): Promise<void> {
  const d = await db();
  for (const s of ["projects", "media", "analysis", "songs", "people", "blobs", "originals"] as const) await d.clear(s);
}
