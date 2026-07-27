"""PLU-114 — prompt-level tests for the selected-knowledge swap on BOTH endpoints.

Two acceptance properties (§8 "prompt-level"):
  1. Flag ON + a single-topic question → the assembled block contains ONLY the
     selected section, not the other flat facts and not the 4000-char brief blob.
  2. Flag OFF → the block is BYTE-IDENTICAL to today (the flat _knowledge_block /
     _brief_knowledge_block / _negotiate_brief_block path is used verbatim).

These drive the real prompt-assembly helpers (`_selected_knowledge_block`,
`_negotiate_knowledge_block`) — no model call. The flag is toggled via monkeypatch
so OFF/ON both run in one suite.
"""

from __future__ import annotations

import app.routes.negotiate as neg


# ---------------------------------------------------------------------------
# Fixtures — request factories mirroring the existing test_brief_structured ones.
# ---------------------------------------------------------------------------
def _neg_req(**kw):
    ctx = kw.pop("campaignContext", None)
    constraints = neg.CampaignConstraints(
        termFloor=neg.NegotiationTerm(rate=200),
        termCeiling=neg.NegotiationTerm(rate=500),
        deliverables=kw.pop("deliverables", None),
        timeline=kw.pop("timeline", None),
    )
    base = dict(
        creatorReply=kw.pop("creatorReply", ""),
        currentOffer=neg.NegotiationTerm(rate=300),
        round=1,
        maxRounds=3,
        campaignConstraints=constraints,
    )
    if ctx is not None:
        base["campaignContext"] = ctx
    base.update(kw)
    return neg.NegotiateRequest(**base)


def _draft_req(**kw):
    base = dict(
        purpose="counter_offer",
        creatorName="Maya",
        creatorReply=kw.pop("creatorReply", ""),
    )
    base.update(kw)
    return neg.DraftRequest(**base)


# The four flat knowledge facts, so a match resolves to `available` and the
# no-swap (OFF) path renders all four.
FLAT_CTX = {
    "usageRights": "30-day reshare on paid + organic.",
    "exclusivity": "No category exclusivity.",
    "paymentTerms": "Net-30 after content goes live.",
    "attributionWindow": "30-day attribution window.",
}


# ---------------------------------------------------------------------------
# Flag OFF → byte-identical to today (both endpoints).
# ---------------------------------------------------------------------------


def test_draft_block_off_is_identical_to_flat_blocks(monkeypatch):
    monkeypatch.delenv("KNOWLEDGE_RETRIEVAL_ENABLED", raising=False)
    req = _draft_req(creatorReply="How long can the brand use my video?")
    ctx = dict(FLAT_CTX)
    # With the flag OFF, _selected_knowledge_block returns None → caller uses the
    # flat blocks. Assert the helper itself signals "fall back".
    result = neg._selected_knowledge_block(
        req.creatorReply, neg._router_fields_from_draft(req, ctx), ctx, "draft"
    )
    assert result is None


def test_negotiate_block_off_equals_negotiate_brief_block(monkeypatch):
    monkeypatch.delenv("KNOWLEDGE_RETRIEVAL_ENABLED", raising=False)
    req = _neg_req(
        creatorReply="How long can the brand use my video?",
        campaignContext={"briefKnowledge": "Usage Rights: reshare for 90 days."},
    )
    # OFF → the wrapper defers to _negotiate_brief_block verbatim (byte-identical).
    assert neg._negotiate_knowledge_block(req) == neg._negotiate_brief_block(req)
    assert "<campaign_brief>" in neg._negotiate_knowledge_block(req)


def test_negotiate_block_off_non_knowledge_turn_empty(monkeypatch):
    monkeypatch.delenv("KNOWLEDGE_RETRIEVAL_ENABLED", raising=False)
    req = _neg_req(
        creatorReply="$450 works, let's go.",
        campaignContext={"briefKnowledge": "Usage Rights: reshare for 90 days."},
    )
    assert neg._negotiate_knowledge_block(req) == ""


# ---------------------------------------------------------------------------
# Flag ON → only the selected section, not the whole brief / other facts.
# ---------------------------------------------------------------------------


