// .lantern project packages (spec §8.1): one zip that moves a show to another browser or machine.
//
//   lantern.json                 manifest: format, version, options, the project, media and song records
//   analysis.json                analysis records (basics always; faces, depth and fill with "analysis")
//   files/<hash>/<name>          derived files: thumbnails and proxies always, depth, mattes and plates with "analysis"
//   originals/<hash>             the original photo, video or song with "originals"
//
// Without originals the show still opens and plays from the proxies (photos at 2560 px, songs
// silent). Importing never overwrites what the browser already has for the same content hash.
import type { MediaInfo, MusicAnalysis, Project, SongInfo } from "$lib/planner/types";
import { analysisDb, mediaDb, originalsDb, projectsDb, songsDb, type AnalysisRecord } from "./db";
import { getFile, listFiles, putFile } from "./opfs";
import { readZip, writeZip, type ZipEntry } from "./zip";
import { uid } from "$lib/util/id";

export const PACKAGE_FORMAT = "lantern-package";
export const PACKAGE_VERSION = 1;
export const PACKAGE_EXT = ".lantern";

/** Derived files every package carries: enough to show and play the slides. */
const BASIC_FILES = new Set(["thumb.webp", "proxy.webp", "analysis.webp"]);
/** Debug leftovers that never travel. */
const SKIP_FILES = new Set(["plategen.rejected.webp"]);

export interface PackageOptions { analysis: boolean; originals: boolean }

interface Manifest {
  format: typeof PACKAGE_FORMAT; v: number; created: number; options: PackageOptions;
  project: Project;
  media: { info: MediaInfo; flags: string[]; added: number; original: boolean }[];
  songs: { info: SongInfo; analysis?: MusicAnalysis; original: boolean }[];
}

export interface PackageReport { blob: Blob; fileName: string; missingOriginals: string[] }

const safeName = (s: string) => (s.trim() || "Lantern show").replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").slice(0, 80);

/** Collect a project into a package. onProgress gets a share done (0–1) and a short step text. */
export async function buildPackage(project: Project, opts: PackageOptions, onProgress?: (share: number, step: string) => void): Promise<PackageReport> {
  const entries: ZipEntry[] = [];
  const media: Manifest["media"] = [], songs: Manifest["songs"] = [], records: AnalysisRecord[] = [];
  const missingOriginals: string[] = [];
  const hashes = project.media;
  for (const [i, hash] of hashes.entries()) {
    onProgress?.(0.5 * (i / Math.max(hashes.length, 1)), "Collecting photos and analysis");
    const rec = await mediaDb.get(hash);
    if (!rec) continue;
    for (const r of await analysisDb.forHash(hash)) if (r.status === "ok" && (opts.analysis || r.stage === "basics")) records.push(r);
    for (const name of await listFiles(hash)) {
      if (SKIP_FILES.has(name) || (!opts.analysis && !BASIC_FILES.has(name))) continue;
      const b = await getFile(hash, name);
      if (b) entries.push({ name: `files/${hash}/${name}`, data: b });
    }
    let original = false;
    if (opts.originals) {
      let b: Blob | null = (await originalsDb.get(hash)) ?? null;
      if (!b && rec.handle) { try { b = await rec.handle.getFile(); } catch { b = null; } }   // permission may have lapsed
      if (b) { entries.push({ name: `originals/${hash}`, data: b }); original = true; } else missingOriginals.push(rec.info.name);
    }
    media.push({ info: rec.info, flags: rec.flags, added: rec.added, original });
  }
  for (const ref of project.songs) {
    const rec = await songsDb.get(ref.hash);
    if (!rec) continue;
    let original = false;
    if (opts.originals) {
      const b = (await originalsDb.get(ref.hash)) ?? (rec.handle ? await rec.handle.getFile().catch(() => null) : null);
      if (b) { entries.push({ name: `originals/${ref.hash}`, data: b }); original = true; } else missingOriginals.push(rec.info.name);
    }
    songs.push({ info: rec.info, analysis: rec.analysis, original });
  }
  const manifest: Manifest = { format: PACKAGE_FORMAT, v: PACKAGE_VERSION, created: Date.now(), options: opts, project, media, songs };
  entries.unshift({ name: "lantern.json", data: new Blob([JSON.stringify(manifest)], { type: "application/json" }) }, { name: "analysis.json", data: new Blob([JSON.stringify(records)], { type: "application/json" }) });
  const blob = await writeZip(entries, (done, total) => onProgress?.(0.5 + 0.5 * (done / Math.max(total, 1)), "Writing the package"));
  onProgress?.(1, "Done");
  return { blob, fileName: safeName(project.title) + PACKAGE_EXT, missingOriginals };
}

