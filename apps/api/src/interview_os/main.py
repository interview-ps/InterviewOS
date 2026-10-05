"""FastAPI application factory + lifespan — port of `apps/server/src/index.ts`.

Builds the store, the switchable runtime, the MCP manager and the
`InterviewOrchestrator` at startup, mounts the domain routers, and disposes
resources on shutdown.
"""

from __future__ import annotations

import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI

from .ai import MockRuntime, RuntimeManagerOptions, create_runtime
from .ai.logger import NullLogger
from .ai.manager import RuntimeManager
from .api.deps import AppState
from .api.errors import install_error_handlers
from .api.limits import BodyLimitMiddleware
from .core.models import INTERVIEW_OS_VERSION
from .mcp.manager import McpManager, McpServerState
from .orchestrator import InterviewOrchestrator, OrchestratorDeps
from .orchestrator.services import PluginDirs
from .packs import PackDirs
from .paths import (
    DEFAULT_DB_PATH,
    DEFAULT_EXAMPLES_DIR,
    DEFAULT_INSTALLED_PACKS_DIR,
    DEFAULT_INSTALLED_PLUGINS_DIR,
    DEFAULT_MCP_CONFIG_PATH,
    DEFAULT_PACKS_DIR,
    DEFAULT_PLUGINS_DIR,
    DEFAULT_UI_RUNTIME_DIR,
    DEFAULT_WEB_DIST,
)
from .skills import install_mode_mock_fallback, register_mock_handlers

__all__ = ["app", "create_app"]

API_PREFIX = "/api"


def _mcp_state_for(store: Any) -> Any:
    async def state_for(server_id: str) -> McpServerState:
        row = store.get_mcp_server(server_id)
        return McpServerState(
            enabled=bool(row is not None and row.enabled == 1),
            allowed_tools=tuple(row.allowed_tools if row is not None else ()),
        )

    return state_for


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    from .store import open_store

    logger = NullLogger()
    store = open_store(DEFAULT_DB_PATH)

    resolver: dict[str, Any] = {"fn": lambda task_id, value: None}

    def on_switch(rt: object) -> None:
        if isinstance(rt, MockRuntime):
            register_mock_handlers(rt)
            install_mode_mock_fallback(rt, lambda task_id, value: resolver["fn"](task_id, value))

    runtimes: RuntimeManager = await create_runtime(
        RuntimeManagerOptions(
            env=os.environ,
            logger=logger,
            preferred_kind=store.get_setting("runtimeKind"),
            on_switch=on_switch,
        )
    )
    mcp = McpManager(DEFAULT_MCP_CONFIG_PATH, logger, _mcp_state_for(store))
    orchestrator = InterviewOrchestrator(
        OrchestratorDeps(
            store=store,
            runtime=runtimes,
            logger=logger,
            plugin_dirs=PluginDirs(
                bundled=str(DEFAULT_PLUGINS_DIR), installed=str(DEFAULT_INSTALLED_PLUGINS_DIR)
            ),
            pack_dirs=PackDirs(
                bundled=DEFAULT_PACKS_DIR, installed=DEFAULT_INSTALLED_PACKS_DIR
            ),
            mcp=mcp,
        )
    )
    resolver["fn"] = orchestrator.plugin_mode_mock_fallback

    # §9.6: discover bundled + installed plugins before serving (plugin loader
    # lands with phase 7; guarded so the backend boots without it).
    plugin_errors: list[Any] = []
    try:
        from importlib import import_module

        load_plugins = import_module("interview_os.startup.plugins").load_plugins
    except (ImportError, AttributeError):
        load_plugins = None
    if load_plugins is not None:
        plugin_errors = await load_plugins(DEFAULT_PLUGINS_DIR, orchestrator, logger, "bundled")
        plugin_errors += await load_plugins(
            DEFAULT_INSTALLED_PLUGINS_DIR, orchestrator, logger, "git"
        )
        orchestrator.set_plugin_load_errors(plugin_errors)
        await orchestrator.sync_plugin_packs()

    web_dir = DEFAULT_WEB_DIST if (DEFAULT_WEB_DIST / "index.html").is_file() else None
    app.state.app_state = AppState(
        orchestrator=orchestrator,
        runtime=runtimes,
        runtimes=runtimes,
        store=store,
        logger=logger,
        examples_dir=DEFAULT_EXAMPLES_DIR,
        ui_runtime_dir=DEFAULT_UI_RUNTIME_DIR,
        web_dir=web_dir,
        plugin_errors=plugin_errors,
    )
    try:
        yield
    finally:
        try:
            await orchestrator.flush_plugin_events()
        except Exception:  # noqa: BLE001 - best effort shutdown
            pass
        try:
            await mcp.close_all()
        except Exception:  # noqa: BLE001
            pass
        try:
            await runtimes.dispose()
        except Exception:  # noqa: BLE001
            pass
        store.close()


def create_app() -> FastAPI:
    app = FastAPI(
        title="Interview OS API",
        version=INTERVIEW_OS_VERSION,
        docs_url=None,
        redoc_url=None,
        openapi_url=f"{API_PREFIX}/openapi.json",
        lifespan=lifespan,
    )
    app.add_middleware(BodyLimitMiddleware)
    install_error_handlers(app)

    _mount_routers(app)

    @app.get(f"{API_PREFIX}/health")
    def health() -> dict[str, str]:
        return {"status": "ok", "version": INTERVIEW_OS_VERSION}

    return app


def _mount_routers(app: FastAPI) -> None:
    """Mount every `api/routes/<domain>.py` module that defines `router`.

    Auto-discovery keeps one file per domain (as in Hono) and lets domains land
    independently without editing this module.
    """

    import importlib
    import pkgutil

    from .api import routes as routes_pkg

    for module_info in sorted(pkgutil.iter_modules(routes_pkg.__path__), key=lambda m: m.name):
        module = importlib.import_module(f"{routes_pkg.__name__}.{module_info.name}")
        router = getattr(module, "router", None)
        if router is not None:
            app.include_router(router)


app = create_app()
