"""Plugins routes — port of `http/routes/plugins.ts`.

The plugin surface: list/install/enable/disable/uninstall, run, the v0.4
declarative render + frame/data/run + static-asset endpoints, and the v1
settings get/put. Frame documents are assembled here (the TS `frame-document.ts`
helper has no other consumer in the Python port).
"""

from __future__ import annotations

import base64
import json
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import unquote

from fastapi import APIRouter, Request, Response
from pydantic import Field, model_validator
from pydantic_core import PydanticCustomError

from ...core.models import AppError, CamelModel, Permission
from ...orchestrator.services import (
    PluginUIRenderRequest,
    UIFrameRunSelector,
    UIFrameSelector,
)
from ..deps import StateDep
from ..respond import json_response

__all__ = ["router"]

router = APIRouter(prefix="/api/plugins")


# ------------------------------------------------------------------- schemas


class PluginInstallSchema(CamelModel):
    url: str = Field(min_length=1, max_length=2000)


class PluginUpdateSchema(CamelModel):
    enabled: bool
    granted_permissions: list[Permission] | None = None


class PluginRunSchema(CamelModel):
    request: Any = None


class PluginUIRenderSchema(CamelModel):
    slot: str | None = Field(default=None, min_length=1, max_length=60)
    component: str = Field(min_length=1, max_length=80)
    page: str | None = Field(default=None, min_length=1, max_length=120)
    params: Any = None


class PluginUIFrameSelectorSchema(CamelModel):
    """Frame data request — which declared frame the slices are for."""

    component: str | None = Field(default=None, min_length=1, max_length=80)
    page: str | None = Field(default=None, min_length=1, max_length=120)

    @model_validator(mode="after")
    def _require_selector(self) -> PluginUIFrameSelectorSchema:
        if self.component is None and self.page is None:
            raise PydanticCustomError("value_error", "component or page is required")
        return self


class PluginUIFrameRunSchema(PluginUIFrameSelectorSchema):
    """Frame run request — stateless invocation, bounded payload."""

    request: dict[str, Any] | None = None


class PluginSettingsPutSchema(CamelModel):
    values: dict[str, Any]


# -------------------------------------------------------------------- routes


@router.get("")
async def list_plugins(state: StateDep) -> object:
    return json_response({"plugins": await state.orchestrator.list_plugins()})


@router.post("/install")
async def install_plugin(body: PluginInstallSchema, state: StateDep) -> object:
    plugin = await state.orchestrator.install_plugin_from_git(body.url)
    return json_response({"plugin": plugin}, status_code=201)


@router.put("/{id}")
async def update_plugin(id: str, body: PluginUpdateSchema, state: StateDep) -> object:
    plugin = await state.orchestrator.set_plugin_enabled(
        id, body.enabled, body.granted_permissions
    )
    return json_response({"plugin": plugin})


@router.delete("/{id}")
async def uninstall_plugin(id: str, state: StateDep) -> object:
    await state.orchestrator.uninstall_plugin(id)
    return json_response({"ok": True})


@router.post("/{id}/run")
async def run_plugin(id: str, state: StateDep, body: PluginRunSchema | None = None) -> object:
    request = body.request if body is not None else None
    return json_response(await state.orchestrator.run_plugin(id, request))


# ---------------------------------------------------- v0.4 declarative render


@router.post("/{id}/ui/render")
async def render_plugin_ui(id: str, body: PluginUIRenderSchema, state: StateDep) -> object:
    ui = await state.orchestrator.render_plugin_ui(
        id,
        PluginUIRenderRequest(
            slot=body.slot,
            component=body.component,
            page=body.page,
            params=body.params,
        ),
    )
    return json_response({"ui": ui})


# ----------------------------------------------------------- v0.4 frames ---


