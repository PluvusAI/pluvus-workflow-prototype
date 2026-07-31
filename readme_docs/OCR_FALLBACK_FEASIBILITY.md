# OCR Fallback for Scanned Campaign Briefs — Feasibility Comparison

> **STATUS: IMPLEMENTED** (OCRmyPDF + Tesseract, the recommended option below),
> dark behind `BRIEF_OCR_FALLBACK_ENABLED` (default OFF). Change lives in
> `agent/app/brief.py` (`extract_brief_text` → `_ocr_pdf_to_text`); deps in
> `agent/requirements.txt` + `pyproject.toml`; system binaries in
> `agent/replit.nix` + CI; tests in `agent/tests/test_batch5.py`; ops note in
> `DEPLOYMENT.md`. Flag ON is required to activate it; PaddleOCR remains the
> documented next tier if accuracy on complex briefs proves insufficient.

**Context:** PLU-107 PR review comment (founder). The brief parser
(`agent/app/brief.py::extract_brief_text`) uses `pypdf` +
`page.extract_text()`, which only works on PDFs that already carry an **embedded
text layer**. A scanned or image-only campaign brief returns `""` even though
the pages contain readable information — so the whole downstream chain
(`briefKnowledge` → `/draft` context, and the PLU-107 structured parser that
sits on top of it) sees nothing.

**Ask:** evaluate adding OCR as a fallback *only when normal extraction returns
no meaningful text*, and pick the most reliable + cost-effective open-source
option that fits our infrastructure. Founder's initial preference: test
**PaddleOCR** and **OCRmyPDF/Tesseract** first, consider Baidu **Unlimited-OCR**
only if those aren't accurate enough.

**TL;DR recommendation:** ship **OCRmyPDF + Tesseract as the primary fallback**
(cheapest, CPU-native, near-zero warmup, license-clean, drop-in behind the
existing seam), with **PaddleOCR (base PP-OCR pipeline) as an optional
higher-accuracy tier** behind a flag if Tesseract's quality on designed/tabular
briefs proves insufficient. **EasyOCR** is a worse OCRmyPDF (image-only, PyTorch
tax, no layout). **Unlimited-OCR is real and impressive but GPU-mandatory** — it
does not fit our CPU-only Reserved-VM deployment and is out of scope for this
fallback.

---

## 1. Where OCR plugs in (our actual seam)

The integration point is a single Python function, and it already has the exact
fail-soft contract OCR needs:

- `agent/app/brief.py::extract_brief_text(pdf_bytes) -> str` — returns `""`,
  **never raises**, on any parse failure or empty input.
- Exposed as `POST /parse-brief` (`agent/app/routes/negotiate.py:4952`), which
  base64-decodes the PDF and returns `{ "text": ... }`, also fail-soft.
- The TS side (`server/src/engine/executors/briefKnowledge.ts`) reads the stored
  PDF bytes, POSTs them once per campaign, and **caches the result in-process
  keyed by immutable file ref**. It already treats `""` as "no extra knowledge".

**Implication — this is a clean, contained change.** OCR lives entirely inside
`extract_brief_text`:

```python
text = _pypdf_extract(pdf_bytes)          # existing path
if _insufficient(text) and OCR_ENABLED:   # NEW: only when embedded text is empty/thin
    text = _ocr_extract(pdf_bytes)        # NEW: OCR fallback, still returns "" on failure
return _normalize(text)[:max_chars].strip()
```

Everything the founder asked for falls out of this shape for free:

| Requirement | How it's satisfied |
|---|---|
| **OCR only when pypdf produces insufficient text** | The `_insufficient(text)` guard — OCR never runs on normal text PDFs (the common case), so zero added cost/latency there. |
| **Clean integration with `/parse-brief`** | No endpoint/signature change. TS, caching, and the structured parser (PLU-107) are all untouched — they consume the same `{text}`. |
| **Failures keep the empty/parse_failed behavior; never block negotiation** | `_ocr_extract` is wrapped in the same try/except that already guarantees `""` on failure. A missing OCR binary, a timeout, or a bad page all degrade to `""`. |
| **Parse once, not per turn** | The TS-side ref-keyed cache already amortizes it across a multi-round negotiation. OCR cost is paid at most once per brief. |

