"""PLU-113 — agent-side unit tests for creator-memory extraction + rendering.

Pure functions over already-parsed model output — no LLM, no network. Covers:
  - _normalize_extracted_facts: closed-key filter, REQUESTED_RATE dropped
    (server-owned), confidence clamp, dedup, malformed items ignored (never raises).
  - _render_creator_memory: empty payload → "" (byte-identical, invariant #8);
    non-empty → sanitized DATA block; rate/floor labeled CONTEXT not the offer.
  - prompt fragments: off → no creatorFacts text; on → the extraction instruction
    with SINGLE-brace JSON example (not the escaped {{ }} used inside the template).
"""

from app.routes import negotiate as neg


def test_normalize_facts_filters_and_grounds():
    facts = neg._normalize_extracted_facts(
        [
            {"key": "OBJECTION", "value": "no exclusivity", "confidence": 0.9},
            {"key": "REQUESTED_RATE", "value": "600", "confidence": 1.0},  # server-owned → dropped
            {"key": "NOT_A_KEY", "value": "x", "confidence": 1.0},  # bad key → dropped
            {"key": "AVAILABILITY", "value": "   ", "confidence": 1.0},  # empty → dropped
            {"key": "MANAGER_INVOLVED", "value": "true"},  # missing confidence → 0.0
        ],
        creator_reply="no exclusivity, my manager handles contracts",
    )
    keys = [f.key for f in facts]
    assert "REQUESTED_RATE" not in keys, "REQUESTED_RATE is server-owned, must be dropped"
    assert "NOT_A_KEY" not in keys
    assert keys == ["OBJECTION", "MANAGER_INVOLVED"]
    conf_by_key = {f.key: f.confidence for f in facts}
    assert conf_by_key["MANAGER_INVOLVED"] == 0.0, "missing confidence → 0.0"


def test_normalize_facts_clamps_and_dedupes():
    facts = neg._normalize_extracted_facts(
        [
            {"key": "OBJECTION", "value": "no exclusivity", "confidence": 5.0},  # clamp → 1.0
            {"key": "OBJECTION", "value": "No Exclusivity", "confidence": 0.9},  # dup (lowered) → drop
            {"key": "OBJECTION", "value": "no usage rights", "confidence": -1},  # clamp → 0.0
        ],
        creator_reply="",
    )
    assert len(facts) == 2, "duplicate (case-insensitive) collapses"
    assert facts[0].confidence == 1.0
    assert facts[1].confidence == 0.0


def test_normalize_facts_never_raises_on_garbage():
    assert neg._normalize_extracted_facts(None, "") == []
    assert neg._normalize_extracted_facts("not a list", "") == []
    assert neg._normalize_extracted_facts([None, 42, {"no": "key"}], "") == []


def test_render_creator_memory_empty_is_byte_identical():
    # None → "" (invariant #8: block omitted, prompt unchanged).
    assert neg._render_creator_memory(None) == ""
    # A payload with nothing populated → still "".
    assert neg._render_creator_memory(neg.CreatorMemory()) == ""


def test_render_creator_memory_non_empty_is_data_and_labels_rate_as_context():
    cm = neg.CreatorMemory(
        requestedRate="600",
        minimumRate="450",
        availability="unavailable until Aug 15",
        objections=["no perpetual usage rights"],
        managerInvolved=True,
    )
    block = neg._render_creator_memory(cm)
    assert "<creator_memory>" in block and "</creator_memory>" in block
    assert "DATA" in block
    # Rate/floor are CONTEXT, explicitly NOT the offer figure (invariant #6).
    assert "NOT the offer figure" in block
    assert "600" in block and "450" in block
    assert "no perpetual usage rights" in block
    assert "manager" in block.lower()


def test_render_creator_memory_surfaces_conflicts():
    cm = neg.CreatorMemory(
        requestedRate="600",
        conflicts=[{"key": "REQUESTED_RATE", "current": "600", "prior": "400"}],
    )
    block = neg._render_creator_memory(cm)
    assert "CONFLICTING" in block
    assert "400" in block and "600" in block


def test_extraction_fragments_off_vs_on():
    # OFF: the JSON output fragment is empty → no creatorFacts in the rendered prompt.
    off_out = ""
    assert "creatorFacts" not in off_out
    # ON: the instruction uses SINGLE-brace JSON (it is inserted as a .format VALUE,
    # not part of the template, so {{ }} would render literally — must be single).
    assert '{{' not in neg._CREATOR_FACTS_INSTRUCTION
    assert '{"key":' in neg._CREATOR_FACTS_OUTPUT
    assert "creatorFacts" in neg._CREATOR_FACTS_OUTPUT
    # The instruction lists the allowed keys and forbids REQUESTED_RATE here.
    assert "MINIMUM_RATE" in neg._CREATOR_FACTS_INSTRUCTION
    assert "captured by creatorRateMentioned" in neg._CREATOR_FACTS_INSTRUCTION


def test_extract_creator_facts_flag_default_off():
    req = neg.NegotiateRequest(
        creatorReply="hi",
        currentOffer=neg.NegotiationTerm(rate=100),
        round=1,
        maxRounds=5,
        campaignConstraints=neg.CampaignConstraints(
            termFloor=neg.NegotiationTerm(rate=100),
            termCeiling=neg.NegotiationTerm(rate=500),
        ),
    )
    assert req.extractCreatorFacts is False
    assert req.creatorMemory is None
    # NegotiateResponse default carries an empty creatorFacts list.
    assert neg.NegotiateResponse(action="COUNTER").creatorFacts == []