@router.get("/{id}/ui/frame")
async def plugin_ui_frame(id: str, request: Request, state: StateDep) -> object:
    """Sandboxed iframe document for a declared `kind: "frame"` contribution."""

    component = request.query_params.get("component")
    page = request.query_params.get("page")
    if component is None and page is None:
        raise AppError("VALIDATION", "component or page query is required")
    frame = await state.orchestrator.resolve_ui_frame(
        id, UIFrameSelector(component=component, page=page)
    )
    origin = f"{request.url.scheme}://{request.url.netloc}"
    doc = build_frame_document(
        origin=origin,
        plugin_id=id,
        entry=frame.entry,
        component=frame.component,
        page=frame.page,
    )
    return Response(content=doc.html, media_type="text/html", headers=doc.headers)


@router.get("/{id}/ui/assets/{path:path}")
async def plugin_ui_asset(id: str, path: str, state: StateDep) -> object:
    """Static UI assets — files under `<pluginDir>/ui/` only, `.js/.css/.map`
    only, realpath-confined (symlink-safe), ≤ 2 MB."""

    # enforces enabled + compatible before we ever touch the filesystem.
    asset_root = await state.orchestrator.resolve_ui_asset_dir(id)
    rel = unquote(path)
    if (
        not rel
        or ".." in rel
        or "\\" in rel
        or rel.startswith("/")
        or Path(rel).is_absolute()
        or _CONTROL_CHARS.search(rel)
    ):
        raise AppError("VALIDATION", "invalid asset path")
    ui_dir = _real_path(asset_root, f'plugin "{id}" has no ui/ directory')
    target = _real_path(str(Path(ui_dir) / rel), f'no ui asset "{rel}"')
    if target != ui_dir and not target.startswith(ui_dir + os.sep):
        raise AppError("VALIDATION", "asset escapes the plugin ui/ directory")
    media_type = _ASSET_TYPES.get(Path(target).suffix.lower())
    if media_type is None:
        raise AppError("VALIDATION", "unsupported asset type")
    data = Path(target).read_bytes()
    if len(data) > _UI_ASSET_MAX_BYTES:
        raise AppError("VALIDATION", "ui asset exceeds 2 MB")
    return Response(
        content=data,
        media_type=media_type,
        headers={
            "x-content-type-options": "nosniff",
            "cache-control": "no-store",
            # see /api/ui/runtime — opaque-origin module fetch needs CORS + CORP.
            "cross-origin-resource-policy": "cross-origin",
            "access-control-allow-origin": "*",
        },
    )


@router.post("/{id}/ui/data")
async def plugin_ui_data(id: str, body: PluginUIFrameSelectorSchema, state: StateDep) -> object:
    slices = await state.orchestrator.plugin_ui_data(
        id, UIFrameSelector(component=body.component, page=body.page)
    )
    return json_response({"slices": _omit_undefined(slices)})


@router.post("/{id}/ui/run")
async def plugin_ui_run(id: str, body: PluginUIFrameRunSchema, state: StateDep) -> object:
    result = await state.orchestrator.plugin_ui_run(
        id,
        UIFrameRunSelector(component=body.component, page=body.page, request=body.request),
    )
    return json_response(result)


# --------------------------------------------------------------- v1 settings


@router.get("/{id}/settings")
async def get_plugin_settings(id: str, state: StateDep) -> object:
    return json_response(
        {
            "fields": state.orchestrator.plugin_settings_spec(id),
            "values": await state.orchestrator.get_plugin_settings(id),
        }
    )


@router.put("/{id}/settings")
async def put_plugin_settings(
    id: str, body: PluginSettingsPutSchema, state: StateDep
) -> object:
    values = await state.orchestrator.set_plugin_settings(id, body.values)
    return json_response({"values": values})


# ----------------------------------------------------------- frame document

_ASSET_TYPES: dict[str, str] = {
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".map": "application/json; charset=utf-8",
}
_UI_ASSET_MAX_BYTES = 2 * 1024 * 1024
_CONTROL_CHARS = re.compile(r"[\x00-\x1f]")
_FRAME_ENTRY_PREFIX = re.compile(r"^ui/")


