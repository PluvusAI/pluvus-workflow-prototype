import { Router } from "express";
import type { Request, Response } from "express";
import multer from "multer";
import { saveUploadedFile } from "../storage/localFileStorage.js";

// ---------------------------------------------------------------------------
// Uploads (Phase 16 — Content Brief)
// ---------------------------------------------------------------------------
// POST /uploads — accepts a single multipart file field named "file", stores it
// via the local file-storage seam, and returns the reference the builder should
// persist in node config. This is the ONLY place the raw bytes touch the API;
// the workflow architecture only ever sees the returned reference string.
//
// Kept deliberately generic (not "brief-specific") so the same endpoint can back
// any future brand upload. Swap localFileStorage for a cloud backend and this
// route is unchanged.

const router = Router();

// In-memory storage: the file lands in req.file.buffer, which we hand to the
// storage seam. For the prototype's small PDFs this avoids a temp-file dance;
// the 10 MB cap keeps memory bounded. A cloud backend would stream instead.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB — plenty for a brief PDF.
});

// MED-S3: content-type is proven by MAGIC BYTES, never by the extension or
// mimetype (both attacker/browser-controlled). Without a content check an
// unvalidated file (an HTML page, a script, garbage) named ".pdf"/".png" could
// be stored and later EMAILED to creators or rendered as the brand's asset.
//
// PLU-139 (B): the same generic /uploads route now backs brand-asset uploads
// (logo, supporting materials) as well as the brief PDF, so it accepts the
// common image types in addition to PDF. Each is gated on its real signature.
// SVG is deliberately NOT accepted — it's XML that can carry script; a logo
// upload doesn't need it, and allowing it would reopen the content hole.
const MAGIC: ReadonlyArray<{ label: string; sig: Buffer; offset?: number }> = [
  { label: "pdf", sig: Buffer.from("%PDF-", "latin1") },
  { label: "png", sig: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
  { label: "jpg", sig: Buffer.from([0xff, 0xd8, 0xff]) },
  { label: "gif", sig: Buffer.from("GIF8", "latin1") },
  { label: "webp", sig: Buffer.from("WEBP", "latin1"), offset: 8 }, // RIFF....WEBP
];

/** True when the buffer begins (at `offset`) with `sig`. */
function startsWith(buffer: Buffer, sig: Buffer, offset = 0): boolean {
  return (
    buffer.length >= offset + sig.length &&
    buffer.subarray(offset, offset + sig.length).equals(sig)
  );
}

/** True when the file's bytes actually begin with the %PDF- signature. */
export function hasPdfMagicBytes(buffer: Buffer): boolean {
  return startsWith(buffer, MAGIC[0]!.sig);
}

/** The detected type by magic bytes, or null if it matches no accepted type. */
export function detectAssetType(buffer: Buffer): string | null {
  return MAGIC.find((m) => startsWith(buffer, m.sig, m.offset))?.label ?? null;
}

// POST /uploads — store one PDF and return its reference.
router.post("/", upload.single("file"), async (req: Request, res: Response) => {
  try {
    const file = req.file;
    if (!file) {
      res.status(400).json({ error: "no file provided (expected multipart field 'file')" });
      return;
    }
    if (!detectAssetType(file.buffer)) {
      res.status(400).json({ error: "only PDF or image (PNG/JPG/GIF/WebP) files are accepted" });
      return;
    }

    const stored = await saveUploadedFile(file.buffer, file.originalname);
    res.status(201).json({
      reference: stored.reference,
      originalName: stored.originalName,
      size: file.size,
    });
  } catch (err) {
    console.error("[uploads] error:", err);
    res.status(500).json({ error: "internal server error" });
  }
});

export default router;
