// Import state shared by the start screen and the editor's library drawer.
import { importFiles, type ImportProgress } from "./import";
import { app } from "$lib/store/project.svelte";

class Importer {
  progress = $state<ImportProgress | null>(null);
  running = $state(false);

  async run(files: { file: File; handle?: FileSystemFileHandle }[]): Promise<{ media: string[]; songs: string[] }> {
    if (!files.length) return { media: [], songs: [] };
    this.running = true;
    try {
      const q = app.ensureQueue();
      const r = await importFiles(files, q, (p) => (this.progress = p));
      if (r.errors.length) app.say(`${r.errors.length} file${r.errors.length > 1 ? "s" : ""} could not be imported: ${r.errors[0].name} (${r.errors[0].error})`, 6000);
      return r;
    } finally {
      this.running = false;
      this.progress = null;
    }
  }
}

export const importer = new Importer();
