"""PLU-114 W8 (Calvin follow-up §5) — constrained topic classifier tests.

Covers three layers:
  1. `build_selection_from_sections` — the pure, deterministic resolver the
     classifier feeds into (values NEVER come from the classifier).
  2. `knowledge_classifier` — closed-schema coercion, category→section mapping,
     and fail-soft behavior (uses a fake LLM; no real model needed).
  3. The `_selected_knowledge_block` wiring — the classifier runs ONLY on the
     uncertain branch, only when its sub-flag is on, and a confident result
     narrows while low-confidence/unknown keeps the full-context fallback.
"""

from __future__ import annotations

import pytest

from app.knowledge_retrieval import (
    AvailableSections,
    build_selection_from_sections,
)
import app.knowledge_classifier as kc


# ---------------------------------------------------------------------------
# 1. build_selection_from_sections — deterministic resolution (no classifier)
# ---------------------------------------------------------------------------


def test_build_selection_resolves_values_deterministically():
    av = AvailableSections(
        fields={"paymentTerms": "Net 30", "usageRights": "6 months paid"},
        brief={"timeline": "Live by Aug 1"},
    )
    sel = build_selection_from_sections(
        ["paymentTerms", "usageRights", "timeline"], av, rule="classifier", trigger="classifier"
    )
    assert sel.outcome == "matched"
    assert sel.confidence == "high"
    by_key = {s.section: s for s in sel.sections}
    assert by_key["paymentTerms"].value == "Net 30"
    assert by_key["paymentTerms"].resolved_from == "campaign_field:paymentTerms"
    assert by_key["timeline"].value == "Live by Aug 1"
    assert by_key["timeline"].resolved_from == "brief_section:timeline"
    # Provenance is stamped as classifier-sourced for observability.
    assert all(s.rule == "classifier" and s.trigger == "classifier" for s in sel.sources)


def test_build_selection_unavailable_section_defers_never_fabricates():
    av = AvailableSections(fields={"paymentTerms": "Net 30"}, brief={})
    sel = build_selection_from_sections(
        ["paymentTerms", "shipping"], av, rule="classifier", trigger="classifier"
    )
    by_key = {s.section: s for s in sel.sections}
    assert by_key["shipping"].availability == "requested_but_unavailable"
    assert by_key["shipping"].value is None
    assert "shipping" in sel.unavailable


def test_build_selection_empty_or_unknown_is_no_match():
    av = AvailableSections(fields={"paymentTerms": "Net 30"}, brief={})
    assert build_selection_from_sections([], av, rule="classifier", trigger="c").outcome == "no_match"
    # Only off-schema keys → nothing kept → no_match (never a stripped narrow block).
    assert (
        build_selection_from_sections(["bogus"], av, rule="classifier", trigger="c").outcome  # type: ignore[list-item]
        == "no_match"
    )


def test_build_selection_dedups_and_caps():
    av = AvailableSections(fields={}, brief={})
    # 6 distinct sections + a duplicate → dedup, then cap at MAX_SELECTED_SECTIONS (5).
    sel = build_selection_from_sections(
        [
            "deliverables",
            "paymentTerms",
            "usageRights",
            "exclusivity",
            "timeline",
            "shipping",
            "paymentTerms",
        ],
        av,
        rule="classifier",
        trigger="classifier",
    )
    assert len(sel.sections) == 5
    assert len(sel.dropped) == 1


# ---------------------------------------------------------------------------
# 2. knowledge_classifier — mapping + closed schema + fail-soft
# ---------------------------------------------------------------------------


def test_flag_defaults_off(monkeypatch):
    monkeypatch.delenv("KNOWLEDGE_CLASSIFIER_ENABLED", raising=False)
    assert kc.knowledge_classifier_enabled() is False
    monkeypatch.setenv("KNOWLEDGE_CLASSIFIER_ENABLED", "true")
    assert kc.knowledge_classifier_enabled() is True


