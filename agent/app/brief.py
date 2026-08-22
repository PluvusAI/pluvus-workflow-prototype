"""HARD-K1 / PLU-107: campaign brief PDF text extraction + structured parsing.

The campaign brief PDF (uploaded by the brand, attached to the Content Brief
email) contains the ground-truth campaign terms — deliverables, usage rights,
payment schedule, exclusivity, attribution — that the negotiation agent
previously had NO structured source for and therefore hallucinated by
construction (see hard.md HARD-K1 / HARD-P2).

This module turns the PDF bytes into plain text so the extracted knowledge can be
threaded into the /draft (and, later, /negotiate) LLM context. The TS engine owns
the file (local storage), so it POSTs the bytes here once per run and threads the
returned text back into campaignContext as `briefKnowledge`. Parsing lives here,
not in TS, because the agent already carries a PDF parser (pypdf) and this keeps
the extraction beside the LLM that consumes it.

PLU-107 (structured brief parsing) adds `parse_brief_structured`, which segments
the SAME per-page text into typed, page-referenced sections with an explicit
top-level status (ok / empty / parse_failed) that finally distinguishes an
*absent* section from a *parse failure* (both collapse to "" today). Segmentation
is deterministic — heading/label matching first, then per-topic keyword-block
inference (no vector DB, no embeddings; that is an explicit non-goal). The flat
blob (`extract_brief_text`) is preserved verbatim as the `flatText` fallback so
the existing drafting path is byte-identical with the feature flag off.
"""

from __future__ import annotations

import io
import logging
import os
import re
from dataclasses import dataclass, field

logger = logging.getLogger("agent.brief")

# Hard cap on the extracted knowledge fed to the model. A brief can be many pages;
# only the first chunk is realistically useful as negotiation context, and an
# unbounded blob would blow a small local model's context window. The TS side
# also treats this as advisory context, not authoritative — the structured
# knowledge fields (usageRights/exclusivity/…) remain the primary source.
MAX_BRIEF_CHARS = 4000

# PLU-107 invariant #3: parsed results are immutable per (fileRef, PARSER_VERSION).
# Bump this whenever the segmentation logic changes so callers keying their cache
# on `${ref}::${PARSER_VERSION}` miss every stale entry and re-parse. Every section
# stamps the version that produced it (invariant #4).
PARSER_VERSION = "brief-parser-v1.1"

# --- OCR fallback (scanned / image-only briefs) ----------------------------
# pypdf's page.extract_text() only sees an EMBEDDED text layer. A brand that
# uploads a scanned or image-only PDF therefore extracts to nothing even though
# the pages carry readable terms — which silently blinds the whole downstream
# chain (briefKnowledge → /draft context, and the PLU-107 structured parser on
# top: it returns status="empty"). When BRIEF_OCR_FALLBACK_ENABLED is on AND the
# embedded-text pass produced no usable pages, we run OCRmyPDF+Tesseract over the
# bytes and re-extract with pypdf. OCR is CPU-only, invoked as a subprocess, and —
# like everything in this module — degrades to "" / no pages on any failure, so a
# brief we still can't read never breaks a negotiation. It never runs on ordinary
# text PDFs (the guard), so the common path pays zero extra cost.
BRIEF_OCR_FALLBACK_ENV = "BRIEF_OCR_FALLBACK_ENABLED"

# Below this many characters of embedded text, treat the pypdf pass as a miss and
# try OCR. A handful of stray glyphs (a page number, a watermark) on an otherwise
# image-only brief shouldn't count as "we read it". Small and conservative — a
# genuine text brief clears this by orders of magnitude.
_OCR_MIN_USEFUL_CHARS = 32

# Cap the pages OCRmyPDF processes: our briefs are short, the output is capped at
# MAX_BRIEF_CHARS anyway, and OCR cost is per-page. Also bounds a pathological
# many-page upload. A page range keeps a giant scan from pinning the worker.
_OCR_MAX_PAGES = 10

