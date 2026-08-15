/**
 * Unit tests for the /uploads content validation (MED-S3). Pure — no Express, no
 * multer, no disk. Verifies the %PDF- magic-byte check that stops a non-PDF file
 * (named ".pdf") from being stored and later emailed to creators as the brief.
 * Run:  npx tsx src/routes/uploads.test.ts
 */

import assert from "node:assert/strict";
import { hasPdfMagicBytes, detectAssetType } from "./uploads.js";

let n = 0;
function test(name: string, fn: () => void): void {
  fn();
  n++;
  console.log(`  ✓ ${name}`);
}

console.log("\nuploads.hasPdfMagicBytes (MED-S3)\n");

test("accepts a real PDF header (%PDF-1.7)", () => {
  const buf = Buffer.from("%PDF-1.7\n%âãÏÓ\n1 0 obj", "latin1");
  assert.equal(hasPdfMagicBytes(buf), true);
});

test("accepts the bare 5-byte signature", () => {
  assert.equal(hasPdfMagicBytes(Buffer.from("%PDF-", "latin1")), true);
});

test("rejects HTML disguised as a PDF", () => {
  const buf = Buffer.from("<!DOCTYPE html><html>gotcha</html>", "utf8");
  assert.equal(hasPdfMagicBytes(buf), false);
});

test("rejects a file with %PDF- NOT at offset 0", () => {
  // A leading junk byte before the header is not a valid PDF start.
  const buf = Buffer.from(" %PDF-1.4", "latin1");
  assert.equal(hasPdfMagicBytes(buf), false);
});

test("rejects an empty buffer", () => {
  assert.equal(hasPdfMagicBytes(Buffer.alloc(0)), false);
});

test("rejects a too-short buffer that only partially matches", () => {
  assert.equal(hasPdfMagicBytes(Buffer.from("%PD", "latin1")), false);
});

test("rejects a similar-but-wrong signature", () => {
  assert.equal(hasPdfMagicBytes(Buffer.from("%PDX-1.7", "latin1")), false);
});

// PLU-139 (B): detectAssetType gates the widened /uploads (brief PDF + brand
// assets). Same magic-byte principle — extension/mime never trusted.
console.log("\nuploads.detectAssetType (PLU-139 B)\n");

test("detects PDF", () => {
  assert.equal(detectAssetType(Buffer.from("%PDF-1.7\n", "latin1")), "pdf");
});
test("detects PNG by its 8-byte signature", () => {
  assert.equal(
    detectAssetType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00])),
    "png",
  );
});
test("detects JPEG (FF D8 FF)", () => {
  assert.equal(detectAssetType(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), "jpg");
});
test("detects WebP (WEBP at offset 8, after RIFF)", () => {
  const buf = Buffer.concat([
    Buffer.from("RIFF", "latin1"),
    Buffer.from([0, 0, 0, 0]),
    Buffer.from("WEBP", "latin1"),
  ]);
  assert.equal(detectAssetType(buf), "webp");
});
test("rejects HTML disguised as an image", () => {
  assert.equal(detectAssetType(Buffer.from("<svg onload=alert(1)>", "utf8")), null);
});
test("rejects SVG (script-carrying XML — deliberately unaccepted)", () => {
  assert.equal(detectAssetType(Buffer.from('<?xml version="1.0"?><svg', "utf8")), null);
});
test("rejects an empty buffer", () => {
  assert.equal(detectAssetType(Buffer.alloc(0)), null);
});

console.log(`\n${n} passed\n`);