def test_draft_block_on_single_topic_selects_only_that_section(monkeypatch):
    monkeypatch.setenv("KNOWLEDGE_RETRIEVAL_ENABLED", "true")
    req = _draft_req(creatorReply="How long can the brand use my content?")
    ctx = dict(FLAT_CTX)
    block = neg._selected_knowledge_block(
        req.creatorReply, neg._router_fields_from_draft(req, ctx), ctx, "draft"
    )
    assert block is not None
    # ONLY the usage-rights value is present …
    assert "30-day reshare on paid + organic." in block
    # … and none of the OTHER three flat facts leaked in.
    assert "Net-30" not in block
    assert "attribution window" not in block
    assert "category exclusivity" not in block.lower()


def test_draft_block_on_drops_the_whole_brief_blob(monkeypatch):
    monkeypatch.setenv("KNOWLEDGE_RETRIEVAL_ENABLED", "true")
    # A big brief blob is threaded AND a specific usage question is asked. The ON
    # path must NOT fold the whole blob in — only the selected section.
    big_blob = "SHIPPING: mail within 5 days. " * 200  # ~5.6k chars, the baseline
    ctx = dict(FLAT_CTX)
    ctx["briefKnowledge"] = big_blob
    req = _draft_req(creatorReply="How long can you use my content?")
    block = neg._selected_knowledge_block(
        req.creatorReply, neg._router_fields_from_draft(req, ctx), ctx, "draft"
    )
    assert block is not None
    assert "<campaign_brief>" not in block  # the blob framing is gone
    assert "mail within 5 days" not in block  # the blob content is gone
    assert len(block) < 500  # tiny, single-section block — not the 5.6k blob


def test_negotiate_block_on_single_topic(monkeypatch):
    monkeypatch.setenv("KNOWLEDGE_RETRIEVAL_ENABLED", "true")
    req = _neg_req(
        creatorReply="When do I get paid?",
        campaignContext=dict(FLAT_CTX),
    )
    block = neg._negotiate_knowledge_block(req)
    assert "Net-30 after content goes live." in block
    assert "reshare" not in block  # usage-rights fact not volunteered
    assert block.startswith("---")  # same ---wrapped slot the brief block used


def test_negotiate_block_on_no_match_falls_back_to_full_context(monkeypatch):
    """Calvin follow-up §3.2 (replaces test_negotiate_block_on_no_match_is_empty).
    On no_match the negotiate side must degrade to the SAME broader context /draft
    falls back to — the flat knowledge facts — NOT a stripped "" prompt."""
    monkeypatch.setenv("KNOWLEDGE_RETRIEVAL_ENABLED", "true")
    req = _neg_req(
        creatorReply="Sounds great, looking forward to it!",
        campaignContext=dict(FLAT_CTX),
    )
    block = neg._negotiate_knowledge_block(req)
    # Not stripped: the flat knowledge facts are present (parity with /draft's flat
    # _knowledge_block fallback).
    assert block != ""
    assert "Net-30 after content goes live." in block
    assert block.startswith("---")


def test_negotiate_no_match_matches_draft_full_context(monkeypatch):
    """§3.2 parity: on a non-knowledge (no_match) turn, the negotiate full-context
    fallback carries the same flat knowledge facts the draft fallback would."""
    monkeypatch.setenv("KNOWLEDGE_RETRIEVAL_ENABLED", "true")
    ctx = dict(FLAT_CTX)
    neg_req = _neg_req(creatorReply="Sounds great!", campaignContext=ctx)
    draft_req = _draft_req(creatorReply="Sounds great!")
    # Draft side: no_match → None → caller renders the flat _knowledge_block.
    assert (
        neg._selected_knowledge_block(
            draft_req.creatorReply, neg._router_fields_from_draft(draft_req, ctx), ctx, "draft"
        )
        is None
    )
    draft_flat = neg._knowledge_block(draft_req, ctx)
    neg_block = neg._negotiate_knowledge_block(neg_req)
    # Every flat fact the draft path would render is present in the negotiate
    # fallback too.
    for _key, label in neg._KNOWLEDGE_LABELS:
        if label in draft_flat:
            assert ctx[_key] in neg_block


def test_draft_block_on_no_match_falls_back(monkeypatch):
    monkeypatch.setenv("KNOWLEDGE_RETRIEVAL_ENABLED", "true")
    req = _draft_req(creatorReply="Thanks, talk soon!")
    ctx = dict(FLAT_CTX)
    # no_match → None → caller renders the flat blocks (no regression).
    result = neg._selected_knowledge_block(
        req.creatorReply, neg._router_fields_from_draft(req, ctx), ctx, "draft"
    )
    assert result is None


