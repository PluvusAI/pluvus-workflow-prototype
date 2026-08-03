"""PLU-112 — /summarize guard + idempotency tests.

The money-figure guard and the empty-delta no-op are deterministic (no LLM), so
they are unit-testable without a model. The narrative generation itself is exercised
by the live harness, not here.
"""

from app.routes.summarize import (
    SummarizeHistoryEntry,
    SummarizeRequest,
    _guard_summary,
    _render_delta,
    summarize,
)


def test_guard_strips_invented_dollar_figure():
    # $750 is NOT in the source → the guard removes it.
    out = _guard_summary("We offered $750 and they hesitated.", "they hesitated on the fee")
    assert "$750" not in out


def test_guard_strips_invented_percentage():
    out = _guard_summary("They wanted 15% commission.", "they asked about commission")
    assert "15%" not in out


def test_guard_keeps_a_figure_present_in_the_source():
    # $500 appears in the source, so it is a faithful restatement, not an invention.
    out = _guard_summary("We held at $500.", "we said $500 is our rate")
    assert "$500" in out


def test_guard_leaves_narrative_without_figures_untouched():
    text = "The creator was enthusiastic and asked for more detail on timing."
    assert _guard_summary(text, "some source") == text


def test_render_delta_sanitizes_creator_and_labels_sides():
    rendered = _render_delta([
        SummarizeHistoryEntry(role="creator", message="hi there"),
        SummarizeHistoryEntry(role="us", message="thanks for the reply"),
    ])
    assert "[creator]" in rendered
    assert "[us]" in rendered


def test_empty_delta_is_a_noop_and_echoes_prior_summary():
    # No new turns → the route returns the prior text WITHOUT calling the model.
    resp = summarize(SummarizeRequest(priorSummary="prior arc", delta=[]))
    assert resp.text == "prior arc"


def test_all_blank_delta_messages_are_a_noop():
    resp = summarize(SummarizeRequest(
        priorSummary="keep me",
        delta=[SummarizeHistoryEntry(role="creator", message="  ")],
    ))
    assert resp.text == "keep me"
