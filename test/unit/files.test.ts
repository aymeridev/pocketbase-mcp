import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { FilesDir, loadSource, sanitizeFilename, validateSource, withExtension } from "../../src/files.js";

let base: string;
let dir: FilesDir;

beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), "pbmcp-"));
  dir = new FilesDir(path.join(base, "files"));
  await mkdir(dir.root);
});

describe("FilesDir", () => {
  it("reads only inside the folder", async () => {
    await writeFile(path.join(dir.root, "a.txt"), "hi");
    await writeFile(path.join(base, "secret.txt"), "no");
    await symlink(path.join(base, "secret.txt"), path.join(dir.root, "link.txt"));

    expect(await dir.resolveExisting("a.txt")).toMatch(/files[\\/]a\.txt$/);
    await expect(dir.resolveExisting("../secret.txt")).rejects.toThrow(/outside/);
    await expect(dir.resolveExisting(path.join(base, "secret.txt"))).rejects.toThrow(/outside/);
    await expect(dir.resolveExisting("link.txt")).rejects.toThrow(/outside/);
    await expect(dir.resolveExisting("missing.txt")).rejects.toThrow(/not found/);
  });

  it("writes inside the folder without overwriting", async () => {
    await writeFile(path.join(dir.root, "a.png"), "x");
    expect(await dir.resolveForWrite("a.png")).toMatch(/a \(1\)\.png$/);
    expect(await dir.resolveForWrite("sub/b.png")).toMatch(/sub[\\/]b\.png$/);
    await expect(dir.resolveForWrite("../evil.png")).rejects.toThrow(/outside/);
  });
});

describe("loadSource", () => {
  it("requires exactly one source", () => {
    expect(() => validateSource({}, 0)).toThrow(/exactly one/);
    expect(() => validateSource({ url: "http://x", path: "a" }, 0)).toThrow(/exactly one/);
    expect(() => validateSource({ base64: "aGk=" }, 0)).toThrow(/filename/);
    expect(() => validateSource({ base64: "data:text/plain;base64,aGk=" }, 0)).not.toThrow();
  });

  it("reads base64 and data URLs", async () => {
    const plain = await loadSource({ base64: "aGVsbG8=", filename: "note.txt" }, dir);
    expect(plain).toMatchObject({ name: "note.txt", type: "text/plain", size: 5 });
    const dataUrl = await loadSource({ base64: "data:image/png;base64,iVBORw0KGgo=", filename: "pic" }, dir);
    expect(dataUrl).toMatchObject({ name: "pic.png", type: "image/png" });
  });

  it("reads local files", async () => {
    await writeFile(path.join(dir.root, "doc.pdf"), "%PDF-1.4");
    expect(await loadSource({ path: "doc.pdf" }, dir)).toMatchObject({ name: "doc.pdf", type: "application/pdf", size: 8 });
  });

  it("downloads URLs and names the file", async () => {
    const fakeFetch = (async () =>
      new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/jpeg; charset=binary" } })) as unknown as typeof fetch;
    const file = await loadSource({ url: "https://img.example.com/photos/maison%20bleue?w=800" }, dir, fakeFetch);
    expect(file).toMatchObject({ name: "maison bleue.jpg", type: "image/jpeg", size: 3, origin: "https://img.example.com/photos/maison%20bleue?w=800" });
    await expect(loadSource({ url: "file:///etc/passwd" }, dir, fakeFetch)).rejects.toThrow(/http/);
    const notFound = (async () => new Response("no", { status: 404 })) as unknown as typeof fetch;
    await expect(loadSource({ url: "https://x/a.png" }, dir, notFound)).rejects.toThrow(/404/);
  });
});

describe("file names", () => {
  it("sanitizes and adds extensions", () => {
    expect(sanitizeFilename("../../etc/pass wd")).toBe("pass wd");
    expect(sanitizeFilename("a<b>.png")).toBe("a_b_.png");
    expect(sanitizeFilename("...")).toBe("file");
    expect(withExtension("photo", "image/jpeg")).toBe("photo.jpg");
    expect(withExtension("photo.webp", "image/png")).toBe("photo.webp");
  });
});
