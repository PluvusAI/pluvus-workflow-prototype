"""Tests for the dedicated follow-up draft prompt (H3).

Regression target: `follow_up` used to fall through to the initial-outreach
prompt (`_DRAFT_PROMPT`), which MANDATES a full product-intro paragraph — so every
follow-up re-pitched the brand from scratch and read as a duplicate cold email.
There is now a dedicated `_FOLLOWUP_PROMPT` framing a brief, low-pressure nudge.

Uses a prompt-capturing fake LLM (no real model / Ollama needed).
"""

import pytest

pytest.importorskip("langgraph", reason="langgraph not installed (ai extra)")

from app.routes import negotiate as neg_mod
from app.routes.negotiate import DraftRequest


class CapturingLLM:
    """Fake LLM that records the prompt it was asked and returns fixed JSON."""

    def __init__(self):
        self.prompt = None

    def invoke(self, prompt):
        self.prompt = prompt

        class _R:
            content = '{"subject": "Circling back", "body": "Hi Alex,\\n\\nJust following up.\\n\\nBest,\\nAcme"}'

        return _R()


def _run(monkeypatch, req: DraftRequest) -> str:
    cap = CapturingLLM()
    monkeypatch.setattr(neg_mod, "get_llm", lambda temperature=0.7, **_kw: cap)
    neg_mod._langgraph_draft(req)
    return cap.prompt


def _followup_req(**kw) -> DraftRequest:
    base = dict(
        purpose="follow_up",
        creatorName="Alex",
        creatorPlatform="Instagram",
        creatorNiche="fitness",
        senderName="Acme",
        brandDescription="Acme makes recovery supplements.",
        round=1,
    )
    base.update(kw)
    return DraftRequest(**base)


def test_followup_uses_the_dedicated_nudge_prompt(monkeypatch):
    prompt = _run(monkeypatch, _followup_req())
    # It must be framed as a follow-up reminder, not a fresh pitch.
    assert "FOLLOW-UP" in prompt
    assert "have NOT heard back" in prompt
    # And explicitly instructed NOT to re-introduce the product in full.
    assert "Do NOT re-introduce" in prompt


def test_followup_prompt_is_not_the_cold_outreach_prompt(monkeypatch):
    prompt = _run(monkeypatch, _followup_req())
    # The initial-outreach prompt mandates a dedicated PRODUCT PARAGRAPH; the
    # follow-up prompt must NOT (that's the whole bug being fixed).
    assert "DEDICATED short paragraph" not in prompt
    assert "PRODUCT PARAGRAPH" not in prompt


def test_followup_prompt_forbids_money_and_placeholders(monkeypatch):
    prompt = _run(monkeypatch, _followup_req())
    assert "Do NOT state any dollar amount" in prompt
    assert "bracketed placeholder" in prompt
    # Signs as the real sender, never Pluvus.
    assert "Acme" in prompt


def test_followup_still_returns_a_valid_draft(monkeypatch):
    cap = CapturingLLM()
    monkeypatch.setattr(neg_mod, "get_llm", lambda temperature=0.7, **_kw: cap)
    out = neg_mod._langgraph_draft(_followup_req())
    assert out.subject and out.body
    assert "following up" in out.body.lower()


# ---------------------------------------------------------------------------
# M3 — reward_confirmation purpose must be accepted (was a latent 422 on the
# real provider) and routed through the onboarding-style prompt.
# ---------------------------------------------------------------------------


def test_reward_confirmation_is_a_valid_purpose():
    # Previously "reward_confirmation" was not in DraftPurpose, so constructing a
    # DraftRequest with it raised a pydantic ValidationError → 422 on the route.
    req = DraftRequest(
        purpose="reward_confirmation",
        creatorName="Alex",
        senderName="Acme",
        proposedTerms={"rate": 500},
    )
    assert req.purpose == "reward_confirmation"


def test_reward_confirmation_routes_through_onboarding_prompt(monkeypatch):
    cap = CapturingLLM()
    monkeypatch.setattr(neg_mod, "get_llm", lambda temperature=0.7, **_kw: cap)
    req = DraftRequest(
        purpose="reward_confirmation",
        creatorName="Alex",
        creatorPlatform="Instagram",
        creatorNiche="fitness",
        senderName="Acme",
        proposedTerms={"rate": 500},
    )
    out = neg_mod._langgraph_draft(req)
    # The onboarding prompt confirms the agreed rate and lays out next steps.
    assert "CONFIRMED at an" in cap.prompt or "agreed rate" in cap.prompt
    assert "$500" in cap.prompt
    assert out.subject and out.body


# ---------------------------------------------------------------------------
# PLU-110 — negotiation_follow_up: same latent-422 class as M3. Must be a valid
# purpose and route through the follow-up nudge prompt (existing thread, no
# re-pitch, no dollar amounts) — never the cold-outreach or offer prompt.
# ---------------------------------------------------------------------------


def test_negotiation_follow_up_is_a_valid_purpose():
    req = DraftRequest(
        purpose="negotiation_follow_up",
        creatorName="Alex",
        senderName="Acme",
        round=2,
    )
    assert req.purpose == "negotiation_follow_up"


def test_negotiation_follow_up_routes_through_the_nudge_prompt(monkeypatch):
    prompt = _run(monkeypatch, _followup_req(purpose="negotiation_follow_up", round=2))
    # Framed as a reminder in an existing thread, not a fresh pitch...
    assert "FOLLOW-UP" in prompt
    assert "have NOT heard back" in prompt
    # ...never the cold-outreach product paragraph...
    assert "DEDICATED short paragraph" not in prompt
    # ...and never a dollar amount (the standing offer is re-surfaced, not re-quoted).
    assert "Do NOT state any dollar amount" in prompt