# Wall-clock budget for the whole OCR subprocess. OCR is a one-time, off-hot-path
# pass (cached per brief on the TS side), so a generous budget is fine — but it
# must be bounded so a stuck ghostscript/tesseract can't hold the FastAPI worker.
_OCR_TIMEOUT_SECONDS = 120


def _ocr_fallback_enabled() -> bool:
    raw = os.getenv(BRIEF_OCR_FALLBACK_ENV)
    if raw is None or raw.strip() == "":
        return False  # dark by default — opt in explicitly per deploy
    return raw.strip().lower() in {"1", "true", "yes", "on"}


@dataclass
class PageText:
    """One page's extracted text with its 1-based page index. PLU-107 keeps the
    per-page list through extraction so a section's text can be attributed back to
    the page(s) it spans (invariant #4) — the flat blob discards this at ``\\n``.join."""

    page: int  # 1-based
    text: str


class _ExtractFailed(Exception):
    """Internal signal: the PDF could not be parsed at all (bad bytes, no reader).
    Distinct from "parsed OK but no text" so callers can map it to parse_failed
    vs empty (PLU-107 invariant #2)."""


def _extract_pages(pdf_bytes: bytes) -> list[PageText]:
    """Extract per-page text from a PDF, preserving page boundaries.

    Raises ``_ExtractFailed`` when the PDF itself is unreadable (bad bytes, pypdf
    missing, reader construction blew up) — i.e. a genuine parse failure. Returns a
    (possibly empty) page list when the PDF parsed but yielded no text (a scanned /
    image-only PDF) — that is *empty*, not *failed* (PLU-107 §4.3). A single bad
    page is skipped, never fatal.
    """
    if not pdf_bytes:
        # Empty input is "no text", not a parse failure — mirrors the old "" return.
        return []
    try:
        from pypdf import PdfReader  # lazy import: only needed when a brief is parsed
    except Exception as exc:  # pragma: no cover - pypdf is a declared dependency
        logger.warning("brief: pypdf unavailable, skipping extraction: %s", exc)
        raise _ExtractFailed(str(exc)) from exc

    try:
        reader = PdfReader(io.BytesIO(pdf_bytes))
    except Exception as exc:
        logger.warning("brief: PDF parse failed: %s", exc)
        raise _ExtractFailed(str(exc)) from exc

    pages: list[PageText] = []
    for idx, page in enumerate(reader.pages, start=1):
        try:
            text = page.extract_text() or ""
        except Exception:  # a single bad page shouldn't lose the whole brief
            continue
        if not text:
            continue
        pages.append(PageText(page=idx, text=text))
    return pages


def _extract_pages_with_ocr(pdf_bytes: bytes) -> list[PageText]:
    """`_extract_pages`, but with the OCR fallback layered in for scanned briefs.

    Behaves exactly like `_extract_pages` (same raise/return contract) EXCEPT
    that when the embedded-text pass yields no usable pages AND the OCR fallback
    is enabled, it OCRs the bytes and returns the pages extracted from the OCR'd
    PDF. Both `extract_brief_text` and `parse_brief_structured` route through
    this, so a scanned brief is recovered for the flat blob AND the structured
    parse. OCR failure degrades to the original (empty) result — never raises
    beyond what `_extract_pages` already does.
    """
    pages = _extract_pages(pdf_bytes)
    if _pages_are_usable(pages) or not _ocr_fallback_enabled():
        return pages
    ocr_bytes = _ocr_pdf(pdf_bytes)
    if not ocr_bytes:
        return pages  # OCR unavailable / failed → keep the (empty) embedded result
    try:
        return _extract_pages(ocr_bytes)
    except _ExtractFailed:
        return pages


def _pages_are_usable(pages: list[PageText]) -> bool:
    """True when the embedded-text pass produced enough text to skip OCR. A few
    stray glyphs (page number, watermark) on an otherwise image-only brief do not
    count — mirrors the _OCR_MIN_USEFUL_CHARS guard for the flat path."""
    return sum(len(p.text) for p in pages) >= _OCR_MIN_USEFUL_CHARS


