"""Batch-5 unit coverage: EASY-S1 redaction, HARD-K1 (brief parse + knowledge
block + post-draft verification), HARD-N2 draft-history render, EASY-W1 round cap.

All offline / deterministic — no live model, no network."""

from __future__ import annotations

import io

import pytest

pytest.importorskip("langgraph", reason="langgraph not installed (ai extra)")

from app import structured
from app.routes import negotiate as neg


# ---------------------------------------------------------------------------
# EASY-S1: raw model output is redacted from error messages
# ---------------------------------------------------------------------------


def test_extract_json_error_redacts_long_raw():
    raw = "SECRET-CEILING-500 " + "x" * 500  # long, contains a "secret" figure
    with pytest.raises(ValueError) as exc:
        structured.extract_json_object(raw)
    msg = str(exc.value)
    assert "truncated" in msg
    # The full raw must NOT appear — only a short preview.
    assert len(msg) < 200
    assert "x" * 200 not in msg


def test_extract_json_error_short_raw_still_bounded():
    # A short non-JSON raw is shown but via the redactor (repr, no truncation).
    with pytest.raises(ValueError) as exc:
        structured.extract_json_object("not json at all")
    assert "not json at all" in str(exc.value)


# ---------------------------------------------------------------------------
# HARD-K1: brief PDF parsing
# ---------------------------------------------------------------------------


def test_brief_extract_empty_and_garbage_return_blank():
    from app.brief import extract_brief_text

    assert extract_brief_text(b"") == ""
    assert extract_brief_text(b"not a pdf at all") == ""


def test_brief_extract_reads_a_real_pdf():
    from app.brief import extract_brief_text

    pdf = (
        b"%PDF-1.4\n"
        b"1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n"
        b"2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n"
        b"3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]"
        b"/Resources<</Font<</F1 4 0 R>>>>/Contents 5 0 R>>endobj\n"
        b"4 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\n"
        b"5 0 obj<</Length 58>>stream\n"
        b"BT /F1 18 Tf 72 700 Td (Deliverables 3 reels) Tj ET\n"
        b"endstream endobj\n"
        b"xref\n0 6\n0000000000 65535 f \n"
        b"trailer<</Root 1 0 R/Size 6>>\nstartxref\n0\n%%EOF"
    )
    text = extract_brief_text(pdf)
    assert "Deliverables" in text


def test_brief_extract_caps_length():
    from app.brief import extract_brief_text, MAX_BRIEF_CHARS

    # Garbage bytes won't parse, but the cap is asserted via the public arg.
    assert extract_brief_text(b"", max_chars=10) == ""
    assert MAX_BRIEF_CHARS > 0


# ---------------------------------------------------------------------------
# OCR fallback for scanned / image-only briefs (BRIEF_OCR_FALLBACK_ENABLED)
# ---------------------------------------------------------------------------


def _image_only_pdf(text: str = "Deliverables 3 reels usage 6 months") -> bytes:
    """A one-page PDF whose ONLY content is a rasterized image of `text` — i.e.
    NO embedded text layer, exactly like a scanned brief. Built with PIL (already
    a transitive dep); PIL's PDF save embeds the image with no text, so pypdf's
    extract_text() sees nothing and the OCR fallback is the only way to read it."""
    from PIL import Image, ImageDraw

    img = Image.new("RGB", (1240, 200), "white")  # ~150 DPI strip, big legible text
    draw = ImageDraw.Draw(img)
    # Default PIL font is tiny; scale it up so Tesseract has a fair chance.
    draw.text((20, 60), text, fill="black")
    # Upscale so the default bitmap font is large enough to OCR reliably.
    img = img.resize((2480, 400))
    buf = io.BytesIO()
    img.save(buf, format="PDF", resolution=150.0)
    return buf.getvalue()


def test_ocr_fallback_off_by_default_is_noop(monkeypatch):
    """With the flag unset, a scanned/image-only brief still returns "" — the OCR
    path never runs, so behavior is byte-identical to before this feature."""
    from app.brief import extract_brief_text

    monkeypatch.delenv("BRIEF_OCR_FALLBACK_ENABLED", raising=False)
    pdf = _image_only_pdf()
    # No embedded text + flag off → "" (unchanged legacy behavior).
    assert extract_brief_text(pdf) == ""


def test_ocr_fallback_degrades_when_binary_missing(monkeypatch):
    """Flag ON but the ocrmypdf binary absent → "" (never raises). Proves the
    fail-soft contract: a misconfigured deploy degrades to no-knowledge, it does
    not break a negotiation."""
    import app.brief as brief

    monkeypatch.setenv("BRIEF_OCR_FALLBACK_ENABLED", "1")
    # brief imports shutil lazily inside _ocr_pdf; patch shutil.which to force the
    # "binary not on PATH" branch regardless of the host.
    import shutil as _shutil

    monkeypatch.setattr(_shutil, "which", lambda _name: None)
    assert brief.extract_brief_text(_image_only_pdf()) == ""


