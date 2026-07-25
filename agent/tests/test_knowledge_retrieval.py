"""PLU-114 — deterministic campaign-knowledge retrieval router.

Covers every §8 unit case with NO model call — the router is pure (invariant #2).
Tests the selection function directly: message routing, obligation widening,
broad-question widening, the no_match outcome, honest-defer (requested_but_
unavailable), the section cap + dropped recording, and source provenance.
"""

from __future__ import annotations

import app.knowledge_retrieval as kr
from app.knowledge_retrieval import (
    AvailableSections,
    Obligation,
    select_knowledge_sections,
)


def _sel_keys(result) -> list[str]:
    return [s.section for s in result.sections]


def _avail(**fields) -> AvailableSections:
    """AvailableSections with the given flat fields (all others absent)."""
    return AvailableSections(fields=dict(fields))


# Values present for every routable key, so a match resolves to `available`
# unless a test deliberately withholds one.
FULL_FIELDS = dict(
    usageRights="30-day reshare on paid + organic social.",
    exclusivity="No category exclusivity.",
    paymentTerms="Net-30 after content goes live.",
    timeline="Go live within 3 weeks.",
    deliverables="2 Reels + 1 Story.",
    shipping="We ship the product within 5 business days.",
    attributionWindow="30-day attribution window.",
)


# ---------------------------------------------------------------------------
# §8 acceptance: single-topic message selection
# ---------------------------------------------------------------------------


def test_usage_rights_question_selects_only_usage_rights():
    result = select_knowledge_sections(
        "How long can the brand use my video?",
        [],
        _avail(**FULL_FIELDS),
    )
    assert result.outcome == "matched"
    assert _sel_keys(result) == ["usageRights"]


def test_payment_question_selects_only_payment_terms():
    result = select_knowledge_sections(
        "When do I get paid?",
        [],
        _avail(**FULL_FIELDS),
    )
    assert result.outcome == "matched"
    assert _sel_keys(result) == ["paymentTerms"]


def test_shipping_question_selects_only_shipping():
    result = select_knowledge_sections(
        "What's the shipping address you need, and when does the product arrive?",
        [],
        _avail(**FULL_FIELDS),
    )
    assert result.outcome == "matched"
    assert _sel_keys(result) == ["shipping"]


def test_attribution_question_resolves_from_flat_field_only():
    # attributionWindow is flat-field-only (REVIEW #3) — never from brief.
    result = select_knowledge_sections(
        "How long is the attribution cookie window?",
        [],
        _avail(attributionWindow="30-day attribution window."),
    )
    assert result.outcome == "matched"
    assert _sel_keys(result) == ["attributionWindow"]
    src = next(s for s in result.sources if s.section == "attributionWindow")
    assert src.resolved_from == "campaign_field:attributionWindow"


# ---------------------------------------------------------------------------
# §8 acceptance: broad question widens to multiple sections
# ---------------------------------------------------------------------------


def test_broad_question_selects_multiple_sections():
    result = select_knowledge_sections(
        "Can you walk me through the whole deal?",
        [],
        _avail(**FULL_FIELDS),
    )
    assert result.outcome == "broad"
    keys = _sel_keys(result)
    assert len(keys) > 1
    # Core-commercial set; shipping/overview deliberately excluded from broad.
    assert set(keys) == set(kr.BROAD_SECTIONS)
    assert "shipping" not in keys


def test_what_are_the_terms_is_broad():
    result = select_knowledge_sections(
        "What are the terms?",
        [],
        _avail(**FULL_FIELDS),
    )
    assert result.outcome == "broad"
    assert len(_sel_keys(result)) > 1


def test_specific_question_beats_broad_widening():
    # A specific payment ask must NOT blow up to the whole commercial set even
    # though "when do I get paid" is a somewhat broad-sounding sentence.
    result = select_knowledge_sections(
        "When do I get paid?",
        [],
        _avail(**FULL_FIELDS),
    )
    assert result.outcome == "matched"
    assert _sel_keys(result) == ["paymentTerms"]