# ---------------------------------------------------------------------------
# Honest defer: selected-but-unavailable renders a defer instruction, no value.
# ---------------------------------------------------------------------------


def test_on_selected_but_unavailable_defers_no_invented_value(monkeypatch):
    monkeypatch.setenv("KNOWLEDGE_RETRIEVAL_ENABLED", "true")
    # Ask about usage rights, but NO usageRights configured and no brief section.
    req = _draft_req(creatorReply="How long can you use my content?")
    ctx = {}  # nothing configured
    block = neg._selected_knowledge_block(
        req.creatorReply, neg._router_fields_from_draft(req, ctx), ctx, "draft"
    )
    assert block is not None
    low = block.lower()
    assert "do not" in low and ("confirm" in low or "follow up" in low)
    # No fabricated day-count / value.
    assert "30-day" not in block


# ---------------------------------------------------------------------------
# Brief-section source: value resolves from a threaded brief section.
# ---------------------------------------------------------------------------


def test_on_resolves_from_brief_section(monkeypatch):
    monkeypatch.setenv("KNOWLEDGE_RETRIEVAL_ENABLED", "true")
    req = _draft_req(creatorReply="What's the go-live timeline?")
    ctx = {"briefSections": {"timeline": "Content must go live by March 15."}}
    block = neg._selected_knowledge_block(
        req.creatorReply, neg._router_fields_from_draft(req, ctx), ctx, "draft"
    )
    assert block is not None
    assert "March 15" in block


# ---------------------------------------------------------------------------
# Obligation widening reaches the prompt (invariant #5 end-to-end).
# ---------------------------------------------------------------------------


def test_on_open_obligation_widens_the_block(monkeypatch):
    monkeypatch.setenv("KNOWLEDGE_RETRIEVAL_ENABLED", "true")
    # Message is silent on shipping; an open shipping obligation must still pull it.
    req = _draft_req(creatorReply="Any update?")
    ctx = {
        "briefSections": {"shipping": "We ship within 5 business days."},
        "structuredObligations": [
            {"id": "ob1", "originalText": "when does it ship?", "category": "shipping"}
        ],
    }
    block = neg._selected_knowledge_block(
        req.creatorReply, neg._router_fields_from_draft(req, ctx), ctx, "draft"
    )
    assert block is not None
    assert "5 business days" in block


# ---------------------------------------------------------------------------
# Concern #1 (W1): the four flat knowledge fields reach the negotiate router via
# campaignContext, so /negotiate answers a configured term instead of deferring —
# and resolves the SAME value /draft does (parity).
# ---------------------------------------------------------------------------


def test_negotiate_router_reads_flat_fields_from_campaign_context(monkeypatch):
    monkeypatch.setenv("KNOWLEDGE_RETRIEVAL_ENABLED", "true")
    # A usage-rights question on /negotiate, with the four flat fields on
    # campaignContext (as the executor now threads them, W1).
    req = _neg_req(
        creatorReply="How long can the brand use my content?",
        campaignContext=dict(FLAT_CTX),
    )
    block = neg._negotiate_knowledge_block(req)
    # The configured VALUE is stated — NOT a "we'll confirm" defer.
    assert "30-day reshare on paid + organic." in block
    low = block.lower()
    assert "we'll confirm" not in low and "follow up" not in low


def test_negotiate_draft_resolve_same_usage_value(monkeypatch):
    """§2.4 parity: the same campaign config produces the same resolved usage-rights
    value on /negotiate and /draft."""
    monkeypatch.setenv("KNOWLEDGE_RETRIEVAL_ENABLED", "true")
    ctx = dict(FLAT_CTX)
    q = "How long can the brand use my content?"
    neg_req = _neg_req(creatorReply=q, campaignContext=ctx)
    draft_req = _draft_req(creatorReply=q)
    neg_block = neg._negotiate_knowledge_block(neg_req)
    draft_block = neg._selected_knowledge_block(
        draft_req.creatorReply, neg._router_fields_from_draft(draft_req, ctx), ctx, "draft"
    )
    assert draft_block is not None
    val = FLAT_CTX["usageRights"]
    assert val in neg_block and val in draft_block