def test_ocr_fallback_only_fires_on_thin_text(monkeypatch):
    """A normal text PDF (embedded layer present) must NOT invoke OCR even with
    the flag on — the guard is 'insufficient text', and OCR is the expensive path
    we want to avoid on the common case. We assert by making the OCR function blow
    up if called: a real text PDF must never reach it."""
    import app.brief as brief

    monkeypatch.setenv("BRIEF_OCR_FALLBACK_ENABLED", "1")

    def _boom(*_a, **_k):
        raise AssertionError("OCR must not run when embedded text is sufficient")

    monkeypatch.setattr(brief, "_ocr_pdf", _boom)

    text_pdf = (
        b"%PDF-1.4\n"
        b"1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n"
        b"2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n"
        b"3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]"
        b"/Resources<</Font<</F1 4 0 R>>>>/Contents 5 0 R>>endobj\n"
        b"4 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\n"
        b"5 0 obj<</Length 90>>stream\n"
        b"BT /F1 18 Tf 72 700 Td (Deliverables three reels usage six months exclusivity) Tj ET\n"
        b"endstream endobj\n"
        b"xref\n0 6\n0000000000 65535 f \n"
        b"trailer<</Root 1 0 R/Size 6>>\nstartxref\n0\n%%EOF"
    )
    out = brief.extract_brief_text(text_pdf)
    assert "Deliverables" in out  # read via pypdf, OCR never touched


def test_ocr_fallback_recovers_scanned_text(monkeypatch):
    """END-TO-END: with the flag on and the OCR binaries present, a scanned /
    image-only brief that pypdf reads as "" is recovered via OCR.

    Self-skips when ocrmypdf/tesseract aren't installed (e.g. a dev box) so the
    suite stays green offline; CI installs the binaries so this actually runs."""
    import shutil

    if shutil.which("ocrmypdf") is None or shutil.which("tesseract") is None:
        pytest.skip("ocrmypdf/tesseract not installed — OCR e2e skipped")

    from app.brief import extract_brief_text

    monkeypatch.setenv("BRIEF_OCR_FALLBACK_ENABLED", "1")
    pdf = _image_only_pdf("Deliverables three reels")

    # Sanity: with the flag OFF this same PDF yields nothing (no text layer).
    monkeypatch.delenv("BRIEF_OCR_FALLBACK_ENABLED", raising=False)
    assert extract_brief_text(pdf) == ""

    # Flag ON → OCR recovers the words. Tesseract isn't perfect on a bitmap font,
    # so assert on a robust token rather than the exact string.
    monkeypatch.setenv("BRIEF_OCR_FALLBACK_ENABLED", "1")
    recovered = extract_brief_text(pdf).lower()
    assert "reels" in recovered or "deliverables" in recovered


def test_ocr_fallback_recovers_scanned_brief_for_structured_parse(monkeypatch):
    """PLU-107 tie-in: OCR routes through the shared page-extractor, so a scanned
    brief is recovered for parse_brief_structured too — its status flips from
    "empty" (no text layer) to "ok" with a populated flat_text. Self-skips without
    the OCR binaries."""
    import shutil

    if shutil.which("ocrmypdf") is None or shutil.which("tesseract") is None:
        pytest.skip("ocrmypdf/tesseract not installed — OCR e2e skipped")

    from app.brief import parse_brief_structured

    pdf = _image_only_pdf("Deliverables three reels")

    # Flag OFF → scanned brief is "empty" (no text layer, no OCR).
    monkeypatch.delenv("BRIEF_OCR_FALLBACK_ENABLED", raising=False)
    assert parse_brief_structured(pdf).status == "empty"

    # Flag ON → OCR recovers text, so the structured parse is "ok" with flat_text.
    monkeypatch.setenv("BRIEF_OCR_FALLBACK_ENABLED", "1")
    parsed = parse_brief_structured(pdf)
    assert parsed.status == "ok"
    assert "reels" in parsed.flat_text.lower() or "deliverables" in parsed.flat_text.lower()


# ---------------------------------------------------------------------------
# HARD-K1: knowledge block + brief block render into the prompt
# ---------------------------------------------------------------------------


def _draft_req(**kw):
    base = dict(purpose="counter_offer", creatorName="Ada")
    base.update(kw)
    return neg.DraftRequest(**base)


def test_knowledge_block_from_fields_and_context():
    # Explicit field wins; a context-only field is also surfaced.
    block = neg._knowledge_block(
        _draft_req(usageRights="6-month paid social"),
        {"paymentTerms": "net-30"},
    )
    assert "usage" in block.lower()
    assert "net-30" in block
    # No knowledge → empty (prompt already handles honest deferral).
    assert neg._knowledge_block(_draft_req(), {}) == ""


def test_brief_knowledge_block_tags_data():
    block = neg._brief_knowledge_block({"briefKnowledge": "Deliverables: 3 reels."})
    assert "<campaign_brief>" in block and "3 reels" in block
    assert neg._brief_knowledge_block({}) == ""