# ---------------------------------------------------------------------------
# §8 acceptance: no_match is explicit, never []
# ---------------------------------------------------------------------------


def test_no_topic_no_obligation_is_no_match():
    result = select_knowledge_sections(
        "Sounds good, looking forward to it!",
        [],
        _avail(**FULL_FIELDS),
    )
    assert result.outcome == "no_match"
    assert result.sections == ()


def test_no_match_is_distinct_from_matched_empty_value():
    # A selected-but-absent value is `matched`+requested_but_unavailable — NOT
    # no_match. The caller must be able to tell them apart (invariant #3/#4).
    result = select_knowledge_sections(
        "How long can you use my content?",
        [],
        _avail(),  # no usageRights configured
    )
    assert result.outcome == "matched"
    assert result.sections[0].availability == "requested_but_unavailable"


# ---------------------------------------------------------------------------
# §8 acceptance: honest defer when a selected section's value is absent
# ---------------------------------------------------------------------------


def test_selected_but_unavailable_defers_honestly():
    result = select_knowledge_sections(
        "How long can the brand use my video?",
        [],
        _avail(),  # nothing configured
    )
    assert result.outcome == "matched"
    assert _sel_keys(result) == ["usageRights"]
    sec = result.sections[0]
    assert sec.availability == "requested_but_unavailable"
    assert sec.value is None  # never an invented value (invariant #4)
    assert result.unavailable == ("usageRights",)
    # Its source record carries no resolvedFrom (nothing to trace to).
    assert result.sources[0].resolved_from is None


def test_value_resolves_from_brief_when_no_flat_field():
    # Flat field absent but a structured brief section present → available, brief.
    result = select_knowledge_sections(
        "How long can you use my content?",
        [],
        AvailableSections(
            fields={},
            brief={"usageRights": "You retain rights; 30-day paid reshare only."},
        ),
    )
    sec = result.sections[0]
    assert sec.availability == "available"
    assert sec.resolved_from == "brief_section:usageRights"


def test_flat_field_is_authoritative_over_brief():
    # Both present → flat field wins (invariant #1).
    result = select_knowledge_sections(
        "How long can you use my content?",
        [],
        AvailableSections(
            fields={"usageRights": "FLAT usage value."},
            brief={"usageRights": "BRIEF usage value."},
        ),
    )
    sec = result.sections[0]
    assert sec.value == "FLAT usage value."
    assert sec.resolved_from == "campaign_field:usageRights"


# ---------------------------------------------------------------------------
# §8: obligation widens retrieval even when the latest message is silent (inv #5)
# ---------------------------------------------------------------------------


def test_open_shipping_obligation_pulls_shipping_when_message_silent():
    result = select_knowledge_sections(
        "Sounds good, any update?",  # no shipping words at all
        [Obligation(original_text="when does the product ship?", category="shipping", id="ob1")],
        _avail(**FULL_FIELDS),
    )
    assert "shipping" in _sel_keys(result)
    src = next(s for s in result.sources if s.section == "shipping")
    assert src.rule == "obligation_category"
    assert src.trigger == "obligation:ob1"


def test_usage_rights_obligation_pulls_both_usage_and_exclusivity():
    # CATEGORY_TO_SECTIONS.usage_rights folds exclusivity vocab → two sections.
    result = select_knowledge_sections(
        "Any update?",
        [Obligation(original_text="what are the usage terms?", category="usage_rights", id="ob2")],
        _avail(**FULL_FIELDS),
    )
    keys = set(_sel_keys(result))
    assert {"usageRights", "exclusivity"} <= keys


def test_uncategorized_obligation_routes_via_its_text():
    # No category → run originalText through SECTION_MAP.
    ob = Obligation(original_text="you still owe me the payment schedule", category=None, id="ob3")
    result = select_knowledge_sections("Any update?", [ob], _avail(**FULL_FIELDS))
    assert "paymentTerms" in _sel_keys(result)
    src = next(s for s in result.sources if s.section == "paymentTerms")
    assert src.trigger == "obligation:ob3"


