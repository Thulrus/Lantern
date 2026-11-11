/** Short random ids for projects and slides (not security-relevant). */
export function uid(prefix = ""): string {
  const a = new Uint8Array(8);
  crypto.getRandomValues(a);
  return prefix + Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
}