def _ocr_pdf(pdf_bytes: bytes) -> bytes:
    """OCR a scanned / image-only PDF, returning the OCR'd PDF *bytes* (with an
    invisible searchable text layer), or b"" on ANY failure.

    Runs OCRmyPDF+Tesseract (CPU-only) as a subprocess. Returns bytes (not text)
    so the caller can feed them back through the normal `_extract_pages` path and
    keep page boundaries for PLU-107's structured parser. Best-effort: a missing
    binary, a timeout, or an unreadable scan all yield b"", so the caller degrades
    to "no extra knowledge" exactly as before.

    Design notes:
      * `--skip-text` copies pages that already have a text layer untouched and
        OCRs only the image-only ones — a second layer of "don't do unnecessary
        work" on top of the caller's empty-pages guard.
      * pypdfium2 is the rasterizer (BSD) — avoids Ghostscript's AGPL.
      * Bounded pages + wall-clock timeout so a giant/pathological scan can't pin
        the worker.
    """
    import shutil
    import subprocess
    import tempfile

    # Cheap availability probe: if the CLI isn't installed, don't spawn — degrade.
    if shutil.which("ocrmypdf") is None:
        logger.warning("brief: OCR fallback enabled but 'ocrmypdf' not on PATH; skipping")
        return b""

    tmpdir = tempfile.mkdtemp(prefix="brief-ocr-")
    in_path = os.path.join(tmpdir, "in.pdf")
    out_path = os.path.join(tmpdir, "out.pdf")
    try:
        with open(in_path, "wb") as fh:
            fh.write(pdf_bytes)

        cmd = [
            "ocrmypdf",
            "--skip-text",            # OCR only image-only pages; keep text pages as-is
            "--optimize", "0",        # no image re-compression — we only want the text layer
            "--output-type", "pdf",   # plain PDF out (no PDF/A validation overhead)
            "--pages", f"1-{_OCR_MAX_PAGES}",
            "--quiet",
            in_path,
            out_path,
        ]
        try:
            proc = subprocess.run(cmd, capture_output=True, timeout=_OCR_TIMEOUT_SECONDS)
        except subprocess.TimeoutExpired:
            logger.warning("brief: OCR timed out after %ss; degrading to no-knowledge", _OCR_TIMEOUT_SECONDS)
            return b""
        except Exception as exc:  # spawn failure, OSError, …
            logger.warning("brief: OCR subprocess failed to run: %s", exc)
            return b""

        # OCRmyPDF can exit non-zero for benign reasons; we only trust an output
        # PDF that exists and is non-empty (otherwise degrade to b"").
        if proc.returncode != 0 or not os.path.exists(out_path) or os.path.getsize(out_path) == 0:
            detail = proc.stderr.decode("utf-8", "replace")[:200] if proc.stderr else ""
            logger.warning("brief: OCR produced no usable output (rc=%s): %s", proc.returncode, detail)
            return b""

        with open(out_path, "rb") as fh:
            return fh.read()
    except Exception as exc:  # pragma: no cover - defensive: any I/O surprise degrades
        logger.warning("brief: OCR fallback errored, returning empty: %s", exc)
        return b""
    finally:
        try:
            import shutil as _sh

            _sh.rmtree(tmpdir, ignore_errors=True)
        except Exception:
            pass


def extract_brief_text(pdf_bytes: bytes, *, max_chars: int = MAX_BRIEF_CHARS) -> str:
    """Extract plain text from a PDF's bytes, normalized and length-capped.

    Returns "" (never raises) on any parse failure or empty input — a brief we
    can't read must degrade to "no extra knowledge", never break a negotiation.

    If the embedded-text pass yields nothing usable and the OCR fallback is
    enabled (BRIEF_OCR_FALLBACK_ENABLED), OCR the bytes and re-extract — this
    recovers scanned / image-only briefs that carry no text layer.
    """
    try:
        pages = _extract_pages_with_ocr(pdf_bytes)
    except _ExtractFailed:
        return ""

    parts: list[str] = []
    total = 0
    for pt in pages:
        parts.append(pt.text)
        total += len(pt.text)
        if total >= max_chars:
            break
    raw = "\n".join(parts)
    return _normalize(raw)[:max_chars].strip()