def test_obligation_only_never_no_match():
    # Message has no topic, but an open obligation does → matched, not no_match.
    result = select_knowledge_sections(
        "ok!",
        [Obligation(original_text="when does it ship?", category="shipping", id="ob4")],
        _avail(**FULL_FIELDS),
    )
    assert result.outcome == "matched"
    assert _sel_keys(result) == ["shipping"]


# ---------------------------------------------------------------------------
# §8: cap drops lowest-priority sections and records them (invariant #7)
# ---------------------------------------------------------------------------


def test_cap_drops_lowest_priority_and_records_dropped():
    # Force > MAX_SELECTED_SECTIONS by combining a broad message (5 commercial)
    # with two extra obligation-sourced sections (shipping + timeline already in
    # broad). Use shipping (not in broad) + attribution obligation via text.
    obligations = [
        Obligation(original_text="when does it ship?", category="shipping", id="s"),
    ]
    result = select_knowledge_sections(
        "walk me through everything about the deal",  # broad → 5 commercial
        obligations,
        _avail(**FULL_FIELDS),
    )
    # broad set (5) + shipping (1) = 6 candidates, cap = 5 → 1 dropped.
    assert len(result.sections) == kr.MAX_SELECTED_SECTIONS
    assert len(result.dropped) == 1
    # Obligation-sourced shipping is kept (we owe it); a message/broad section drops.
    assert "shipping" in _sel_keys(result)
    assert result.dropped[0] not in _sel_keys(result)


def test_obligation_sourced_sections_survive_cap():
    # Three obligations across distinct sections + a broad message; obligation
    # sections must all survive.
    obligations = [
        Obligation(original_text="ship?", category="shipping", id="a"),
        Obligation(original_text="pay?", category="payment", id="b"),
    ]
    result = select_knowledge_sections(
        "tell me everything",
        obligations,
        _avail(**FULL_FIELDS),
    )
    kept = set(_sel_keys(result))
    assert "shipping" in kept  # obligation-sourced, not in broad set
    assert "paymentTerms" in kept


# ---------------------------------------------------------------------------
# §8: sources populated with {section, rule, trigger} for every selection
# ---------------------------------------------------------------------------


def test_sources_populated_for_every_selection():
    result = select_knowledge_sections(
        "When do I get paid?",
        [Obligation(original_text="when does it ship?", category="shipping", id="ob")],
        _avail(**FULL_FIELDS),
    )
    selected = set(_sel_keys(result))
    sourced = {s.section for s in result.sources}
    assert selected == sourced
    for s in result.sources:
        assert s.section
        assert s.rule
        assert s.trigger


def test_message_source_trigger_is_message():
    result = select_knowledge_sections("When do I get paid?", [], _avail(**FULL_FIELDS))
    assert result.sources[0].trigger == "message"
    assert result.sources[0].rule == "payment_question"


# ---------------------------------------------------------------------------
# Edge cases
# ---------------------------------------------------------------------------


def test_empty_message_no_obligations_is_no_match():
    assert select_knowledge_sections("", [], _avail(**FULL_FIELDS)).outcome == "no_match"


def test_multi_topic_message_unions_sections():
    result = select_knowledge_sections(
        "When do I get paid, and how long can you use the content?",
        [],
        _avail(**FULL_FIELDS),
    )
    assert set(_sel_keys(result)) == {"paymentTerms", "usageRights"}
    assert result.outcome == "matched"


def test_section_never_duplicated_when_message_and_obligation_agree():
    # Same section from both message and obligation → one selection, obligation
    # provenance wins (we owe it).
    result = select_knowledge_sections(
        "when do I get paid?",
        [Obligation(original_text="payment schedule?", category="payment", id="p")],
        _avail(**FULL_FIELDS),
    )
    assert _sel_keys(result).count("paymentTerms") == 1
    src = next(s for s in result.sources if s.section == "paymentTerms")
    assert src.rule == "obligation_category"
    assert src.trigger == "obligation:p"
