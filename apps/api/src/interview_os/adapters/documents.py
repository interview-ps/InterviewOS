"""Document text extraction — port of `apps/server/src/adapters/documents.ts`.

pdf/docx are detected by magic bytes, never by filename; the filename is only a
hint for the txt/md label. The TypeScript adapter leans on `unpdf`/`mammoth`;
those packages are not part of the Python dependency set, so this port reads the
docx container with the stdlib `zipfile`/XML parser and falls back to a
best-effort text scan of PDF content streams for PDFs. The warnings/format
contract (magic-byte detection, normalization, 50k truncation) is identical.
"""

from __future__ import annotations

import re
import xml.etree.ElementTree as ElementTree
import zipfile
import zlib
from io import BytesIO
from typing import Literal

from ..core.models import AppError, CamelModel

__all__ = ["DocumentFormat", "ExtractResult", "MAX_CHARS", "extract_document"]

DocumentFormat = Literal["pdf", "docx", "txt", "md"]

MAX_CHARS = 50_000

_WORD_NS = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"

_PDF_STREAM_RE = re.compile(rb"stream\r?\n(.*?)\r?\nendstream", re.DOTALL)
_PDF_STRING_RE = re.compile(rb"\(((?:\\.|[^\\()])*)\)")
_PDF_PAGE_RE = re.compile(rb"/Type\s*/Page(?![A-Za-z])")


class ExtractResult(CamelModel):
    text: str
    format: DocumentFormat
    pages: int | None = None
    warnings: list[str]


def _is_pdf(data: bytes) -> bool:
    return data[:5] == b"%PDF-"


def _is_docx(data: bytes) -> bool:
    # zip magic + a word/document.xml entry (the name is stored uncompressed)
    return len(data) > 4 and data[:4] == b"PK\x03\x04" and b"word/document.xml" in data


def _normalize(text: str) -> str:
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def _extract_docx(data: bytes) -> str:
    try:
        with zipfile.ZipFile(BytesIO(data)) as archive:
            document = archive.read("word/document.xml")
    except (zipfile.BadZipFile, KeyError, OSError) as err:
        raise AppError("EXTRACTION_FAILED", "Could not read this document") from err
    try:
        root = ElementTree.fromstring(document)
    except ElementTree.ParseError as err:
        raise AppError("EXTRACTION_FAILED", "Could not read this document") from err

    paragraphs: list[str] = []
    for paragraph in root.iter(f"{_WORD_NS}p"):
        pieces: list[str] = []
        for node in paragraph.iter():
            if node.tag == f"{_WORD_NS}t" and node.text:
                pieces.append(node.text)
            elif node.tag == f"{_WORD_NS}tab":
                pieces.append("\t")
            elif node.tag in (f"{_WORD_NS}br", f"{_WORD_NS}cr"):
                pieces.append("\n")
        paragraphs.append("".join(pieces))
    return "\n\n".join(paragraphs)


def _pdf_unescape(value: bytes) -> str:
    return (
        value.decode("latin-1")
        .replace("\\(", "(")
        .replace("\\)", ")")
        .replace("\\\\", "\\")
        .replace("\\n", "\n")
        .replace("\\r", "\r")
        .replace("\\t", "\t")
    )


def _extract_pdf(data: bytes) -> tuple[str, int]:
    pages = len(_PDF_PAGE_RE.findall(data))
    pieces: list[str] = []
    for stream in _PDF_STREAM_RE.finditer(data):
        payload = stream.group(1)
        try:
            payload = zlib.decompress(payload)
        except zlib.error:
            pass
        pieces.extend(_pdf_unescape(literal) for literal in _PDF_STRING_RE.findall(payload))
    return " ".join(pieces), pages


def extract_document(data: bytes, filename_hint: str = "") -> ExtractResult:
    """Extract text from an uploaded document (magic-byte detection)."""

    warnings: list[str] = []
    text = ""
    format: DocumentFormat
    pages: int | None = None

    if _is_pdf(data):
        format = "pdf"
        text, pages = _extract_pdf(data)
    elif _is_docx(data):
        format = "docx"
        text = _extract_docx(data)
    else:
        # treat as plain text unless it looks binary
        decoded = data.decode("utf-8", errors="replace")
        if "\x00" in decoded:
            raise AppError("UNSUPPORTED_FORMAT", "unsupported file format (not pdf/docx/text)")
        format = "md" if filename_hint.lower().endswith(".md") else "txt"
        text = decoded

    text = _normalize(text)
    if len(text) == 0:
        warnings.append("No extractable text (scanned PDF?)")
    if len(text) > MAX_CHARS:
        text = text[:MAX_CHARS]
        warnings.append(f"Truncated to {MAX_CHARS} characters")
    return ExtractResult(text=text, format=format, pages=pages, warnings=warnings)