def _normalize(text: str) -> str:
    """Collapse the ragged whitespace PDF extraction produces into readable prose:
    trim trailing spaces per line, drop blank runs, cap consecutive blank lines."""
    # Normalize newlines and strip per-line trailing whitespace.
    lines = [ln.rstrip() for ln in text.replace("\r\n", "\n").replace("\r", "\n").split("\n")]
    # Collapse >1 blank line into a single blank line.
    out: list[str] = []
    blank = False
    for ln in lines:
        if ln.strip():
            out.append(re.sub(r"[ \t]{2,}", " ", ln))
            blank = False
        elif not blank:
            out.append("")
            blank = True
    return "\n".join(out).strip()


# ---------------------------------------------------------------------------
# PLU-107: structured brief parsing
# ---------------------------------------------------------------------------
# Segment the SAME per-page text `extract_brief_text` reads into typed, page-
# referenced sections. Deterministic only (invariant #8): heading/label matching
# first (high confidence), then per-topic keyword-block inference (lower
# confidence, unmatched blocks preserved in `other[]`). No vector DB, no
# embeddings — that is an explicit non-goal. `parse_brief_structured` always
# returns a status (invariant #2) and always populates `flat_text` so the drafting
# fallback never loses today's capability (invariant #6).


@dataclass
class CampaignBriefSection:
    """One typed section of the brief, with its provenance (invariant #4). Serialized
    to the TS `CampaignBriefSection` shape by the /parse-brief route."""

    type: str  # canonical key, e.g. "usageRights"
    text: str
    source_file_reference: str  # REQUIRED — invariant #4 (stamped by the route)
    parser_version: str  # REQUIRED — invariant #3
    page_start: int | None = None  # best-effort
    page_end: int | None = None
    extraction_confidence: float | None = None  # 0..1, best-effort

    def to_dict(self) -> dict:
        d: dict = {
            "type": self.type,
            "text": self.text,
            "sourceFileReference": self.source_file_reference,
            "parserVersion": self.parser_version,
        }
        if self.page_start is not None:
            d["pageStart"] = self.page_start
        if self.page_end is not None:
            d["pageEnd"] = self.page_end
        if self.extraction_confidence is not None:
            d["extractionConfidence"] = self.extraction_confidence
        return d


@dataclass
class ParsedBrief:
    """Structured parse result (invariant #2). `status` separates the three cases
    today's "" conflates: parsed-ok / parsed-empty / parse-failed. `sections` is a
    canonical-key → section map (single-value keys) plus list-valued `faq`/`other`.
    `flat_text` is the derived fallback (the old blob). `tier_used` and `page_count`
    feed observability (§4.8)."""

    status: str  # "ok" | "empty" | "parse_failed"
    flat_text: str
    parser_version: str = PARSER_VERSION
    sections: dict[str, CampaignBriefSection] = field(default_factory=dict)
    faq: list[CampaignBriefSection] = field(default_factory=list)
    other: list[CampaignBriefSection] = field(default_factory=list)
    tier_used: str | None = None  # "headings" | "keywords" | None
    page_count: int = 0

    def sections_payload(self) -> dict:
        """Serialize the section map to the TS `sections` dict — single-value keys
        plus list-valued faq/other. Only populated when status == "ok"."""
        payload: dict = {k: v.to_dict() for k, v in self.sections.items()}
        if self.faq:
            payload["faq"] = [s.to_dict() for s in self.faq]
        if self.other:
            payload["other"] = [s.to_dict() for s in self.other]
        return payload


