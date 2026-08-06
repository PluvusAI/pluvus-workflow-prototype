"""PLU-129 — commission-only (0/0 fee band) negotiation behavior.

An Affiliate campaign persists the canonical "no fee band" shape
(minBudget:0, maxBudget:0) plus a positive commission. Before PLU-129 the agent
resolved the ceiling via `rate or float("inf")`, so an EXPLICIT zero ceiling
(0) was treated as falsy → inf, and the agent would negotiate an UNBOUNDED
fixed fee on a campaign that offers no upfront fee.

With the fix, an explicit numeric 0 ceiling is a real cap (floor 0 / ceiling 0):
there is no fixed fee to negotiate, so any upfront-fee ask above $0 trips the
existing over-ceiling ESCALATE path — "follow the existing exception/escalation
policy rather than silently creating a fixed-fee offer" (AC #10). A creator who
is merely interested / asks about the commission still proceeds (no fee ask →
no escalation).
"""

import pytest

pytest.importorskip("langgraph", reason="langgraph not installed (ai extra)")
from app.routes import negotiate as neg_mod  # noqa: E402


class _FakeLLM:
    def __init__(self, output):
        self._output = output

    def invoke(self, _prompt):
        class _R:
            content = self._output

        return _R()


def _commission_only_req(creator_reply):
    """A 0/0 fee band (commission-only) request — the affiliate template shape."""
    return neg_mod.NegotiateRequest(
        creatorReply=creator_reply,
        currentOffer=neg_mod.NegotiationTerm(rate=0),
        round=1,
        maxRounds=5,
        negotiationHistory=[],
        campaignConstraints=neg_mod.CampaignConstraints(
            termFloor=neg_mod.NegotiationTerm(rate=0),
            termCeiling=neg_mod.NegotiationTerm(rate=0),
            commissionRate=15,
        ),
    )


# ---------------------------------------------------------------------------
# LLM strategy path (the default since MED-L1).
# ---------------------------------------------------------------------------


def test_upfront_fee_ask_on_commission_only_escalates_llm(monkeypatch):
    # The creator asks for a fixed upfront fee on a commission-only campaign. The
    # model would counter, but the guards see the ask ($500) above the ceiling (0)
    # → ESCALATE. A commission-only campaign never negotiates a fixed fee.
    monkeypatch.setenv("NEGOTIATION_STRATEGY", "llm")
    out = (
        '{"intent": "RATE_PROPOSAL", "action": "COUNTER", '
        '"response": "How about $300?", "creatorRateMentioned": 500}'
    )
    monkeypatch.setattr(neg_mod, "get_llm", lambda temperature=0, **_kw: _FakeLLM(out))
    r = neg_mod._langgraph_negotiate(_commission_only_req("Could you do $500 upfront?"))
    assert r.action == "ESCALATE"
    # An ESCALATE carries no fabricated fee.
    assert r.proposedTerms is None


# ---------------------------------------------------------------------------
# Deterministic rules path.
# ---------------------------------------------------------------------------


def test_upfront_fee_ask_on_commission_only_escalates_rules(monkeypatch):
    monkeypatch.setenv("NEGOTIATION_STRATEGY", "rules")
    out = (
        '{"intent": "RATE_PROPOSAL", "response": "Let me check.", '
        '"creatorRateMentioned": 500}'
    )
    monkeypatch.setattr(neg_mod, "get_llm", lambda temperature=0, **_kw: _FakeLLM(out))
    r = neg_mod._langgraph_negotiate(_commission_only_req("Could you do $500 upfront?"))
    assert r.action == "ESCALATE"
    assert r.proposedTerms is None


def test_interested_commission_question_proceeds_rules(monkeypatch):
    # The creator is interested and asks about the commission — NO upfront-fee ask.
    # On a 0/0 band a RATE_DISCOVERY turn PRESENTS our standing offer (the $0 fixed
    # fee — commission carries the deal); it must NOT escalate. This is the "follow
    # the happy path, don't page a human just because the creator is curious" side
    # of AC #10.
    monkeypatch.setenv("NEGOTIATION_STRATEGY", "rules")
    out = (
        '{"intent": "RATE_DISCOVERY", '
        '"response": "You earn 15% commission on every attributed sale.", '
        '"creatorRateMentioned": null}'
    )
    monkeypatch.setattr(neg_mod, "get_llm", lambda temperature=0, **_kw: _FakeLLM(out))
    r = neg_mod._langgraph_negotiate(
        _commission_only_req("Sounds interesting — what's the commission?")
    )
    assert r.action == "PRESENT_OFFER"
    assert r.action != "ESCALATE"
    # The presented fixed fee is $0 — there is no upfront fee, the commission
    # (stated in the copy) carries the deal.
    assert r.proposedTerms == {"rate": 0.0}
