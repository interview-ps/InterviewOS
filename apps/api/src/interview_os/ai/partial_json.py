"""Streaming partial-JSON parser (port of `partialJson.ts`).

Extracts a string field from a *partially received* JSON buffer (§8.3 field
streaming). Matches `"field"` keys at depth 0 or 1 followed by a string literal
that may be unterminated; escapes (`\\n` `\\"` `\\\\` `\\uXXXX` …) are decoded, and a
dangling backslash or partial `\\u` escape at the buffer end is dropped.
"""

from __future__ import annotations

import re

__all__ = ["extract_partial_string_field"]

_WHITESPACE = re.compile(r"\s")
_HEX4 = re.compile(r"^[0-9a-fA-F]{4}$")

_SIMPLE_ESCAPES = {
    "n": "\n",
    "t": "\t",
    "r": "\r",
    "b": "\b",
    "f": "\f",
    '"': '"',
    "\\": "\\",
    "/": "/",
}


def extract_partial_string_field(buf: str, field: str) -> str | None:
    """Return the field's partial text, or `None` when it has not started yet."""

    key = f'"{field}"'
    depth = 0
    in_str = False
    escaped = False
    for index, char in enumerate(buf):
        if in_str:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_str = False
            continue
        if char == '"':
            if depth <= 1 and buf.startswith(key, index):
                cursor = index + len(key)
                cursor = _skip_space(buf, cursor)
                if cursor < len(buf) and buf[cursor] == ":":
                    cursor = _skip_space(buf, cursor + 1)
                    if cursor < len(buf) and buf[cursor] == '"':
                        return _decode_partial_string(buf, cursor + 1)
            in_str = True
            continue
        if char in "{[":
            depth += 1
        elif char in "}]":
            depth -= 1
    return None


def _skip_space(buf: str, cursor: int) -> int:
    while cursor < len(buf) and _WHITESPACE.match(buf[cursor]) is not None:
        cursor += 1
    return cursor


def _decode_partial_string(buf: str, start: int) -> str:
    out: list[str] = []
    index = start
    while index < len(buf):
        char = buf[index]
        if char == '"':
            return "".join(out)
        if char == "\\":
            if index + 1 >= len(buf):
                return "".join(out)  # dangling backslash
            following = buf[index + 1]
            if following == "u":
                hex_digits = buf[index + 2 : index + 6]
                if len(hex_digits) == 4 and _HEX4.match(hex_digits):
                    out.append(chr(int(hex_digits, 16)))
                    index += 6
                    continue
                return "".join(out)  # partial \uXXXX at the buffer end — drop it
            out.append(_SIMPLE_ESCAPES.get(following, following))
            index += 2
            continue
        out.append(char)
        index += 1
    return "".join(out)