# ---------------------------------------------------------------------------
# §4.2 flat-brief safety net on /negotiate: the blob must reach the router
# whenever retrieval is on (not only when BRIEF_INTO_NEGOTIATE is on), so a
# matched-but-unavailable section falls back to the blob instead of a false defer.
# ---------------------------------------------------------------------------


def test_negotiate_retrieval_on_brief_into_negotiate_off_answer_only_in_blob(monkeypatch):
    """PLU-114 §4.2: retrieval ON, structured parse OFF, BRIEF_INTO_NEGOTIATE off
    (simulated by the FIXED server behavior — the blob is threaded because retrieval is
    on). A usage question whose answer lives ONLY in the flat brief blob (usageRights
    omitted from the flat fields, no briefSections) must fall back to the blob, NOT emit
    a false 'we'll confirm and follow up' defer."""
    monkeypatch.setenv("KNOWLEDGE_RETRIEVAL_ENABLED", "true")
    # usageRights DELIBERATELY omitted so the matched usageRights section resolves to
    # requested_but_unavailable; the answer lives only in the flat brief blob (which the
    # fixed server now threads onto campaignContext when retrieval is on).
    ctx = {
        "exclusivity": "No category exclusivity.",
        "paymentTerms": "Net-30 after content goes live.",
        "attributionWindow": "30-day attribution window.",
        "briefKnowledge": "Usage rights: 90-day paid usage across all channels.",
    }
    req = _neg_req(
        creatorReply="How long can the brand use my content?",
        campaignContext=ctx,
    )
    block = neg._negotiate_knowledge_block(req)
    # §4.2 safety net fired → full-context fallback → the flat brief blob is rendered.
    assert "<campaign_brief>" in block
    assert "90-day paid usage across all channels" in block
    # And NO per-section false-defer line. The distinctive marker of the honest-defer
    # instruction (_render_selected_knowledge) is "we do NOT have a configured value";
    # the fallback's positive framing ("do NOT defer... the answer is known") is the
    # opposite and must not be mistaken for it, so match on the defer-specific phrase.
    low = block.lower()
    assert "we do not have a configured value" not in low
    assert "do not invent one" not in low


def test_negotiate_confident_match_still_drops_the_blob(monkeypatch):
    """Invariant (ii): even with the blob now on ctx (retrieval on), a CONFIDENT match
    on an AVAILABLE flat field renders only the selected section — never the 4000-char
    blob. Guards against a blob-leak regression; the negotiate analogue of the /draft
    `test_draft_block_on_drops_the_whole_brief_blob`."""
    monkeypatch.setenv("KNOWLEDGE_RETRIEVAL_ENABLED", "true")
    ctx = dict(FLAT_CTX)
    ctx["briefKnowledge"] = "The brand may use content for 90 days across all channels."
    req = _neg_req(
        creatorReply="How long can the brand use my content?",
        campaignContext=ctx,
    )
    block = neg._negotiate_knowledge_block(req)
    # The confident usage-rights match states the flat field value...
    assert FLAT_CTX["usageRights"] in block
    # ...and the whole brief blob is NOT folded in.
    assert "<campaign_brief>" not in block


# ---------------------------------------------------------------------------
# Concern #2 (W3/W4): strengthened patterns + confidence-driven fallback.
# ---------------------------------------------------------------------------


def test_when_will_funds_hit_selects_payment(monkeypatch):
    monkeypatch.setenv("KNOWLEDGE_RETRIEVAL_ENABLED", "true")
    req = _draft_req(creatorReply="When will the funds hit?")
    ctx = dict(FLAT_CTX)
    block = neg._selected_knowledge_block(
        req.creatorReply, neg._router_fields_from_draft(req, ctx), ctx, "draft"
    )
    assert block is not None
    assert "Net-30 after content goes live." in block


def test_bare_address_is_low_confidence_falls_back(monkeypatch):
    """§3.3/§3.5: a contract-address question ("what's your address for the
    contract?") must NOT produce a narrow shipping-only block — the bare `address`
    match is low confidence → the caller degrades to the full-context fallback."""
    monkeypatch.setenv("KNOWLEDGE_RETRIEVAL_ENABLED", "true")
    req = _draft_req(creatorReply="what's your address for the contract?")
    ctx = {"briefSections": {"shipping": "We ship within 5 business days."}}
    block = neg._selected_knowledge_block(
        req.creatorReply, neg._router_fields_from_draft(req, ctx), ctx, "draft"
    )
    # low confidence → None → caller renders the full flat context, not a
    # shipping-only block.
    assert block is None


