import { lstat, mkdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  heic: "image/heic",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  html: "text/html",
  css: "text/css",
  js: "text/javascript",
  json: "application/json",
  xml: "application/xml",
  yaml: "application/yaml",
  yml: "application/yaml",
  zip: "application/zip",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

/** Image types MCP clients can show to the model directly. */
export const INLINE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** Largest file returned inline to the model; bigger files are saved to disk instead. */
export const MAX_INLINE_BYTES = 5 * 1024 * 1024;

/** Largest file fetched from a URL for an upload. */
export const MAX_FETCH_BYTES = 100 * 1024 * 1024;

export function mimeFromName(name: string): string | undefined {
  const ext = path.extname(name).slice(1).toLowerCase();
  return MIME_BY_EXT[ext];
}

export function extFromMime(mime: string): string | undefined {
  const base = mime.split(";")[0].trim().toLowerCase();
  if (base === "image/jpeg") return "jpg";
  return Object.keys(MIME_BY_EXT).find((ext) => MIME_BY_EXT[ext] === base);
}

export function isTextType(mime: string): boolean {
  return (
    mime.startsWith("text/") ||
    ["application/json", "application/xml", "application/yaml", "image/svg+xml", "application/javascript"].includes(mime)
  );
}

/** Keeps only the base name and strips characters that are awkward in file names. */
export function sanitizeFilename(name: string): string {
  const base = path.basename(name.replace(/\\/g, "/"));
  const cleaned = base.replace(/[^\w.\- ]+/g, "_").replace(/^\.+/, "").trim();
  return cleaned || "file";
}

/** Adds an extension derived from the MIME type when the name has none. */
export function withExtension(name: string, mime: string): string {
  if (path.extname(name)) return name;
  const ext = extFromMime(mime);
  return ext ? `${name}.${ext}` : name;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * The only local folder the server reads uploads from and saves downloads to,
 * so the model cannot touch arbitrary files on the machine.
 */
export class FilesDir {
  constructor(readonly root: string) {}

  private async realRoot(): Promise<string> {
    await mkdir(this.root, { recursive: true });
    return realpath(this.root);
  }

  private inside(root: string, target: string): boolean {
    return target === root || target.startsWith(root + path.sep);
  }

  /** Resolves an existing file for reading; relative paths are taken from the folder. */
  async resolveExisting(p: string): Promise<string> {
    const root = await this.realRoot();
    let target: string;
    try {
      target = await realpath(path.resolve(root, p));
    } catch {
      throw new Error(`File not found: ${p} (files are read from ${this.root})`);
    }
    if (!this.inside(root, target)) {
      throw new Error(`${p} is outside the allowed folder ${this.root} (PB_FILES_DIR)`);
    }
    if (!(await stat(target)).isFile()) throw new Error(`${p} is not a file`);
    return target;
  }

  /** Resolves where to save a new file, creating folders and never overwriting an existing file. */
  async resolveForWrite(p: string): Promise<string> {
    const root = await this.realRoot();
    const wanted = path.resolve(root, p);
    if (!this.inside(root, wanted) || wanted === root) {
      throw new Error(`${p} is outside the allowed folder ${this.root} (PB_FILES_DIR)`);
    }
    await mkdir(path.dirname(wanted), { recursive: true });
    const parent = await realpath(path.dirname(wanted));
    if (!this.inside(root, parent)) {
      throw new Error(`${p} is outside the allowed folder ${this.root} (PB_FILES_DIR)`);
    }
    const ext = path.extname(wanted);
    const stem = path.basename(wanted, ext);
    for (let i = 0; ; i++) {
      const candidate = path.join(parent, i === 0 ? `${stem}${ext}` : `${stem} (${i})${ext}`);
      try {
        await lstat(candidate);
      } catch {
        return candidate;
      }
    }
  }
}

export interface FileSource {
  path?: string;
  url?: string;
  base64?: string;
  filename?: string;
}

export interface LoadedFile {
  name: string;
  type: string;
  size: number;
  data: Buffer;
  origin: string;
}

export function validateSource(src: FileSource, index: number): void {
  const given = [src.path, src.url, src.base64].filter((v) => v !== undefined && v !== "").length;
  if (given !== 1) {
    throw new Error(`File #${index}: set exactly one of path, url or base64`);
  }
  if (src.base64 !== undefined && !src.filename && !src.base64.startsWith("data:")) {
    throw new Error(`File #${index}: filename is required with base64 content`);
  }
}

async function readLimited(response: Response, limit: number): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length"));
  if (declared > limit) throw new Error(`File is larger than ${formatBytes(limit)}`);
  if (!response.body) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new Error(`File is larger than ${formatBytes(limit)}`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

function filenameFromDisposition(header: string | null): string | undefined {
  if (!header) return undefined;
  const star = /filename\*=(?:UTF-8'')?([^;]+)/i.exec(header);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ""));
    } catch {
      // fall through to the plain filename
    }
  }
  return /filename="?([^";]+)"?/i.exec(header)?.[1];
}

/** Reads a file to upload from the local folder, a URL, or inline base64 / data URL content. */
export async function loadSource(src: FileSource, dir: FilesDir, fetchImpl: typeof fetch = fetch): Promise<LoadedFile> {
  let data: Buffer;
  let name: string;
  let type: string | undefined;
  let origin: string;

  if (src.path) {
    const file = await dir.resolveExisting(src.path);
    data = await readFile(file);
    name = src.filename ?? path.basename(file);
    origin = file;
  } else if (src.url) {
    let url: URL;
    try {
      url = new URL(src.url);
    } catch {
      throw new Error(`Invalid URL: ${src.url}`);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error(`Only http(s) URLs are supported: ${src.url}`);
    }
    const response = await fetchImpl(url, { redirect: "follow" });
    if (!response.ok) throw new Error(`Download failed: HTTP ${response.status} for ${src.url}`);
    data = await readLimited(response, MAX_FETCH_BYTES);
    const header = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
    if (header && header !== "application/octet-stream") type = header;
    const fromUrl = decodeURIComponent(path.posix.basename(new URL(response.url || url).pathname));
    name = src.filename ?? filenameFromDisposition(response.headers.get("content-disposition")) ?? (fromUrl || "download");
    origin = src.url;
  } else {
    let content = src.base64 ?? "";
    const dataUrl = /^data:([^;,]+)?(?:;[^,]*)?;base64,/i.exec(content);
    if (dataUrl) {
      type = dataUrl[1]?.toLowerCase();
      content = content.slice(dataUrl[0].length);
    }
    data = Buffer.from(content, "base64");
    name = src.filename ?? "file";
    origin = "inline content";
  }

  type ??= mimeFromName(name) ?? "application/octet-stream";
  name = withExtension(sanitizeFilename(name), type);
  if (data.length === 0) throw new Error(`${name} is empty`);
  return { name, type, size: data.length, data, origin };
}
