"""PLU-107: structured brief parsing — segmentation, status, versioning, and the
/negotiate brief-block wiring.

Segmentation is tested two ways: (1) directly over normalized text (the new logic,
no PDF machinery in the way), and (2) end-to-end through a real text-layer PDF built
by `make_pdf` (covers extraction → segmentation → status). No LLM is used — v1
segmentation is deterministic (PLU-107 invariant #8).
"""

from __future__ import annotations

import io

from pypdf import PdfReader  # noqa: F401  (import proves the dep is present)

import app.brief as b
import app.routes.negotiate as neg


# ---------------------------------------------------------------------------
# Fixture: a minimal single/multi-line text-layer PDF builder.
# ---------------------------------------------------------------------------
def make_pdf(lines: list[str]) -> bytes:
    """Build a minimal single-page text-layer PDF, one input line per row. Real
    text layer (pypdf extracts it), so this exercises the true extraction path."""
    text_ops = []
    y = 720
    for ln in lines:
        esc = ln.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
        text_ops.append("BT /F1 12 Tf 72 %d Td (%s) Tj ET" % (y, esc))
        y -= 18
    content = "\n".join(text_ops).encode("latin-1")
    objs = [
        b"<</Type/Catalog/Pages 2 0 R>>",
        b"<</Type/Pages/Kids[3 0 R]/Count 1>>",
        b"<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]"
        b"/Resources<</Font<</F1 4 0 R>>>>/Contents 5 0 R>>",
        b"<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>",
        b"<</Length " + str(len(content)).encode() + b">>stream\n" + content + b"\nendstream",
    ]
    out = io.BytesIO()
    out.write(b"%PDF-1.4\n")
    offsets = []
    for i, o in enumerate(objs, 1):
        offsets.append(out.tell())
        out.write(str(i).encode() + b" 0 obj" + o + b"endobj\n")
    xref = out.tell()
    out.write(b"xref\n0 " + str(len(objs) + 1).encode() + b"\n0000000000 65535 f \n")
    for off in offsets:
        out.write(("%010d 00000 n \n" % off).encode())
    out.write(
        b"trailer<</Root 1 0 R/Size "
        + str(len(objs) + 1).encode()
        + b">>\nstartxref\n"
        + str(xref).encode()
        + b"\n%%EOF"
    )
    return out.getvalue()


_HEADED = [
    "Campaign Overview",
    "A summer campaign for running shoes.",
    "Deliverables",
    "3 Instagram Reels and 1 YouTube integration.",
    "Usage Rights",
    "The brand may reshare your content on its own channels for 90 days.",
    "Payment Terms",
    "Net 30 after the content goes live.",
    "Exclusivity",
    "Non-exclusive; you may work with other brands.",
    "FAQ",
    "Q: When do I get paid? A: Net 30.",
]


# ---------------------------------------------------------------------------
# Segmentation over normalized text (the new logic, isolated).
# ---------------------------------------------------------------------------
def test_heading_segmentation_types_every_section_with_provenance():
    text = "\n".join(_HEADED)
    spans = [(1, 0, len(text))]
    singles, faq, other = b._segment_by_headings(text, spans)
    # Each expected section present + correctly typed (acceptance: metadata).
    assert set(singles) >= {"overview", "deliverables", "usageRights", "paymentTerms", "exclusivity"}
    assert len(faq) == 1
    ur = singles["usageRights"]
    assert "reshare" in ur.text and ur.type == "usageRights"
    # Provenance is present (invariant #4): page + version + high confidence.
    assert ur.page_start == 1
    assert ur.parser_version == b.PARSER_VERSION
    assert ur.extraction_confidence and ur.extraction_confidence >= 0.8


