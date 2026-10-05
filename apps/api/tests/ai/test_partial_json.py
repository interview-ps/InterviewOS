"""`extract_partial_string_field`: partial-JSON streaming deltas (§8.3)."""

from __future__ import annotations

from interview_os.ai import extract_partial_string_field


def test_returns_none_before_the_field_starts() -> None:
    assert extract_partial_string_field("", "summary") is None
    assert extract_partial_string_field("{", "summary") is None
    assert extract_partial_string_field('{"other": 1', "summary") is None


def test_reads_a_top_level_string_field() -> None:
    assert extract_partial_string_field('{"summary": "hello', "summary") == "hello"
    assert extract_partial_string_field('{"summary":"hello"}', "summary") == "hello"


def test_tolerates_whitespace_around_the_colon() -> None:
    assert extract_partial_string_field('{ "summary" :  "hi', "summary") == "hi"


def test_ignores_a_field_nested_inside_another_object() -> None:
    # the key sits at depth 2 once the inner object has been opened
    assert extract_partial_string_field('{"a": {"summary": "nested', "summary") is None
    assert extract_partial_string_field('{"a": {"b": {"summary": "deep', "summary") is None


def test_ignores_the_key_when_it_appears_inside_a_string_value() -> None:
    assert extract_partial_string_field('{"other": "\\"summary\\": \\"x', "summary") is None


def test_decodes_escapes() -> None:
    assert (
        extract_partial_string_field(r'{"summary": "a\nb\tc\"d\\e/f', "summary") == 'a\nb\tc"d\\e/f'
    )


def test_decodes_a_unicode_escape() -> None:
    assert extract_partial_string_field(r'{"summary": "\u0041\u00e9', "summary") == "A\u00e9"


def test_drops_a_dangling_backslash_at_the_buffer_end() -> None:
    assert extract_partial_string_field('{"summary": "done\\', "summary") == "done"


def test_drops_a_partial_unicode_escape_at_the_buffer_end() -> None:
    assert extract_partial_string_field(r'{"summary": "done\u00', "summary") == "done"
    assert extract_partial_string_field(r'{"summary": "done\u', "summary") == "done"


def test_stops_at_the_closing_quote() -> None:
    assert extract_partial_string_field('{"summary": "one", "other": 2}', "summary") == "one"


def test_grows_monotonically_across_deltas() -> None:
    chunks = ['{"summary": "Hel', "lo wor", 'ld!"}']
    buf = ""
    seen: list[str] = []
    for chunk in chunks:
        buf += chunk
        partial = extract_partial_string_field(buf, "summary")
        if partial is not None:
            seen.append(partial)
    assert seen == ["Hel", "Hello wor", "Hello world!"]