# Canonical section keys. Kept identical to the strings PLU-114's `SectionKey` uses
# where they overlap (usageRights/exclusivity/paymentTerms/timeline/deliverables/
# shipping) so `ParsedCampaignBrief` → `AvailableSections.brief` is a projection,
# not a translation (§4.1).
_SINGLE_KEYS = (
    "overview",
    "productInformation",
    "deliverables",
    "timeline",
    "usageRights",
    "exclusivity",
    "paymentTerms",
    "requiredTalkingPoints",
    "shipping",
    "contentExamples",
    # PLU-170 (G3): prohibited-claims/restrictions text — aliased on the web side
    # onto the reviewable Page-5 "Content requirements" field.
    "restrictions",
)

# Heading/label → canonical key (invariant, §4.3 tier 1). A heading line whose
# normalized text matches one of these regexes opens that section; the section text
# runs to the next recognized heading. Ordered specific → generic so "payment
# terms" wins before a bare "terms". FAQ / other are handled separately.
_HEADING_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("faq", re.compile(r"^(faq|frequently asked|q\s*&\s*a|questions?\s*&\s*answers?)\b", re.I)),
    (
        "paymentTerms",
        re.compile(r"^(payment( terms| schedule| details)?|compensation|how (you'?re |you get )?paid|fees?\s*&\s*payment)\b", re.I),
    ),
    (
        "usageRights",
        re.compile(r"^(usage( rights| terms)?|content (usage|rights|license|licence)|licen[cs]e|rights( &| and)? usage|reposting|whitelisting)\b", re.I),
    ),
    ("exclusivity", re.compile(r"^(exclusivity|category exclusivity|exclusive(ity)?( terms)?)\b", re.I)),
    ("timeline", re.compile(r"^(timeline|schedule|key dates?|important dates?|milestones?|go[- ]?live|deadlines?)\b", re.I)),
    # PLU-170 (G3): restrictions/prohibited-claims MUST match before deliverables —
    # "Content requirements" now routes here (Page-5 alias), not to Deliverables.
    (
        "restrictions",
        re.compile(r"^(restrictions?|prohibited( claims?)?|do ?not|don.?ts?|disclaimers?|compliance|must not|content (restrictions?|requirements?))\b", re.I),
    ),
    (
        "deliverables",
        re.compile(r"^(deliverables?|what (we need|you'?ll (create|deliver))|scope of work|assets? required)\b", re.I),
    ),
    ("shipping", re.compile(r"^(shipping|product (shipping|delivery)|fulfillment|sending (you )?product)\b", re.I)),
    (
        "requiredTalkingPoints",
        re.compile(r"^(talking points?|key messages?|required (talking|messaging|mentions?)|do'?s|must (mention|include))\b", re.I),
    ),
    ("contentExamples", re.compile(r"^(content examples?|examples?|inspiration|references?|creative examples?|mood ?board)\b", re.I)),
    (
        "productInformation",
        re.compile(r"^(product (information|details|overview)|about the product|the product)\b", re.I),
    ),
    ("overview", re.compile(r"^(overview|campaign (overview|brief|summary)|introduction|about (the )?(campaign|brand)|summary)\b", re.I)),
]

# Per-topic keyword signals for the fallback tier (§4.3 tier 2). A paragraph block
# that confidently matches ONE topic (and no other) is assigned to it. These reuse
# the topic vocabulary proven in the negotiation `_KNOWN_FACT_QA` / `topic_gate`
# routers so the parser and the runtime agree on what a "usage-rights" mention is.
_KEYWORD_SIGNALS: list[tuple[str, re.Pattern[str]]] = [
    ("paymentTerms", re.compile(r"\bnet[- ]?\d|\b(pay(ment|out)?|invoic\w*|paid)\b[^.]*\b\d+\s*days?|when (you|they) get paid", re.I)),
    ("usageRights", re.compile(r"\busage rights?\b|\b(licen[cs]e|reshare|repost|whitelist)\w*\b|\bown channels?\b|use (the )?content", re.I)),
    ("exclusivity", re.compile(r"\bexclusiv\w*\b|category exclusivity|lock(ed)? out|competitor brand", re.I)),
    ("shipping", re.compile(r"\bship(ping|ment|ped)?\b|shipping address|we'?ll send you|product (will be )?(sent|shipped|mailed)", re.I)),
    ("timeline", re.compile(r"\bgo[- ]?live\b|\b(deadline|due date|publish (by|date)|launch date)\b|by (mon|tues|wednes|thurs|fri|satur|sun)day", re.I)),
    ("deliverables", re.compile(r"\b\d+\s*(reels?|posts?|stories|videos?|tiktoks?|shorts?)\b|deliver(able)?s?:", re.I)),
    # PLU-170 (G3): prohibited-claims / restrictions signal.
    ("restrictions", re.compile(r"\b(do not|don.?t|avoid|prohibited|must not|no (competitor|health|medical) claims?)\b", re.I)),
]