def test_usage_rights_selectable_without_the_rest_of_the_brief():
    # acceptance: "Usage-rights knowledge can be selected without passing full brief"
    text = "\n".join(_HEADED)
    singles, _faq, _other = b._segment_by_headings(text, [(1, 0, len(text))])
    ur = singles["usageRights"].text
    assert "90 days" in ur
    # The usage section alone does NOT drag in payment/deliverables text.
    assert "Net 30" not in ur and "Reels" not in ur


def test_numbered_headings_match_and_inline_label_is_not_a_heading():
    # Regression (live PulseFuel brief): headings are NUMBERED ("1. Deliverables")
    # and an inline "Usage rights: 30 days, paid social" line lives INSIDE the
    # deliverables block. The numbered headings must match, and the inline label
    # must NOT be treated as a heading that swallows the rest of the document.
    lines = [
        "1. Deliverables",
        " - 1 Instagram Reel",
        " Usage rights: 30 days, paid social + organic.",
        "2. Timeline",
        " - Content live: August 12",
        "3. Key Messages",
        " - 24g protein per scoop",
        "4. Do / Don't",
        " DO tag the brand",
    ]
    parsed = b.parse_brief_structured(make_pdf(lines))
    assert parsed.status == "ok"
    assert parsed.tier_used == "headings"
    # Numbered headings are recognized.
    assert {"deliverables", "timeline"} <= set(parsed.sections)
    # The inline "Usage rights:" line did NOT open a usageRights section that ate
    # the rest of the doc — deliverables stops at the Timeline heading.
    deliverables = parsed.sections["deliverables"].text
    assert "Instagram Reel" in deliverables
    assert "Content live" not in deliverables  # did not swallow the Timeline block


def test_inline_label_line_is_rejected_as_heading():
    # A "Label: value" line with substantial content after the colon is an inline
    # field, never a section heading.
    assert b._match_heading("Usage rights: 30 days, paid social + organic.") is None
    assert b._match_heading("Payment: Net 30 after the content goes live.") is None
    # A bare label (optionally with a trailing colon) IS a heading.
    assert b._match_heading("Usage Rights") == "usageRights"
    assert b._match_heading("Payment Terms:") == "paymentTerms"
    # Numbered/bulleted headings match after enumerator strip.
    assert b._match_heading("1. Deliverables") == "deliverables"
    assert b._match_heading("- Timeline") == "timeline"


def test_restrictions_heading_segments_and_content_requirements_no_longer_deliverables():
    # PLU-170 (G3): a "Restrictions" (and "Prohibited claims") heading opens a
    # `restrictions` section — the key the web side aliases onto the reviewable
    # Page-5 "Content requirements" field. And a literal "Content requirements"
    # heading must route to `restrictions`, NOT get swallowed by Deliverables.
    # A "Content requirements" heading (the phrase deliverables' regex used to
    # swallow) now opens the restrictions section, not deliverables.
    lines = [
        "Deliverables",
        "3 Instagram Reels.",
        "Content Requirements",
        "No health or medical claims. Must include the #ad disclosure.",
    ]
    parsed = b.parse_brief_structured(make_pdf(lines))
    assert parsed.status == "ok"
    assert "restrictions" in parsed.sections
    restrictions = parsed.sections["restrictions"].text
    assert "health or medical claims" in restrictions
    assert "disclosure" in restrictions
    # ...and did NOT leak into deliverables.
    deliverables = parsed.sections["deliverables"].text if "deliverables" in parsed.sections else ""
    assert "disclosure" not in deliverables
    # Every restrictions synonym maps to the same key (order: before deliverables).
    assert b._match_heading("Restrictions") == "restrictions"
    assert b._match_heading("Prohibited Claims") == "restrictions"
    assert b._match_heading("Content Requirements") == "restrictions"