def test_categories_to_sections_broad_and_unknown():
    from app.knowledge_retrieval import BROAD_SECTIONS

    assert kc._categories_to_sections(["broad"]) == list(BROAD_SECTIONS)
    assert kc._categories_to_sections(["unknown"]) == []
    # Specific + dedup + drop unknown/off-schema, order preserved.
    assert kc._categories_to_sections(
        ["paymentTerms", "usageRights", "unknown", "paymentTerms"]
    ) == ["paymentTerms", "usageRights"]


def test_llm_output_coercion_drops_off_schema_labels():
    o = kc._ClassifierLLMOutput.model_validate(
        {"categories": ["paymentTerms", "notreal", "shipping"], "confidence": "high"}
    )
    assert o.categories == ["paymentTerms", "shipping"]
    # All off-schema → coerced to unknown (never an empty/invalid response).
    o2 = kc._ClassifierLLMOutput.model_validate({"categories": ["garbage"], "confidence": "low"})
    assert o2.categories == ["unknown"]
    # A bare string is accepted and wrapped.
    o3 = kc._ClassifierLLMOutput.model_validate({"categories": "timeline", "confidence": "high"})
    assert o3.categories == ["timeline"]


class _FakeLLM:
    def __init__(self, output: str):
        self._output = output

    def invoke(self, _prompt):
        class _R:
            content = self._output

        return _R()


def _patch_classifier_llm(monkeypatch, output: str):
    monkeypatch.setattr(kc, "get_llm", lambda temperature=0, **_kw: _FakeLLM(output))


def test_classify_confident_maps_to_sections(monkeypatch):
    _patch_classifier_llm(
        monkeypatch, '{"categories": ["paymentTerms"], "confidence": "high"}'
    )
    res = kc.classify_knowledge_topics("when will the funds hit my account?")
    assert res.sections == ["paymentTerms"]
    assert res.confidence == "high"


def test_classify_unknown_yields_no_sections(monkeypatch):
    _patch_classifier_llm(monkeypatch, '{"categories": ["unknown"], "confidence": "high"}')
    res = kc.classify_knowledge_topics("sounds great, let's do it!")
    assert res.sections == []


def test_classify_fails_soft_on_garbage(monkeypatch):
    # Unparseable output → StructuredOutputError inside → soft unknown, empty sections.
    _patch_classifier_llm(monkeypatch, "not json at all")
    res = kc.classify_knowledge_topics("anything")
    assert res.sections == []
    assert res.confidence == "low"


def test_classify_empty_message_short_circuits(monkeypatch):
    # No model call needed for an empty message.
    called = {"n": 0}

    def _boom(*_a, **_k):
        called["n"] += 1
        raise AssertionError("get_llm should not be called for empty message")

    monkeypatch.setattr(kc, "get_llm", _boom)
    res = kc.classify_knowledge_topics("   ")
    assert res.sections == []
    assert called["n"] == 0


# ---------------------------------------------------------------------------
# 3. _selected_knowledge_block wiring — classifier only on the uncertain branch
# ---------------------------------------------------------------------------

import app.routes.negotiate as neg  # noqa: E402


def _enable_retrieval(monkeypatch, classifier: bool):
    monkeypatch.setenv("KNOWLEDGE_RETRIEVAL_ENABLED", "true")
    if classifier:
        monkeypatch.setenv("KNOWLEDGE_CLASSIFIER_ENABLED", "true")
    else:
        monkeypatch.delenv("KNOWLEDGE_CLASSIFIER_ENABLED", raising=False)


def test_classifier_never_runs_when_subflag_off(monkeypatch):
    _enable_retrieval(monkeypatch, classifier=False)

    def _boom(_msg):
        raise AssertionError("classifier must not run with its sub-flag off")

    monkeypatch.setattr(neg, "classify_knowledge_topics", _boom)
    # A message the deterministic router does NOT match → no_match branch.
    out = neg._selected_knowledge_block(
        "hey, hope you are doing well",
        {"paymentTerms": "Net 30"},
        {},
        "negotiate",
    )
    assert out is None  # kept the full-context fallback, classifier never touched


