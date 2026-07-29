"""PLU-112 — tests for the /summarize post-gen guard + rendering (pure, no LLM).

The money-safety-critical piece is the POST-GENERATION guard (§5.5/§5.8): a summary
that INTRODUCES a dollar figure or percent absent from the input turns is rejected,
so a hallucinated money-relevant fact can never reach the negotiate/draft model via
the summary. The LLM call itself is not exercised here (it needs a live model); the
guard + rendering + no-op refresh are pure and fully testable.
"""

from app.routes.summarize import (
    SummaryTurn,
    _guard_summary,
    _money_tokens,
    _render_turns,
    _build_prompt,
)


def test_money_tokens_extracts_dollars_and_percents():
    toks = _money_tokens("We offered $500 and a 10% commission, also $1,250.50.")
    assert "$500" in toks
    assert "10%" in toks
    assert "$1,250.50" in toks


def test_guard_accepts_a_purely_narrative_summary():
    # No money figures at all → always fine.
    out = "The creator was enthusiastic early, then pushed back on exclusivity before a manager joined."
    assert _guard_summary(out, "some input turns with no numbers") == ""


def test_guard_accepts_a_figure_that_was_in_the_input():
    # The model faithfully carried a number that appears in the transcript → allowed.
    inp = "Creator: I want $600 for this.\nUs: We can do $450."
    out = "The creator opened at $600 and we countered at $450 before they went quiet."
    assert _guard_summary(out, inp) == ""


def test_guard_REJECTS_a_figure_introduced_by_the_model():
    # The summary invents $999 that never appears in the input → rejected (the exact
    # failure mode the narrative-only summary is designed to prevent).
    inp = "Creator: Sounds interesting.\nUs: Great, let's talk terms."
    out = "The creator agreed to $999 after some back and forth."
    reason = _guard_summary(out, inp)
    assert reason
    assert "$999" in reason


def test_guard_REJECTS_an_introduced_percent():
    inp = "Creator: What's the deal?\nUs: A flat fee plus perks."
    out = "They accepted a 25% commission structure."
    reason = _guard_summary(out, inp)
    assert reason
    assert "25%" in reason


def test_render_turns_labels_and_sanitizes():
    turns = [
        SummaryTurn(role="creator", message="  Hi there  "),
        SummaryTurn(role="us", message="Hello!"),
        SummaryTurn(role="creator", message=""),  # empty → skipped
    ]
    rendered = _render_turns(turns)
    assert "Creator: Hi there" in rendered
    assert "Us: Hello!" in rendered
    # the empty turn produced no line
    assert rendered.count("\n") == 1


def test_build_prompt_includes_prior_summary_only_when_present():
    with_prior = _build_prompt("Earlier arc here.", "Creator: hi")
    assert "EXISTING SUMMARY SO FAR" in with_prior
    without_prior = _build_prompt("", "Creator: hi")
    assert "EXISTING SUMMARY SO FAR" not in without_prior
    # both forbid stating dollar amounts (the narrative-only rule)
    assert "Do NOT state specific dollar amounts" in with_prior
    assert "Do NOT state specific dollar amounts" in without_prior