export interface ImportedPackage { projectId: string; media: number; songs: number; originals: number; analysis: boolean }

/** Read a package into this browser and return the new project's id. The project keeps its id
 *  unless one with that id exists already (the same show imported twice): then it gets a new id
 *  and "(copy)" in its title. */
export async function importPackage(file: Blob, onProgress?: (share: number, step: string) => void): Promise<ImportedPackage> {
  const zip = await readZip(file);
  const mf = zip.get("lantern.json");
  if (!mf) throw new Error("This is not a Lantern package (lantern.json is missing).");
  let m: Manifest;
  try { m = JSON.parse(await mf.text()) as Manifest; } catch { throw new Error("The package's lantern.json is damaged."); }
  if (m.format !== PACKAGE_FORMAT || !m.project) throw new Error("This is not a Lantern package.");
  if (m.v > PACKAGE_VERSION) throw new Error("This package was made by a newer version of Lantern. Reload the page to update, then try again.");
  const records = zip.has("analysis.json") ? (JSON.parse(await zip.get("analysis.json")!.text()) as AnalysisRecord[]) : [];
  let originals = 0;
  for (const [i, it] of m.media.entries()) {
    onProgress?.(0.9 * (i / Math.max(m.media.length, 1)), "Adding photos");
    const hash = it.info.hash;
    const orig = zip.get(`originals/${hash}`);
    const have = await mediaDb.get(hash);
    if (orig) { originals++; if (!(await originalsDb.get(hash))) await originalsDb.put(hash, new Blob([orig], { type: mimeFor(it.info.name) })); }
    if (!have) await mediaDb.put({ info: it.info, flags: it.flags ?? [], added: it.added ?? Date.now(), hasOriginal: !!orig });
    else if (orig && !have.hasOriginal) await mediaDb.put({ ...have, hasOriginal: true });
    const prefix = `files/${hash}/`;
    const present = new Set(await listFiles(hash));
    for (const [name, b] of zip) if (name.startsWith(prefix) && !present.has(name.slice(prefix.length))) await putFile(hash, name.slice(prefix.length), b);
  }
  for (const r of records) if (!(await analysisDb.get(r.hash, r.stage, r.model, r.params))) await analysisDb.put(r);
  onProgress?.(0.92, "Adding songs");
  for (const s of m.songs) {
    const orig = zip.get(`originals/${s.info.hash}`);
    if (orig) { originals++; if (!(await originalsDb.get(s.info.hash))) await originalsDb.put(s.info.hash, new Blob([orig], { type: mimeFor(s.info.name) })); }
    const have = await songsDb.get(s.info.hash);
    if (!have?.analysis) await songsDb.put({ ...have, info: s.info, analysis: s.analysis ?? have?.analysis });
  }
  const p: Project = { ...m.project, updated: Date.now() };
  if (await projectsDb.get(p.id)) { p.id = uid("p"); p.title = `${p.title} (copy)`; }
  await projectsDb.put(p);
  onProgress?.(1, "Done");
  return { projectId: p.id, media: m.media.length, songs: m.songs.length, originals, analysis: m.options?.analysis ?? false };
}

function mimeFor(name: string): string {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  const map: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", avif: "image/avif", gif: "image/gif", heic: "image/heic", heif: "image/heif", bmp: "image/bmp",
    mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime", webm: "video/webm", mkv: "video/x-matroska",
    mp3: "audio/mpeg", m4a: "audio/mp4", aac: "audio/aac", wav: "audio/wav", flac: "audio/flac", ogg: "audio/ogg", opus: "audio/ogg", oga: "audio/ogg", weba: "audio/webm" };
  return map[ext] ?? "";
}

/** Save a package with the save picker where there is one, else as a download. */
export async function savePackage(r: PackageReport): Promise<void> {
  const w = window as unknown as { showSaveFilePicker?: (o: unknown) => Promise<FileSystemFileHandle> };
  if (w.showSaveFilePicker) {
    let h: FileSystemFileHandle;
    try { h = await w.showSaveFilePicker({ suggestedName: r.fileName, types: [{ description: "Lantern project", accept: { "application/zip": [PACKAGE_EXT] } }] }); }
    catch (e) { if ((e as DOMException).name === "AbortError") throw e; return download(r); }
    const s = await h.createWritable();
    await s.write(r.blob); await s.close();
    return;
  }
  download(r);
}

function download(r: PackageReport): void {
  const url = URL.createObjectURL(r.blob);
  const a = document.createElement("a"); a.href = url; a.download = r.fileName; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
