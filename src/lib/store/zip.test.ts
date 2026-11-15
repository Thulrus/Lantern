import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, readZip, writeZip } from "./zip";

const text = async (b: Blob) => new TextDecoder().decode(await b.arrayBuffer());

describe("zip", () => {
  it("crc32 matches the reference value", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });

  it("round-trips entries, including UTF-8 names and empty files", async () => {
    const bin = new Uint8Array(70_000).map((_, i) => (i * 31) & 0xff);
    const z = await writeZip([
      { name: "lantern.json", data: new Blob(['{"a":1}']) },
      { name: "files/abc/größe.webp", data: new Blob([bin]) },
      { name: "empty.txt", data: new Blob([]) },
    ]);
    const m = await readZip(z);
    expect([...m.keys()]).toEqual(["lantern.json", "files/abc/größe.webp", "empty.txt"]);
    expect(await text(m.get("lantern.json")!)).toBe('{"a":1}');
    expect(new Uint8Array(await m.get("files/abc/größe.webp")!.arrayBuffer())).toEqual(bin);
    expect(m.get("empty.txt")!.size).toBe(0);
  });

  it("writes archives that unzip accepts", async () => {
    let unzip = true;
    try { execFileSync("unzip", ["-v"], { stdio: "ignore" }); } catch { unzip = false; }
    if (!unzip) return;
    const dir = mkdtempSync(join(tmpdir(), "lantern-zip-"));
    const z = await writeZip([{ name: "a/b.txt", data: new Blob(["hello"]) }, { name: "c.bin", data: new Blob([new Uint8Array([1, 2, 3])]) }]);
    writeFileSync(join(dir, "t.zip"), new Uint8Array(await z.arrayBuffer()));
    execFileSync("unzip", ["-tq", join(dir, "t.zip")]);           // checks every CRC
    execFileSync("unzip", ["-oq", join(dir, "t.zip"), "-d", dir]);
    expect(readFileSync(join(dir, "a/b.txt"), "utf8")).toBe("hello");
  });

  it("rejects files that are not zips", async () => {
    await expect(readZip(new Blob(["not a zip at all"]))).rejects.toThrow(/not a Lantern package/);
  });
});