def test_classifier_not_run_on_confident_deterministic_match(monkeypatch):
    _enable_retrieval(monkeypatch, classifier=True)

    def _boom(_msg):
        raise AssertionError("classifier must not run on the confident fast path")

    monkeypatch.setattr(neg, "classify_knowledge_topics", _boom)
    # "when do I get paid?" hits the deterministic payment rule (high confidence).
    out = neg._selected_knowledge_block(
        "quick q — when do I get paid?",
        {"paymentTerms": "Net 30"},
        {},
        "negotiate",
    )
    assert out is not None
    assert "Net 30" in out


# A genuine deterministic no_match — the regexes don't fire on this paraphrase, but
# a human (and the classifier) reads it as a payment question. Verified in the
# deterministic router before use, so this test exercises the classifier branch.
_PARAPHRASE_NO_MATCH = "what does the compensation look like on your end"


def test_classifier_recovers_paraphrase_on_no_match(monkeypatch):
    _enable_retrieval(monkeypatch, classifier=True)
    # A paraphrase the regex misses; classifier confidently says paymentTerms.
    monkeypatch.setattr(
        neg,
        "classify_knowledge_topics",
        lambda _msg: kc.ClassifierResult(["paymentTerms"], "high", ["paymentTerms"]),
    )
    out = neg._selected_knowledge_block(
        _PARAPHRASE_NO_MATCH,
        {"paymentTerms": "Net 30"},
        {},
        "negotiate",
    )
    assert out is not None
    assert "Net 30" in out


def test_classifier_low_confidence_keeps_fallback(monkeypatch):
    _enable_retrieval(monkeypatch, classifier=True)
    monkeypatch.setattr(
        neg,
        "classify_knowledge_topics",
        lambda _msg: kc.ClassifierResult(["paymentTerms"], "low", ["paymentTerms"]),
    )
    out = neg._selected_knowledge_block(
        _PARAPHRASE_NO_MATCH,
        {"paymentTerms": "Net 30"},
        {},
        "negotiate",
    )
    assert out is None  # low classifier confidence → full-context fallback


def test_classifier_unknown_keeps_fallback(monkeypatch):
    _enable_retrieval(monkeypatch, classifier=True)
    monkeypatch.setattr(
        neg,
        "classify_knowledge_topics",
        lambda _msg: kc.ClassifierResult([], "high", ["unknown"]),
    )
    out = neg._selected_knowledge_block(
        "just saying hi", {"paymentTerms": "Net 30"}, {}, "negotiate"
    )
    assert out is None


def test_classifier_flat_brief_safety_holds(monkeypatch):
    # Classifier picks a section we have NO configured value for, but a flat brief
    # blob is present → fall back (never a false defer while the blob may hold it).
    _enable_retrieval(monkeypatch, classifier=True)
    monkeypatch.setattr(
        neg,
        "classify_knowledge_topics",
        lambda _msg: kc.ClassifierResult(["shipping"], "high", ["shipping"]),
    )
    out = neg._selected_knowledge_block(
        "when will the box arrive",
        {},  # no flat field for shipping
        {"briefKnowledge": "Full brief text mentioning shipping in prose."},
        "negotiate",
    )
    assert out is None  # §4.2 flat-brief safety net still applies to classifier path


def test_classifier_failure_keeps_fallback(monkeypatch):
    _enable_retrieval(monkeypatch, classifier=True)

    def _raise(_msg):
        raise RuntimeError("model exploded")

    monkeypatch.setattr(neg, "classify_knowledge_topics", _raise)
    out = neg._selected_knowledge_block(
        _PARAPHRASE_NO_MATCH,
        {"paymentTerms": "Net 30"},
        {},
        "negotiate",
    )
    assert out is None  # exception is swallowed → full-context fallback
