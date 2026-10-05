"""FastAPI application factory.

Phase 1a exposes only `GET /api/health`; the domain routers, SSE streaming and
SPA serving land in phase 6. CORS stays disabled, as in the Hono backend.
"""

from __future__ import annotations

from fastapi import FastAPI

from .core.models import INTERVIEW_OS_VERSION

__all__ = ["app", "create_app"]

API_PREFIX = "/api"


def create_app() -> FastAPI:
    app = FastAPI(
        title="Interview OS API",
        version=INTERVIEW_OS_VERSION,
        docs_url=None,
        redoc_url=None,
        openapi_url=f"{API_PREFIX}/openapi.json",
    )

    @app.get(f"{API_PREFIX}/health")
    def health() -> dict[str, str]:
        return {"status": "ok", "version": INTERVIEW_OS_VERSION}

    return app


app = create_app()