# A heading line is short, non-terminal prose. Guard against treating a full
# sentence that merely starts with a section word (e.g. "Payment will be handled
# by our finance team, and…") as a heading: real headings are short and rarely end
# in a sentence-ending period followed by more words.
_MAX_HEADING_LEN = 60

# Real briefs number or bullet their headings ("1. Deliverables", "2) Timeline",
# "- Usage Rights"). Strip a single leading enumerator so the heading word is at
# the start for matching. Only ONE leading token is stripped (a nested "1.1." or a
# list of bullets stays prose).
_ENUMERATOR_RE = re.compile(r"^\s*(?:\d{1,2}[.)]|[-*•])\s+")


def _strip_enumerator(line: str) -> str:
    return _ENUMERATOR_RE.sub("", line, count=1).strip()


def _looks_like_heading(line: str) -> bool:
    stripped = _strip_enumerator(line)
    if not stripped or len(stripped) > _MAX_HEADING_LEN:
        return False
    # An INLINE field ("Usage rights: 30 days, paid social + organic.") is NOT a
    # heading — it is a labelled value living inside a paragraph. A real heading is
    # bare ("Deliverables") or bare-with-trailing-colon ("Deliverables:"), never a
    # label with substantial content after the colon on the SAME line. So if there
    # is a colon with more than a couple of words after it, this is an inline field,
    # not a section heading — reject it (this is what stopped the live "Usage
    # rights: 30 days…" line from being mis-read as a heading that swallowed the
    # rest of the doc).
    if ":" in stripped:
        _label, _, after = stripped.partition(":")
        if len(after.split()) > 2:
            return False
    # A heading is usually a label, optionally with a trailing colon; it does not
    # read as a full sentence. Reject lines that read as prose (too many words).
    core = stripped.rstrip(":").strip()
    if not core:
        return False
    # Too many words → prose, not a heading.
    if len(core.split()) > 8:
        return False
    return True


def _match_heading(line: str) -> str | None:
    """Return the canonical key for a heading line, or None if it isn't a known
    heading. Order matters (specific before generic). A leading enumerator
    ("1. ", "2) ", "- ") is stripped first so numbered/bulleted headings match."""
    if not _looks_like_heading(line):
        return None
    core = _strip_enumerator(line).rstrip(":").strip()
    for key, pat in _HEADING_PATTERNS:
        if pat.search(core):
            return key
    return None


def _keyword_key_for_block(block: str) -> str | None:
    """Assign a paragraph block to a topic ONLY when it matches exactly one topic
    signal (confident, no ambiguity). A block matching two topics is left to
    `other[]` — conservative by design (§4.3 tier 2)."""
    matched = [key for key, pat in _KEYWORD_SIGNALS if pat.search(block)]
    if len(matched) == 1:
        return matched[0]
    return None


def _page_of_offset(page_spans: list[tuple[int, int, int]], offset: int) -> int | None:
    """Given (page, start, end) character spans over the joined text, return the
    1-based page containing `offset`, or None."""
    for page, start, end in page_spans:
        if start <= offset < end:
            return page
    return None