def test_heading_light_brief_falls_to_keyword_tier_and_keeps_unmatched():
    text = (
        "We are excited to partner with you.\n\n"
        "You will be paid Net 45 after the content goes live and the invoice is approved.\n\n"
        "The brand may repost and reshare the content on its own channels; "
        "usage rights extend for 60 days.\n\n"
        "A paragraph about coffee and the weather with no campaign topic."
    )
    singles, other = b._segment_by_keywords(text, [(1, 0, len(text))], set())
    assert set(singles) >= {"paymentTerms", "usageRights"}
    # Keyword-inferred sections carry a LOWER confidence than heading matches (§4.2).
    assert singles["paymentTerms"].extraction_confidence == 0.55
    # Unmatched blocks are NOT dropped — they accumulate into other[] (§4.3).
    assert other and any("coffee" in s.text for s in other)


# ---------------------------------------------------------------------------
# End-to-end status: missing != failure != absent (invariant #2).
# ---------------------------------------------------------------------------
def test_status_ok_with_present_and_absent_sections():
    parsed = b.parse_brief_structured(make_pdf(_HEADED))
    assert parsed.status == "ok"
    assert "usageRights" in parsed.sections
    # A section the brief lacks is simply absent from the map — NOT an error.
    assert "shipping" not in parsed.sections
    assert parsed.page_count == 1
    # flatText always populated (invariant #6).
    assert "Usage Rights" in parsed.flat_text


def test_status_ok_absent_section_distinct_from_failure():
    # A brief with NO exclusivity section → status ok, key absent (acceptance).
    lines = ["Deliverables", "3 Reels.", "Payment Terms", "Net 30 after live."]
    parsed = b.parse_brief_structured(make_pdf(lines))
    assert parsed.status == "ok"
    assert "exclusivity" not in parsed.sections


def test_corrupt_pdf_is_parse_failed_not_empty():
    parsed = b.parse_brief_structured(b"this is not a pdf at all")
    assert parsed.status == "parse_failed"
    assert parsed.flat_text == ""
    assert parsed.sections == {}


def test_empty_input_is_empty_not_failed():
    # No bytes → parsed fine, no text → empty (a scanned/image PDF behaves the same).
    parsed = b.parse_brief_structured(b"")
    assert parsed.status == "empty"
    assert parsed.flat_text == ""


# ---------------------------------------------------------------------------
# Backward compat: extract_brief_text unchanged (invariant #6).
# ---------------------------------------------------------------------------
def test_flat_text_matches_extract_brief_text():
    pdf = make_pdf(_HEADED)
    parsed = b.parse_brief_structured(pdf)
    # The derived flatText equals the standalone flat extractor for the same bytes.
    assert parsed.flat_text == b.extract_brief_text(pdf)


# ---------------------------------------------------------------------------
# /parse-brief route: flag-gated, additive, never 500s.
# ---------------------------------------------------------------------------
def test_parse_brief_route_flag_off_is_text_only(monkeypatch):
    monkeypatch.delenv("STRUCTURED_BRIEF_PARSING_ENABLED", raising=False)
    import base64

    pdf = make_pdf(_HEADED)
    req = neg.ParseBriefRequest(pdfBase64=base64.b64encode(pdf).decode())
    resp = neg.parse_brief(req)
    # Flag OFF → flat text only, sections None, with additive capability metadata.
    assert resp.sections is None
    assert "Usage Rights" in resp.text
    assert resp.status == "ok"  # default; old callers ignore it
    assert resp.parseMode == "flat"


def test_parse_brief_route_flat_empty_extraction_is_explicit(monkeypatch):
    monkeypatch.setattr(b, "extract_brief_text", lambda _raw: "")
    import base64

    encoded = base64.b64encode(b"%PDF-1.4 unreadable").decode()
    resp = neg.parse_brief(
        neg.ParseBriefRequest(pdfBase64=encoded, parseMode="flat")
    )
    assert resp.text == ""
    assert resp.status == "empty"
    assert resp.parseMode == "flat"


