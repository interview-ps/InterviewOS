"""SPA static serving — port of `http/static.ts` (mounted only when a build exists).

GET/HEAD for a real file serves it; any other non-/api GET falls back to
index.html so client-side routes load. /api/* is untouched.
"""

from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse, Response

__all__ = ["mount_static_web"]


def mount_static_web(app: FastAPI, web_dir: Path) -> None:
    root = web_dir.resolve()

    @app.get("/{full_path:path}")
    async def spa(full_path: str) -> Response:  # noqa: ANN202
        if full_path == "api" or full_path.startswith("api/"):
            return Response(status_code=404)
        candidate = (root / full_path).resolve()
        if root in candidate.parents and candidate.is_file():
            return FileResponse(candidate)
        index = root / "index.html"
        if index.is_file():
            return FileResponse(index)
        return Response(status_code=404)
