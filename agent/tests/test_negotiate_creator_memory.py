"""PLU-113: campaign-scoped creator memory — extraction + sanitized DATA block.

Fake LLM injected via monkeypatch; no real model needed. Verifies:
  * flag OFF  → no extraction instruction, empty creatorFacts, no memory block;
  * flag ON   → durable facts extracted with evidence; the memory block renders as
                CONTEXT (never the offer figure).
"""

import pytest

pytest.importorskip("langgraph", reason="langgraph not installed (ai extra)")

from app.routes import negotiate as neg_mod


class FakeLLM:
    def __init__(self, outputs):
        self._outputs = list(outputs)
        self.calls = 0

    def invoke(self, _prompt):
        out = self._outputs[min(self.calls, len(self._outputs) - 1)]
        self.calls += 1

        class _R:
            content = out

        return _R()


def _req(reply="How about $480?", floor=100, ceiling=500, ctx=None):
    return neg_mod.NegotiateRequest(
        creatorReply=reply,
        currentOffer=neg_mod.NegotiationTerm(rate=floor),
        round=1,
        maxRounds=5,
        negotiationHistory=[],
        campaignContext=ctx,
        campaignConstraints=neg_mod.CampaignConstraints(
            termFloor=neg_mod.NegotiationTerm(rate=floor),
            termCeiling=neg_mod.NegotiationTerm(rate=ceiling),
        ),
    )


def _patch_llm(monkeypatch, outputs):
    monkeypatch.setenv("NEGOTIATION_STRATEGY", "rules")
    monkeypatch.setattr(
        neg_mod, "get_llm", lambda temperature=0.2, num_predict=None, **_kw: FakeLLM(outputs)
    )


# ---------------------------------------------------------------------------
# Extraction
# ---------------------------------------------------------------------------


def test_flag_off_yields_no_facts(monkeypatch):
    monkeypatch.delenv("CREATOR_MEMORY_ENABLED", raising=False)
    _patch_llm(
        monkeypatch,
        [
            '{"intent": "RATE_PROPOSAL", "creatorRateMentioned": 480, '
            '"creatorDurableFacts": [{"key": "AVAILABILITY", "value": "away in Aug", '
            '"evidenceText": "away in Aug"}]}'
        ],
    )
    resp = neg_mod._langgraph_negotiate(_req())
    # Flag off → even if the model emitted facts, none are surfaced.
    assert resp.creatorFacts == []


def test_flag_on_extracts_fact_with_evidence(monkeypatch):
    monkeypatch.setenv("CREATOR_MEMORY_ENABLED", "true")
    _patch_llm(
        monkeypatch,
        [
            '{"intent": "RATE_PROPOSAL", "creatorRateMentioned": 480, '
            '"creatorDurableFacts": [{"key": "AVAILABILITY", '
            '"value": "unavailable until August", '
            '"evidenceText": "I am travelling until August", "confidence": 0.9}]}'
        ],
    )
    resp = neg_mod._langgraph_negotiate(
        _req(reply="I am travelling until August. How about $480?")
    )
    assert len(resp.creatorFacts) == 1
    f = resp.creatorFacts[0]
    assert f.key == "AVAILABILITY"
    assert "August" in f.evidenceText
    assert f.confidence == 0.9


def test_flag_on_drops_unknown_key_and_missing_evidence(monkeypatch):
    monkeypatch.setenv("CREATOR_MEMORY_ENABLED", "true")
    _patch_llm(
        monkeypatch,
        [
            '{"intent": "GENERAL", "creatorDurableFacts": ['
            '{"key": "NOT_A_KEY", "value": "x", "evidenceText": "x"}, '
            '{"key": "OBJECTION", "value": "no perpetual rights"}]}'
        ],
    )
    resp = neg_mod._langgraph_negotiate(_req(reply="Some message"))
    # Unknown key dropped; the OBJECTION with no evidenceText dropped.
    assert resp.creatorFacts == []


# ---------------------------------------------------------------------------
# The sanitized DATA block
# ---------------------------------------------------------------------------


def test_memory_block_off_is_empty(monkeypatch):
    monkeypatch.delenv("CREATOR_MEMORY_ENABLED", raising=False)
    ctx = {"creatorMemory": {"availability": "away in Aug", "conflicts": []}}
    assert neg_mod._creator_memory_block(ctx) == ""


def test_memory_block_renders_context_not_offer(monkeypatch):
    monkeypatch.setenv("CREATOR_MEMORY_ENABLED", "true")
    ctx = {
        "creatorMemory": {
            "requestedRate": 480,
            "availability": "unavailable until August",
            "objections": ["no perpetual usage rights"],
            "conflicts": [],
        }
    }
    block = neg_mod._creator_memory_block(ctx)
    assert "<creator_memory>" in block
    assert "480" in block
    assert "CONTEXT" in block  # rate is labeled CONTEXT, not the offer
    assert "unavailable until August" in block
    assert "no perpetual usage rights" in block


def test_memory_block_surfaces_conflict(monkeypatch):
    monkeypatch.setenv("CREATOR_MEMORY_ENABLED", "true")
    ctx = {
        "creatorMemory": {
            "conflicts": [
                {"field": "AVAILABILITY", "priorValue": "free in July", "newValue": "away in July"}
            ]
        }
    }
    block = neg_mod._creator_memory_block(ctx)
    assert "CONFLICT" in block
    assert "free in July" in block
    assert "away in July" in block


def test_join_reference_blocks_single_is_byte_identical():
    # A lone knowledge block (already `---`-wrapped) must pass through unchanged so
    # the memory-off prompt stays byte-identical to today.
    knowledge = "---\n\nsome knowledge\n\n"
    assert neg_mod._join_reference_blocks(knowledge, "") == knowledge
    assert neg_mod._join_reference_blocks("", "") == ""
