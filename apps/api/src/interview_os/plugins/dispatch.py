"""Lifecycle-hook dispatch over the middleware chain (§7.3).

Every hook is dispatched in `(priority, plugin_id)` order through the enabled
plugins' middleware instances; a plugin that raises is logged and skipped, and
its absence never fails the caller. `appliesTo` scoping is applied when the
request names a skill, and each plugin's settings values are visible to its hook
via `current_plugin_settings()` (used by `questions.suggest`).
"""

from __future__ import annotations

import contextvars
import logging
from collections.abc import Callable, Iterator, Mapping
from contextlib import contextmanager

from ..core.models.platform import plugin_applies_to_skill
from .context import LoadedPlugin, MiddlewareRegistration
from .registry import PluginRegistry

__all__ = [
    "HOOK_METHODS",
    "PluginDispatcher",
    "current_plugin_settings",
    "use_plugin_settings",
]

_log = logging.getLogger(__name__)

#: Hook name → middleware method name.
HOOK_METHODS: dict[str, str] = {
    "questions.suggest": "questions_suggest",
    "resources.suggest": "resources_suggest",
    "preparation.suggest": "preparation_suggest",
    "evaluation.review": "evaluation_review",
    "ui.render": "ui_render",
    "ui.frameRun": "ui_frame_run",
    "mode.reduce": "mode_reduce",
    "mode.followUp": "mode_follow_up",
    "mode.mock": "mode_mock",
    "mode.prepareTurn": "mode_prepare_turn",
    "events.sessionCompleted": "on_session_completed",
    "events.readinessUpdated": "on_readiness_updated",
    "events.answerEvaluated": "on_answer_evaluated",
    "events.loopCompleted": "on_loop_completed",
    "events.targetChanged": "on_target_changed",
}

_settings_var: contextvars.ContextVar[Mapping[str, object] | None] = contextvars.ContextVar(
    "interview_os_plugin_settings", default=None
)


def current_plugin_settings() -> Mapping[str, object]:
    """The invoking plugin's settings values, or `{}` outside a dispatch."""

    return _settings_var.get() or {}


@contextmanager
def use_plugin_settings(values: Mapping[str, object]) -> Iterator[None]:
    """Bind `values` as the current plugin settings for the enclosed call."""

    token = _settings_var.set(values)
    try:
        yield
    finally:
        _settings_var.reset(token)


def _skill_ids_of(request: object) -> list[str]:
    """The skill ids a request names, for `appliesTo` filtering."""

    single = getattr(request, "skill_id", None)
    if isinstance(single, str) and single:
        return [single]
    many = getattr(request, "skill_ids", None)
    if isinstance(many, (list, tuple)):
        return [str(item) for item in many if isinstance(item, str) and item]
    return []


class PluginDispatcher:
    """Runs lifecycle hooks across the enabled plugin middleware chain."""

    def __init__(
        self,
        registry: PluginRegistry | None = None,
        *,
        enabled: Callable[[str], bool] | None = None,
        settings_for: Callable[[str], Mapping[str, object]] | None = None,
    ) -> None:
        self._registry = registry if registry is not None else PluginRegistry()
        self._enabled = enabled if enabled is not None else (lambda _plugin_id: True)
        self._settings_for = settings_for if settings_for is not None else (lambda _plugin_id: {})

    # ------------------------------------------------------------------ internals

    def _entries(self) -> list[tuple[str, LoadedPlugin, MiddlewareRegistration]]:
        entries: list[tuple[str, LoadedPlugin, MiddlewareRegistration]] = []
        for loaded in self._registry.list_plugins():
            plugin_id = loaded.manifest.id
            if not self._enabled(plugin_id):
                continue
            for registration in loaded.middleware:
                entries.append((plugin_id, loaded, registration))
        entries.sort(key=lambda entry: (entry[2].priority, entry[0]))
        return entries

    async def dispatch(
        self,
        hook: str,
        request: object,
        *,
        skill_id: str | None = None,
    ) -> list[object]:
        """Invoke `hook` on every applicable middleware instance; collect responses."""

        method = HOOK_METHODS.get(hook)
        if method is None:
            raise ValueError(f"unknown plugin hook {hook!r}")
        skill_ids = [skill_id] if skill_id else _skill_ids_of(request)
        responses: list[object] = []
        for plugin_id, loaded, registration in self._entries():
            handler = getattr(registration.instance, method, None)
            if handler is None:
                continue
            if skill_ids and not any(
                plugin_applies_to_skill(loaded.manifest.applies_to, skill) for skill in skill_ids
            ):
                continue
            token = _settings_var.set(self._settings_for(plugin_id))
            try:
                response = await handler(request)
            except Exception as err:  # noqa: BLE001 - one plugin must not fail the host
                _log.warning(
                    "plugin.hook_failed plugin=%s hook=%s error=%s",
                    plugin_id,
                    hook,
                    type(err).__name__,
                )
                continue
            finally:
                _settings_var.reset(token)
            if response is not None:
                responses.append(response)
        return responses

    # ------------------------------------------------------------------- helpers

    async def questions_suggest(self, request: object) -> list[object]:
        return await self.dispatch("questions.suggest", request)

    async def resources_suggest(self, request: object) -> list[object]:
        return await self.dispatch("resources.suggest", request)

    async def preparation_suggest(self, request: object) -> list[object]:
        return await self.dispatch("preparation.suggest", request)

    async def evaluation_review(self, request: object) -> list[object]:
        return await self.dispatch("evaluation.review", request)

    async def ui_render(self, request: object) -> list[object]:
        return await self.dispatch("ui.render", request)

    async def ui_frame_run(self, request: object) -> list[object]:
        return await self.dispatch("ui.frameRun", request)

    async def mode_mock(self, request: object) -> list[object]:
        return await self.dispatch("mode.mock", request)

    async def mode_reduce(self, request: object) -> list[object]:
        return await self.dispatch("mode.reduce", request)

    async def mode_follow_up(self, request: object) -> list[object]:
        return await self.dispatch("mode.followUp", request)

    async def mode_prepare_turn(self, request: object) -> list[object]:
        return await self.dispatch("mode.prepareTurn", request)

    async def on_session_completed(self, request: object) -> list[object]:
        return await self.dispatch("events.sessionCompleted", request)

    async def on_readiness_updated(self, request: object) -> list[object]:
        return await self.dispatch("events.readinessUpdated", request)

    async def on_answer_evaluated(self, request: object) -> list[object]:
        return await self.dispatch("events.answerEvaluated", request)

    async def on_loop_completed(self, request: object) -> list[object]:
        return await self.dispatch("events.loopCompleted", request)

    async def on_target_changed(self, request: object) -> list[object]:
        return await self.dispatch("events.targetChanged", request)