def test_parse_brief_route_flag_on_returns_sections(monkeypatch):
    monkeypatch.setenv("STRUCTURED_BRIEF_PARSING_ENABLED", "true")
    import base64

    pdf = make_pdf(_HEADED)
    req = neg.ParseBriefRequest(pdfBase64=base64.b64encode(pdf).decode())
    resp = neg.parse_brief(req)
    assert resp.status == "ok"
    assert resp.sections and "usageRights" in resp.sections
    assert resp.parserVersion == b.PARSER_VERSION
    assert resp.parseMode == "structured"
    assert resp.pageCount == 1


def test_parse_brief_route_explicit_mode_overrides_agent_flag(monkeypatch):
    import base64

    pdf = make_pdf(_HEADED)
    encoded = base64.b64encode(pdf).decode()

    monkeypatch.delenv("STRUCTURED_BRIEF_PARSING_ENABLED", raising=False)
    structured = neg.parse_brief(
        neg.ParseBriefRequest(pdfBase64=encoded, parseMode="structured")
    )
    assert structured.parseMode == "structured"
    assert structured.sections and "usageRights" in structured.sections

    monkeypatch.setenv("STRUCTURED_BRIEF_PARSING_ENABLED", "true")
    flat = neg.parse_brief(neg.ParseBriefRequest(pdfBase64=encoded, parseMode="flat"))
    assert flat.parseMode == "flat"
    assert flat.sections is None
    assert flat.text == b.extract_brief_text(pdf)


def test_parse_brief_route_bad_base64_is_parse_failed(monkeypatch):
    monkeypatch.setenv("STRUCTURED_BRIEF_PARSING_ENABLED", "true")
    resp = neg.parse_brief(neg.ParseBriefRequest(pdfBase64="!!!not base64!!!"))
    # base64 that decodes to garbage is caught by the parser as parse_failed; a
    # truly-un-decodable string short-circuits to parse_failed too. Either way the
    # route never 500s and never claims a clean "ok".
    assert resp.status in {"parse_failed", "empty"}
    assert resp.text == ""
    assert resp.parseMode == "structured"


# ---------------------------------------------------------------------------
# /negotiate wiring: source-of-truth block, knowledge-turn gate (§4.9, §4.10).
# ---------------------------------------------------------------------------
def _neg_req(**kw):
    base = dict(
        creatorReply=kw.pop("creatorReply", ""),
        currentOffer=neg.NegotiationTerm(rate=300),
        round=1,
        maxRounds=3,
        campaignConstraints=neg.CampaignConstraints(
            termFloor=neg.NegotiationTerm(rate=200),
            termCeiling=neg.NegotiationTerm(rate=500),
        ),
    )
    base.update(kw)
    return neg.NegotiateRequest(**base)


def test_negotiate_brief_block_renders_on_knowledge_turn():
    req = _neg_req(
        creatorReply="How long can the brand use my video?",
        campaignContext={"briefKnowledge": "Usage Rights: reshare for 90 days."},
    )
    block = neg._negotiate_brief_block(req)
    assert "<campaign_brief>" in block and "90 days" in block


def test_negotiate_brief_block_gated_off_on_non_knowledge_turn():
    # A pure-pricing turn pays nothing extra (§4.10 cost bound).
    req = _neg_req(
        creatorReply="$450 works for me, let's do it.",
        campaignContext={"briefKnowledge": "Usage Rights: reshare for 90 days."},
    )
    assert neg._negotiate_brief_block(req) == ""


def test_negotiate_brief_block_empty_without_context():
    # No campaignContext → byte-identical (invariant #9).
    req = _neg_req(creatorReply="How long can you use my video?")
    assert neg._negotiate_brief_block(req) == ""


def test_turn_wants_brief_uses_intent_and_text_signals():
    # Classifier intent alone triggers include (mid-negotiation turns lack it, so
    # text signals cover those).
    assert neg._turn_wants_brief("sounds good", "QUESTION") is True
    assert neg._turn_wants_brief("when do I get paid?", None) is True
    assert neg._turn_wants_brief("$450 works", None) is False