def test_ship_my_sample_to_this_address_is_shipping_match(monkeypatch):
    """§3.5: a genuine shipping ask WITH a co-signal is a confident shipping match."""
    monkeypatch.setenv("KNOWLEDGE_RETRIEVAL_ENABLED", "true")
    req = _draft_req(creatorReply="where do I send my address so you can ship the sample?")
    ctx = {"briefSections": {"shipping": "We ship within 5 business days."}}
    block = neg._selected_knowledge_block(
        req.creatorReply, neg._router_fields_from_draft(req, ctx), ctx, "draft"
    )
    assert block is not None
    assert "5 business days" in block


# ---------------------------------------------------------------------------
# Concern #3 (W5): flat-brief fallback — a matched-but-unavailable section while a
# briefKnowledge blob is present must NOT emit a false defer; it falls back to the
# full context (which carries the blob).
# ---------------------------------------------------------------------------


def test_flat_brief_fallback_when_matched_but_unavailable(monkeypatch):
    monkeypatch.setenv("KNOWLEDGE_RETRIEVAL_ENABLED", "true")
    # Retrieval ON, structured parsing OFF (no briefSections), no flat usageRights
    # field — but the answer sits in the flat briefKnowledge blob.
    req = _draft_req(creatorReply="How long can you use my content?")
    ctx = {"briefKnowledge": "USAGE RIGHTS: the brand may reshare for 45 days."}
    block = neg._selected_knowledge_block(
        req.creatorReply, neg._router_fields_from_draft(req, ctx), ctx, "draft"
    )
    # None → caller renders the full context (which includes the blob) rather than a
    # bare "we'll confirm" defer that suppresses the real answer.
    assert block is None


def test_no_false_defer_when_flat_brief_has_answer_negotiate(monkeypatch):
    """§4.2 on the negotiate side: matched-but-unavailable + briefKnowledge present →
    the negotiate block carries the flat brief blob, never a stripped/defer prompt."""
    monkeypatch.setenv("KNOWLEDGE_RETRIEVAL_ENABLED", "true")
    req = _neg_req(
        creatorReply="How long can you use my content?",
        campaignContext={"briefKnowledge": "USAGE RIGHTS: reshare for 45 days."},
    )
    block = neg._negotiate_knowledge_block(req)
    assert "<campaign_brief>" in block  # the blob framing is present
    assert "reshare for 45 days" in block


# ---------------------------------------------------------------------------
# W6: flag-dependency warning (diagnostics only).
# ---------------------------------------------------------------------------


def test_warn_flag_dependency_when_parsing_off(monkeypatch, caplog):
    import logging

    monkeypatch.setenv("KNOWLEDGE_RETRIEVAL_ENABLED", "true")
    monkeypatch.delenv("STRUCTURED_BRIEF_PARSING_ENABLED", raising=False)
    with caplog.at_level(logging.WARNING, logger="agent.negotiate"):
        neg.warn_knowledge_flag_dependency()
    assert any("STRUCTURED_BRIEF_PARSING_ENABLED" in r.message for r in caplog.records)


def test_no_warn_when_both_on(monkeypatch, caplog):
    import logging

    monkeypatch.setenv("KNOWLEDGE_RETRIEVAL_ENABLED", "true")
    monkeypatch.setenv("STRUCTURED_BRIEF_PARSING_ENABLED", "true")
    with caplog.at_level(logging.WARNING, logger="agent.negotiate"):
        neg.warn_knowledge_flag_dependency()
    assert not any("STRUCTURED_BRIEF_PARSING_ENABLED" in r.message for r in caplog.records)


def test_no_warn_when_retrieval_off(monkeypatch, caplog):
    import logging

    monkeypatch.delenv("KNOWLEDGE_RETRIEVAL_ENABLED", raising=False)
    monkeypatch.delenv("STRUCTURED_BRIEF_PARSING_ENABLED", raising=False)
    with caplog.at_level(logging.WARNING, logger="agent.negotiate"):
        neg.warn_knowledge_flag_dependency()
    assert not any("STRUCTURED_BRIEF_PARSING_ENABLED" in r.message for r in caplog.records)
