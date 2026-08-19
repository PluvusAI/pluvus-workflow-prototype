import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

// ---------------------------------------------------------------------------
// Local file storage (Phase 16 — Content Brief)
// ---------------------------------------------------------------------------
// The single, swappable seam for persisting brand-uploaded files (currently the
// Campaign Brief PDF). It stores bytes on the local disk under an `uploads/`
// directory and returns a stable REFERENCE string; only that reference is ever
// persisted in node config — never the bytes.
//
// Intentionally tiny and dependency-free so it can be replaced by an S3 / GCS
// backend later WITHOUT touching the workflow engine, the executor, or the node
// config shape: swap the three functions below (save / read / originalName) for a
// cloud implementation and the reference simply becomes an object key. Nothing
// upstream cares whether the reference points at a local path or a bucket key.

/** Absolute path to the uploads directory (override with UPLOADS_DIR). */
export function uploadsDir(): string {
  const configured = process.env["UPLOADS_DIR"];
  if (configured && configured.trim()) return path.resolve(configured.trim());
  // Default: <server>/uploads. cwd is the server package root in dev/prod.
  return path.resolve(process.cwd(), "uploads");
}

// A stored reference is an opaque, prototype-local id: the on-disk filename. It
// deliberately contains no directory separators so it can never escape the
// uploads dir, and it embeds the original filename's extension so the resolved
// path is a real ".pdf" for the email attachment. A future cloud backend would
// return an object key here instead — the shape upstream depends on is just
// "an opaque string you can hand back to readFile/resolve".
export interface StoredFile {
  /** The reference persisted in node config (filename within the uploads dir). */
  reference: string;
  /** The uploader-supplied original filename, kept for display + attachment. */
  originalName: string;
}

/**
 * Persist an uploaded file's bytes and return its reference + original name.
 *
 * The reference is a random, unguessable filename (so two uploads of the same
 * name never collide) preserving the source extension.
 */
export async function saveUploadedFile(
  buffer: Buffer,
  originalName: string,
): Promise<StoredFile> {
  const dir = uploadsDir();
  await mkdir(dir, { recursive: true });
  const ext = path.extname(originalName) || "";
  const reference = `${randomUUID()}${ext}`;
  await writeFile(path.join(dir, reference), buffer);
  return { reference, originalName };
}

/** Resolve a stored reference to an absolute path inside the uploads dir. */
export function resolveStoredFile(reference: string): string {
  // basename() strips any path components a malicious reference might carry, so
  // the result is always confined to the uploads directory.
  return path.join(uploadsDir(), path.basename(reference));
}

/** Read a stored file's bytes by reference. Throws if the file is missing. */
export async function readStoredFile(reference: string): Promise<Buffer> {
  return readFile(resolveStoredFile(reference));
}

/**
 * PLU-142 review fix: a DB row claiming `renderedAssetRef` is set is not
 * proof the bytes are still retrievable — the uploads dir can be wiped by a
 * container/host restart independently of the DB. Callers that are about to
 * declare a stored reference "safe to serve" should check this first rather
 * than discover the gap via a thrown error at read time. Any stat failure
 * (missing file, permissions, etc.) is treated as "not available" — the
 * caller's job is deciding what to do about that (e.g. regenerate), not
 * distinguishing failure modes here.
 */
export async function storedFileExists(reference: string): Promise<boolean> {
  try {
    await access(resolveStoredFile(reference));
    return true;
  } catch {
    return false;
  }
}

/**
 * Delete a stored file by reference. Missing files are NOT an error: discarding
 * an import draft must succeed even if the file was already swept, and callers
 * should never have to distinguish "gone" from "never existed".
 */
export async function deleteStoredFile(reference: string): Promise<void> {
  try {
    await unlink(resolveStoredFile(reference));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}
