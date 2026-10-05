"""Documents family: multipart text extraction + upload body limit."""

from __future__ import annotations

from conftest import ContractClient
from harness.snapshot import Snapshot


def test_extract_text_file(client: ContractClient, snapshot: Snapshot) -> None:
    resp = client.post(
        "/api/documents/extract",
        files={"file": ("notes.txt", b"Some plain text notes.\nSecond line.")},
    )
    snap = snapshot.check_response("txt", resp)
    assert snap["status"] == 200
    assert snap["body"]["format"] == "txt"
    assert snap["body"]["text"].startswith("Some plain text")


def test_extract_markdown(client: ContractClient, snapshot: Snapshot) -> None:
    resp = client.post(
        "/api/documents/extract",
        files={"file": ("doc.md", b"# Heading\n\nBody text.")},
    )
    snap = snapshot.check_response("md", resp)
    assert snap["status"] == 200
    assert snap["body"]["format"] == "md"


def test_extract_missing_file(client: ContractClient, snapshot: Snapshot) -> None:
    resp = client.post(
        "/api/documents/extract",
        files={"other": ("x.txt", b"data")},
    )
    snap = snapshot.check_response("missing", resp)
    assert snap["status"] == 400
    assert snap["body"]["error"]["code"] == "VALIDATION"


def test_extract_binary_unsupported(client: ContractClient, snapshot: Snapshot) -> None:
    resp = client.post(
        "/api/documents/extract",
        files={"file": ("blob.bin", b"\x00\x01\x02\x03 binary")},
    )
    snap = snapshot.check_response("binary", resp)
    assert snap["status"] == 415
    assert snap["body"]["error"]["code"] == "UNSUPPORTED_FORMAT"


def test_upload_body_limit(client: ContractClient, snapshot: Snapshot) -> None:
    # docBodyLimit: 5 MB. Chunked encoding (no Content-Length) so the server
    # counts the stream rather than rejecting on the header — with a declared
    # length the Hono backend answers 413 and closes the socket while the
    # client is still writing, which surfaces as WinError 10053 on Windows.
    boundary = "----contractboundary"
    big = b"x" * (5 * 1024 * 1024 + 1024)
    body = (
        f"--{boundary}\r\n"
        'Content-Disposition: form-data; name="file"; filename="big.txt"\r\n'
        "Content-Type: text/plain\r\n\r\n"
    ).encode() + big + f"\r\n--{boundary}--\r\n".encode()
    resp = client.post(
        "/api/documents/extract",
        content=iter([body]),
        headers={"content-type": f"multipart/form-data; boundary={boundary}"},
    )
    snap = snapshot.check_response("too-large", resp)
    assert snap["status"] == 413
    assert snap["body"]["error"]["code"] == "TOO_LARGE"