Because the result is cached per brief and a brief is parsed once per campaign,
**per-document latency matters far more than throughput** — a one-time 5–30s OCR
pass on a scanned brief is acceptable; it is not on a hot path.

---

## 2. The four options, head to head

All figures are the best current (2025–2026) data from official repos/docs
where possible; blog/benchmark numbers are flagged. Numbers are directional —
budget a short local benchmark on a real brief before committing.

| | **OCRmyPDF + Tesseract** | **PaddleOCR (PP-OCR)** | **EasyOCR** | **Unlimited-OCR (Baidu)** |
|---|---|---|---|---|
| License | MPL-2.0 + Apache-2.0 ✅ | Apache-2.0 ✅ | Apache-2.0 ✅ | MIT ✅ |
| **Runs CPU-only** | **Yes (native, CPU-only engine)** | Yes | Yes (`gpu=False`) | **No — NVIDIA GPU/CUDA required** |
| Native PDF input | **Yes** (it's a PDF→PDF tool) | Yes (3.x pipeline, no poppler) | **No** — image-only, needs pdf2image+poppler | Yes (single-pass multi-page) |
| Extra system deps | tesseract-ocr, qpdf (+eng data) | none for 3.x pipeline | poppler-utils (for PDF raster) | CUDA 12.x stack |
| Install/footprint | **~150–300 MB** on slim base | ~200 MB wheel + few-hundred-MB deps + models | torch CPU ~527 MB + weights <1 GB | ~6.7 GB weights + 12 GB VRAM |
| RAM / inference | ~100 MB temp/page (bounded) | ~0.95–2 GB steady ⚠ see 3.x OOM risk | ~1–2 GB | 12 GB VRAM |
| Cold start / warmup | **~0 (no model load)** | ~8–12 s (model load) | ~15–20 s | GPU model load |
| Latency / A4 page (CPU) | ~2–5 s/core | ~1.5–2.5 s | ~7.5–15 s | n/a (GPU) |
| Layout / tables / multi-col | Weak (single-column text is fine) | **Strong** (via PP-Structure add-on) | None (line-level only) | Strong (VLM) |
| Fit for our fallback | ✅ **Best fit** | ✅ Optional accuracy tier | ⚠ Strictly worse than OCRmyPDF here | ❌ Out of scope (GPU) |

### Accuracy by document type (what actually matters for a "get the text out" fallback)

- **Normal text PDFs:** N/A for OCR — pypdf already handles these; the guard
  means OCR never runs. All engines are ~95%+ on the rare clean scan.
- **Scanned PDFs (the target case):** Tesseract 5.x (LSTM) is strong on clean,
  single-column scanned text — exactly what an ordinary scanned brief is.
  PaddleOCR is comparable-to-better and more robust to noise.
- **Image-heavy / designed briefs, tables, multi-column:** this is where
  Tesseract degrades (third-party benchmarks put it well below deep-learning OCR
  on complex layouts; direction is consistent across sources even though exact
  numbers vary). **PaddleOCR's PP-Structure** and VLM models (Unlimited-OCR) win
  here. **But note:** our downstream consumer flattens the text into a
  4000-char advisory `briefKnowledge` blob (and PLU-107's heading/keyword
  tiers) — we are extracting *terms as prose*, not reconstructing table
  geometry. Perfect table-structure recovery is not required; readable text in
  roughly the right reading order is. That materially lowers the accuracy bar
  and favors the cheap option.
- **EasyOCR** has *no* layout analysis (CRAFT+CRNN, line-level only), so it buys
  us nothing over Tesseract on layout while adding the PyTorch tax and a poppler
  dependency. It is dominated by both other CPU options for this job.

---

## 3. Why OCRmyPDF + Tesseract is the primary pick

1. **It matches our seam and our deployment.** CPU-only (agent runs on a Replit
   Reserved VM / Render CPU box — no GPU), invoked as a **subprocess** from
   Python. OCRmyPDF is explicitly *not* thread-safe in-process; subprocess
   invocation from FastAPI is the documented pattern and sidesteps that entirely.
2. **Near-zero warmup.** Tesseract initializes in <0.3 s — no multi-GB model to
   load into a long-lived worker, unlike PaddleOCR (~8–12 s) or EasyOCR
   (~15–20 s). For a fallback that fires occasionally, cold cost dominates, and
   this is the only option with essentially none.
3. **Native "only-OCR-when-needed" at the page level too.** Beyond our own
   `_insufficient()` guard, `ocrmypdf --skip-text` copies pages that already
   have text and OCRs only the image-only pages — a second layer of "don't do
   unnecessary work."
4. **Smallest container impact.** ~150–300 MB on a slim Python base
   (`tesseract-ocr` + `tesseract-ocr-eng` + `qpdf` + pip `ocrmypdf` +
   `pypdfium2`). No PyTorch, no CUDA, no multi-GB weights.
5. **License-clean for a commercial closed-source SaaS.** OCRmyPDF is MPL-2.0
   (file-level copyleft — invoking the unmodified binary imposes no
   source-disclosure on our code); Tesseract is Apache-2.0.
   - **One licensing caveat to action:** OCRmyPDF can rasterize with either
     **Ghostscript (AGPL)** or **pypdfium2 (BSD-style)**. **Prefer pypdfium2** to
     avoid Ghostscript's AGPL network-use clause entirely — it's also a smaller
     image. (Not legal advice; the license facts are verified.)

**Known pain points to design around (all manageable):**

- OCRmyPDF **writes a new PDF** with an invisible text layer; we then re-run
  pypdf on that output. Fine for our read-only extraction — we discard the PDF
  and keep the text. Use `--skip-text` so already-text pages aren't rewritten,
  and handle its non-zero exit codes (e.g. "page already has text") in the
  wrapper as "fall through to pypdf text", not an error.
- **Temp/RAM on huge files:** ~100 MB temp per page. Our briefs are small
  (single-digit pages, capped downstream at 4000 chars anyway), so cap OCR to
  the first N pages and set a per-call timeout — both consistent with the
  existing `MAX_BRIEF_CHARS` cap.
- Language packs are per-language (`tesseract-ocr-eng` for English). Ship the
  language(s) we actually need; each is a few MB.

---

## 4. PaddleOCR as an optional accuracy tier (not the default)

Keep in the back pocket, behind the same flag, if real scanned briefs turn out
to be heavily designed/tabular and Tesseract's output is too garbled to be
useful:

- **Pros:** best CPU accuracy on noisy/complex layouts; PP-Structure adds real
  table/column/reading-order handling; native multi-page PDF input in the 3.x
  pipeline (no poppler needed); Apache-2.0.
- **Cons / de-risk before adopting:**
  - ⚠ **CPU memory regression in 3.x.** An open official issue (#17955) reports
    `predict()` ballooning to tens of GB of RAM → OOM-kill on some model/language
    combos on CPU. **Must** load-test with our exact model + language and set a
    hard container memory cap before trusting it. (2.x used a saner ~1–2 GB but
    is older.)
  - CPU requires **AVX+MKL** wheels (no-AVX hosts unsupported) — verify the
    deploy CPU has AVX.
  - Models **download at runtime** on first use → **pre-bake weights into the
    image** so we don't fetch at boot (and to work in locked-down envs).
  - Pin both `paddleocr` and `paddlepaddle` versions (2.x→3.x had breaking API
    changes).

For plain text extraction we'd use the **base PP-OCR pipeline**, not VL and not
necessarily PP-Structure — lighter, and enough to get readable text out.

---

## 5. Unlimited-OCR (Baidu) — verified, but out of scope

The founder's description checks out on every point (worth stating plainly, since
it's an unusual project): **`baidu/Unlimited-OCR` is real** — an official Baidu
repo (~19k stars), **MIT-licensed**, a ~3B-param **vision-language model** that
does **single-pass multi-page PDF parsing** and scores ~93% on OmniDocBench.

**But its deployment is GPU-mandatory:** documented stack is
`torch`/`transformers` on **CUDA 12.9**, inference examples call `.cuda()`, and a
**12 GB NVIDIA GPU (RTX 3060+) is the stated minimum**. There is **no documented
CPU inference path**, and the weights are ~6.7 GB. This does not fit our CPU-only
Reserved-VM agent, matches the founder's own concern ("too heavy / not
cost-effective for our infrastructure"), and would require standing up GPU
compute purely for scanned-brief OCR — not justified for an occasional fallback.

Revisit only if (a) we later run GPU compute for other reasons, or (b) both CPU
options prove accuracy-insufficient on our real briefs. Otherwise skip.

---

## 6. Recommended rollout

1. **Add the OCR fallback inside `extract_brief_text`**, gated by a dark flag
   (e.g. `BRIEF_OCR_FALLBACK_ENABLED`, default **OFF** — consistent with how
   PLU-107 and PLU-114 shipped) and by an `_insufficient(text)` guard so it only
   fires when pypdf yields empty/thin text. Keep the `""`-on-failure contract.
2. **Primary engine: OCRmyPDF + Tesseract**, invoked as a subprocess with
   `--skip-text`, `--output-type pdf`, pypdfium2 rasterizer, a page cap, and a
   per-call timeout. Re-run pypdf on the OCR'd output to get the text. Add the
   two system packages (`tesseract-ocr`, `tesseract-ocr-eng`, `qpdf`) to the
   agent image and `ocrmypdf`/`pypdfium2` to `requirements.txt` /
   `pyproject.toml` `[ai]`.
3. **Verify on real inputs:** a normal text brief (must be byte-identical output
   — OCR never runs), a genuine scanned brief, and a designed/tabular brief.
   Confirm the flag OFF is a no-op and the container size delta is acceptable.
4. **If accuracy on designed/tabular briefs is insufficient**, add **PaddleOCR
   (base PP-OCR)** as an alternate engine behind the same flag, after
   load-testing the 3.x CPU memory behavior and pinning versions + pre-baking
   weights.
5. **Do not adopt Unlimited-OCR** unless we add GPU compute for other reasons.

This keeps the change small, reversible (dark flag), zero-cost on the common
path (normal text PDFs), and faithful to the existing "a brief we can't read
degrades to no-knowledge, never breaks a negotiation" contract.

---

### Verification notes

- **Verified from official sources:** all four licenses; CPU-only support (or
  lack thereof for Unlimited-OCR); PDF-input behavior of each; OCRmyPDF
  `--skip-text` / new-PDF / not-thread-safe / dependency list; PaddleOCR native
  PDF + AVX/MKL requirement + runtime model download + the 3.x CPU-memory OOM
  issue (#17955); EasyOCR image-only + PyTorch dependence; Unlimited-OCR
  existence/MIT/GPU-requirement.
- **Reported (blogs/benchmarks, directional):** all per-page CPU latency and
  RAM figures, cold-start times, container-size estimates, and cross-engine
  accuracy percentages. Treat as planning numbers; confirm with a local
  benchmark on a real brief before setting any SLA.
- Our own seam facts (`extract_brief_text`, `/parse-brief`, `briefKnowledge.ts`
  caching, the 4000-char cap) are read directly from this repo.