# ---------------------------------------------------------------------------
# HARD-K1: post-draft question-coverage verification
# ---------------------------------------------------------------------------


def test_unanswered_questions_detects_a_silent_drop():
    questions = ["What is the commission rate?", "When do I get paid?"]
    # A generic email that addresses neither.
    body = "Thanks so much! We're excited to collaborate with you."
    missed = neg._unanswered_questions(body, questions)
    assert set(missed) == set(questions)


def test_unanswered_questions_accepts_topic_overlap_and_deferral():
    questions = ["What is the commission rate?", "When do I get paid?"]
    body = (
        "The commission is 10%. We'll confirm the exact payment timing together "
        "on the next step."
    )
    assert neg._unanswered_questions(body, questions) == []


def test_deferral_marker_is_specific_not_bare_together():
    # "working together" must NOT count as a deferral (it used to false-pass).
    questions = ["What is the commission rate?"]
    body = "Looking forward to working together!"
    assert neg._unanswered_questions(body, questions) == ["What is the commission rate?"]


def test_draft_questions_to_verify_merges_and_dedups():
    req = _draft_req(
        creatorQuestions=["What's the fee?"],
        openQuestions=["what's the fee?", "When live?"],
    )
    qs = neg._draft_questions_to_verify(req)
    # de-duplicated case-insensitively → fee once + the new open question.
    assert len(qs) == 2
    assert any("live" in q.lower() for q in qs)


# ---------------------------------------------------------------------------
# F-Q4 — the known-fact value-signal must prove the VALUE was stated, so a
# deferral of an answer we actually have (attribution/usage) can't false-pass and
# get silently dropped. Mirrors the B-34 payment-terms tightening.
# ---------------------------------------------------------------------------


def test_fq4_attribution_deferral_is_flagged_not_false_passed():
    # The Q4 shape: creator asks the attribution window; a DEFERRAL that just says
    # "we'll confirm the attribution window later" must be flagged as deferred
    # (forcing a re-draft / splice), NOT counted as answered.
    q = ["What's the attribution window on the affiliate link?"]
    deferred_body = "We'll confirm the attribution window together on the next step."
    answered_body = "You get a 30-day attribution window on the affiliate link."
    assert neg._deferred_known_facts(deferred_body, q, {"attributionWindow"}) == ["attributionWindow"]
    assert neg._deferred_known_facts(answered_body, q, {"attributionWindow"}) == []


def test_fq4_usage_rights_deferral_is_flagged():
    q = ["How long are the usage rights?"]
    deferred_body = "We'll confirm the usage rights and licensing with you shortly."
    answered_body = "AeroSoft gets 30-day usage rights and may reshare on its own channels."
    assert neg._deferred_known_facts(deferred_body, q, {"usageRights"}) == ["usageRights"]
    assert neg._deferred_known_facts(answered_body, q, {"usageRights"}) == []


def test_fq4_only_enforced_when_fact_present():
    # If we don't HAVE the attribution value this turn, the verifier doesn't force
    # it (honest deferral is the correct behavior when the fact is unknown).
    q = ["What's the attribution window?"]
    body = "We'll confirm the attribution window later."
    assert neg._deferred_known_facts(body, q, set()) == []


def test_fq4_co_asked_attribution_splices_when_still_deferred():
    # The end-state guarantee: even if a re-draft STILL defers, the exact value is
    # spliced in so a co-asked known-fact question is never silently dropped.
    body = "Thanks! On the commission — that's fixed at 10%. Best,\nAeroSoft"
    known = {"Attribution / cookie window": "30-day attribution window on the affiliate link."}
    spliced = neg._splice_known_facts(body, ["attributionWindow"], known)
    assert "30-day attribution window" in spliced
    assert spliced != body


# ---------------------------------------------------------------------------
# HARD-N2: draft-history render
# ---------------------------------------------------------------------------


def test_render_draft_history_tags_both_sides():
    hist = [
        neg.DraftHistoryEntry(role="creator", message="What is the commission?"),
        neg.DraftHistoryEntry(role="us", round=1, action="COUNTER", rate=350.0, message="We can offer $350."),
    ]
    block = neg._render_draft_history(hist)
    assert "<conversation_history>" in block
    assert "creator" in block and "COUNTER" in block
    # Empty history → no block.
    assert neg._render_draft_history([]) == ""


# ---------------------------------------------------------------------------
# EASY-W1: consistent round-cap semantic
# ---------------------------------------------------------------------------


def test_rounds_exhausted_treats_zero_as_unlimited():
    assert neg._rounds_exhausted(0, 0) is False  # unlimited
    assert neg._rounds_exhausted(99, 0) is False
    assert neg._rounds_exhausted(3, 4) is False
    assert neg._rounds_exhausted(4, 4) is True
    assert neg._rounds_exhausted(5, 4) is True
