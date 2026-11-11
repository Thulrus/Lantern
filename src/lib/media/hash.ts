// Content identity (spec §4.1): xxh3-64 of the file's bytes, so re-imports and renames keep
// their analysis. Streams the file so large videos don't need to sit in memory.
import xxhash from "xxhash-wasm";

let api: Awaited<ReturnType<typeof xxhash>> | null = null;

export async function hashFile(file: Blob): Promise<string> {
  api ??= await xxhash();
  const h = api.create64();
  const reader = file.stream().getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    h.update(value);
  }
  return h.digest().toString(16).padStart(16, "0");
}

export async function hashBytes(bytes: Uint8Array): Promise<string> {
  api ??= await xxhash();
  return api.h64Raw(bytes).toString(16).padStart(16, "0");
}