def _segment_by_headings(
    normalized: str, page_spans: list[tuple[int, int, int]]
) -> tuple[dict[str, CampaignBriefSection], list[CampaignBriefSection], list[CampaignBriefSection]]:
    """Tier 1: split the normalized text at recognized heading lines. Returns
    (single-value sections, faq list, other list). Sections are stamped later with
    the file ref (the segmenter is ref-agnostic)."""
    lines = normalized.split("\n")
    # Track the character offset of each line's start so we can attribute pages.
    offsets: list[int] = []
    pos = 0
    for ln in lines:
        offsets.append(pos)
        pos += len(ln) + 1  # +1 for the '\n' join

    # Walk lines, opening a new section each time a heading is recognized.
    segments: list[tuple[str, int, int]] = []  # (key, start_line_idx, end_line_idx exclusive)
    open_key: str | None = None
    open_start = 0
    for i, ln in enumerate(lines):
        key = _match_heading(ln)
        if key is not None:
            if open_key is not None:
                segments.append((open_key, open_start, i))
            open_key = key
            open_start = i + 1  # body starts AFTER the heading line
    if open_key is not None:
        segments.append((open_key, open_start, len(lines)))

    singles: dict[str, CampaignBriefSection] = {}
    faq: list[CampaignBriefSection] = []
    other: list[CampaignBriefSection] = []
    for key, start_i, end_i in segments:
        body = "\n".join(lines[start_i:end_i]).strip()
        if not body:
            continue
        char_start = offsets[start_i] if start_i < len(offsets) else 0
        char_end = (offsets[end_i - 1] + len(lines[end_i - 1])) if end_i - 1 < len(offsets) and end_i > start_i else char_start
        page_start = _page_of_offset(page_spans, char_start)
        page_end = _page_of_offset(page_spans, max(char_start, char_end - 1))
        sec = CampaignBriefSection(
            type=key,
            text=body,
            source_file_reference="",  # stamped by the route
            parser_version=PARSER_VERSION,
            page_start=page_start,
            page_end=page_end,
            extraction_confidence=0.9,  # heading match is high-confidence (§4.2)
        )
        if key == "faq":
            faq.append(sec)
        elif key in _SINGLE_KEYS:
            # First heading wins for a duplicate key; a second block goes to other[].
            if key in singles:
                sec.type = "other"
                other.append(sec)
            else:
                singles[key] = sec
        else:  # pragma: no cover - defensive; all heading keys are single or faq
            other.append(sec)
    return singles, faq, other


def _segment_by_keywords(
    normalized: str,
    page_spans: list[tuple[int, int, int]],
    already: set[str],
) -> tuple[dict[str, CampaignBriefSection], list[CampaignBriefSection]]:
    """Tier 2: for briefs without clean headings, scan blank-line-separated blocks
    and assign each to a topic it uniquely matches. Skips keys already found by
    tier 1. Unmatched blocks are NOT dropped — they accumulate into `other[]`
    (invariant, §4.3)."""
    singles: dict[str, CampaignBriefSection] = {}
    other: list[CampaignBriefSection] = []
    pos = 0
    for block in re.split(r"\n\s*\n", normalized):
        block_start = normalized.find(block, pos)
        if block_start < 0:
            block_start = pos
        pos = block_start + len(block)
        body = block.strip()
        if not body:
            continue
        page = _page_of_offset(page_spans, block_start)
        key = _keyword_key_for_block(body)
        sec = CampaignBriefSection(
            type=key or "other",
            text=body,
            source_file_reference="",
            parser_version=PARSER_VERSION,
            page_start=page,
            page_end=page,
            extraction_confidence=0.55 if key else None,  # keyword-inferred = lower (§4.2)
        )
        if key and key not in already and key not in singles:
            singles[key] = sec
        else:
            sec.type = "other"
            other.append(sec)
    return singles, other