@dataclass(slots=True)
class _FrameDoc:
    html: str
    headers: dict[str, str]


def _real_path(path: str, message: str) -> str:
    """`fs.realpath` semantics: follow symlinks and fail when the path is gone."""

    try:
        return str(Path(path).resolve(strict=True))
    except OSError:
        raise AppError("NOT_FOUND", message) from None


def _omit_undefined(value: Any) -> Any:
    """Mirror Hono's JSON body: `JSON.stringify` drops `undefined` properties.

    The frame-data slices model an unset slice as `None` (the Python stand-in
    for `undefined`), so such keys are omitted here to match the wire body.
    """

    if isinstance(value, dict):
        return {key: _omit_undefined(item) for key, item in value.items() if item is not None}
    if isinstance(value, list | tuple):
        return [_omit_undefined(item) for item in value]
    return value


def build_frame_document(
    *,
    origin: str,
    plugin_id: str,
    entry: str,
    component: str,
    page: str | None,
) -> _FrameDoc:
    """The sandboxed iframe document for a plugin `kind: "frame"` contribution.

    The only code it can load is the host runtime bundle and the plugin's own
    assets — import-mapped through a per-response nonce, with `connect-src
    'none'` so no fetch/XHR/WebSocket can ever leave the iframe.
    """

    nonce = base64.b64encode(os.urandom(16)).decode("ascii")
    runtime_js = f"{origin}/api/ui/runtime/plugin-runtime.js"
    runtime_css = f"{origin}/api/ui/runtime/plugin-runtime.css"
    assets_base = f"{origin}/api/plugins/{plugin_id}/ui/assets/"
    entry_url = f"{assets_base}{_FRAME_ENTRY_PREFIX.sub('', entry)}"

    csp = "; ".join(
        [
            "default-src 'none'",
            f"script-src {assets_base} {runtime_js} 'nonce-{nonce}'",
            f"style-src {runtime_css} 'nonce-{nonce}'",
            "img-src data:",
            f"font-src {origin}/api/ui/runtime/",
            "connect-src 'none'",
            "form-action 'none'",
            "base-uri 'none'",
            "frame-ancestors 'self'",
        ]
    )

    # only validated ids/paths reach this string; json.dumps keeps the
    # interpolation inside JS string literals regardless.
    import_map = {
        "imports": {
            "@interview-os/ui": runtime_js,
            "react": runtime_js,
            "react/jsx-runtime": runtime_js,
            "react-dom/client": runtime_js,
        }
    }
    boot_arg: dict[str, str] = {"entry": entry_url, "component": component}
    if page is not None:
        boot_arg["page"] = page
    import_map_json = json.dumps(import_map, separators=(",", ":"))
    boot_arg_json = json.dumps(boot_arg, separators=(",", ":"))

    html = (
        "<!doctype html>\n"
        '<html lang="en">\n'
        "<head>\n"
        '<meta charset="utf-8">\n'
        '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
        f'<link rel="stylesheet" href="{runtime_css}" nonce="{nonce}">\n'
        f'<script type="importmap" nonce="{nonce}">{import_map_json}</script>\n'
        "</head>\n"
        "<body>\n"
        '<div id="root"></div>\n'
        f'<script type="module" nonce="{nonce}">\n'
        'import { boot } from "@interview-os/ui";\n'
        f"boot({boot_arg_json}).catch((err) => {{\n"
        '  document.getElementById("root").textContent =\n'
        '    "Plugin view failed to start: " + String(err && err.message ? err.message : err);\n'
        "});\n"
        "</script>\n"
        "</body>\n"
        "</html>\n"
    )

    return _FrameDoc(
        html=html,
        headers={
            "content-security-policy": csp,
            "x-content-type-options": "nosniff",
            "referrer-policy": "no-referrer",
            "cache-control": "no-store",
            "cross-origin-resource-policy": "same-origin",
        },
    )