def _build_page_spans(pages: list[PageText]) -> tuple[str, list[tuple[int, int, int]]]:
    """Join the per-page normalized text into the flat blob AND record each page's
    (page, char_start, char_end) span so sections can be attributed to pages. The
    join and normalization match `extract_brief_text` so `flat_text` is derived
    from the same text (invariant #6)."""
    raw = "\n".join(pt.text for pt in pages)
    normalized = _normalize(raw)[:MAX_BRIEF_CHARS].strip()
    # Recompute spans over the *normalized* text by re-normalizing each page's slice
    # and locating it. Normalization is idempotent per-page enough for best-effort
    # page attribution; an exact re-derivation isn't needed (pages are advisory).
    spans: list[tuple[int, int, int]] = []
    cursor = 0
    for pt in pages:
        norm_page = _normalize(pt.text).strip()
        if not norm_page:
            continue
        idx = normalized.find(norm_page[: min(len(norm_page), 40)], cursor)
        if idx < 0:
            idx = cursor
        end = idx + len(norm_page)
        spans.append((pt.page, idx, min(end, len(normalized))))
        cursor = min(end, len(normalized))
    return normalized, spans


def parse_brief_structured(pdf_bytes: bytes) -> ParsedBrief:
    """PLU-107: parse a campaign brief PDF into typed, page-referenced sections
    with an explicit status. Deterministic segmentation only (invariant #8).

    NEVER raises (invariant #7): a genuine parse failure returns status
    "parse_failed" with empty sections and flat_text ""; a text-less (scanned) PDF
    returns "empty"; a readable PDF returns "ok" with whatever sections segmented.
    `flat_text` is always populated on ok/empty so the drafting fallback is intact.
    The caller (the /parse-brief route) stamps `source_file_reference` on each
    section (this function is ref-agnostic).

    When the OCR fallback is enabled (BRIEF_OCR_FALLBACK_ENABLED) and the brief is
    scanned / image-only, extraction routes through OCR so the structured parse
    recovers too — a scanned brief becomes "ok" with sections instead of "empty".
    """
    try:
        pages = _extract_pages_with_ocr(pdf_bytes)
    except _ExtractFailed:
        return ParsedBrief(status="parse_failed", flat_text="", page_count=0)

    if not pages:
        # Parsed fine, but no text layer (scanned / image-only PDF) — empty, NOT
        # a failure (invariant #2 / §4.3). flat_text is "" but that's an honest
        # empty, distinguishable downstream from parse_failed.
        return ParsedBrief(status="empty", flat_text="", page_count=0)

    page_count = len(pages)
    try:
        normalized, page_spans = _build_page_spans(pages)
        if not normalized:
            return ParsedBrief(status="empty", flat_text="", page_count=page_count)

        # Tier 1: headings.
        singles, faq, other = _segment_by_headings(normalized, page_spans)
        tier = "headings" if (singles or faq) else None

        # Tier 2: keyword-block inference for keys tier 1 missed (or a heading-light
        # brief where tier 1 found nothing). Only fills GAPS — never overrides a
        # heading match.
        if len(singles) < 3:  # sparse headings → try to fill in
            kw_singles, kw_other = _segment_by_keywords(normalized, page_spans, set(singles))
            for k, v in kw_singles.items():
                singles.setdefault(k, v)
            # Only keep keyword `other[]` when headings produced nothing, to avoid
            # duplicating the whole doc as unmatched blocks under both tiers.
            if tier != "headings":
                other = kw_other
            if kw_singles:
                tier = tier or "keywords"

        # flat_text is ALWAYS the derived blob (invariant #6) regardless of tier.
        return ParsedBrief(
            status="ok",
            flat_text=normalized,
            sections=singles,
            faq=faq,
            other=other,
            tier_used=tier,
            page_count=page_count,
        )
    except Exception as exc:  # segmentation bug must not break the run (invariant #7)
        logger.warning("brief: structured segmentation failed, degrading to flat: %s", exc)
        # We DID extract text — return it as flat with empty sections, status ok
        # (a brief we couldn't segment is still readable as a blob, invariant #6).
        flat = extract_brief_text(pdf_bytes)
        return ParsedBrief(status="ok", flat_text=flat, page_count=page_count)
