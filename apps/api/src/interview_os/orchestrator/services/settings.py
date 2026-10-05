"""Settings service — port of `apps/server/src/orchestrator/settings-service.ts`."""

from __future__ import annotations

import json
from collections.abc import Mapping
from enum import StrEnum

from pydantic import Field, StrictBool, ValidationError

from ...ai.interface import AIRuntime, ReasoningEffort
from ...core.models import AppError, CamelModel, SlugId
from ..context import WorkflowContext

__all__ = [
    "OrchestratorSettings",
    "QuestionSources",
    "SettingsService",
    "TaskMode",
    "VoiceSettings",
]


class TaskMode(StrEnum):
    APP_SERVER = "app-server"
    EXEC = "exec"


TASK_MODES: tuple[TaskMode, ...] = (TaskMode.APP_SERVER, TaskMode.EXEC)


class QuestionSources(CamelModel):
    """v0.4: which question sources feed main questions, in priority order."""

    #: `z.boolean()` is strict: "yes"/1 are not booleans.
    company_packs: StrictBool = True
    role_packs: StrictBool = True
    user_bank: StrictBool = True
    plugins: list[SlugId] = Field(default_factory=list)


class VoiceSettings(CamelModel):
    """v0.4 voice mode: interaction-layer only, off by default."""

    enabled: StrictBool = False
    speak_questions: StrictBool = True


class OrchestratorSettings(CamelModel):
    model: str | None
    reasoning_effort: ReasoningEffort | None
    task_mode: TaskMode
    question_sources: QuestionSources
    voice: VoiceSettings


def _json(value: CamelModel) -> str:
    return json.dumps(value.model_dump(by_alias=True, mode="json"), separators=(",", ":"))


def _mapping(value: object) -> dict[str, object]:
    return dict(value) if isinstance(value, Mapping) else {}


def _str_or_none(value: object) -> str | None:
    return value if isinstance(value, str) else None


class SettingsService:
    def __init__(self, ctx: WorkflowContext, runtime: AIRuntime) -> None:
        self._ctx = ctx
        self._runtime = runtime

    async def get_settings(self) -> OrchestratorSettings:
        options = await self._ctx.runtime_options()

        question_sources = QuestionSources()
        raw_sources = self._ctx.store.get_setting("questionSources")
        if raw_sources:
            try:
                question_sources = QuestionSources.model_validate(json.loads(raw_sources))
            except (json.JSONDecodeError, ValidationError):
                pass

        voice = VoiceSettings()
        raw_voice = self._ctx.store.get_setting("voice")
        if raw_voice:
            try:
                voice = VoiceSettings.model_validate(json.loads(raw_voice))
            except (json.JSONDecodeError, ValidationError):
                pass

        return OrchestratorSettings(
            model=options.model,
            reasoning_effort=options.effort,
            task_mode=TaskMode(options.task_mode or "app-server"),
            question_sources=question_sources,
            voice=voice,
        )

    async def _resolve_model_or_default(self, saved: str | None) -> str | None:
        """Resolve a saved model against the live catalog. A model that vanished
        (provider changed / catalog refreshed) falls back to the entry flagged
        `isDefault` (or the first entry) and is persisted, so the UI never shows
        a stale id. Returns the effective model."""

        models = await self._runtime.list_models()
        if not models:
            return saved
        if saved is not None and any(model.id == saved for model in models):
            return saved
        fallback = next((model for model in models if model.is_default), models[0])
        next_model = fallback.id
        if next_model != saved:
            self._ctx.store.set_setting("model", next_model)
        return next_model

    async def update_settings(self, patch: Mapping[str, object]) -> OrchestratorSettings:
        """Apply a camelCase settings patch; absent keys are left untouched."""

        if "model" in patch:
            model = _str_or_none(patch["model"])
            if model is not None:
                self._ctx.store.set_setting("model", await self._resolve_model_or_default(model))
            else:
                self._ctx.store.set_setting("model", None)

        if "reasoningEffort" in patch:
            effort = _str_or_none(patch["reasoningEffort"])
            if effort is not None:
                model = _str_or_none(patch.get("model"))
                if model is None:
                    model = self._ctx.store.get_setting("model")
                if model is not None:
                    models = await self._runtime.list_models()
                    match = next((entry for entry in models if entry.id == model), None)
                    if (
                        match is not None
                        and match.supported_reasoning_efforts
                        and effort not in match.supported_reasoning_efforts
                    ):
                        raise AppError(
                            "VALIDATION", f'model "{model}" does not support effort "{effort}"'
                        )
            self._ctx.store.set_setting("reasoningEffort", effort)

        # taskMode is a Codex-only execution detail; ignore it for other runtimes.
        if "taskMode" in patch and patch["taskMode"] is not None and self._runtime.kind == "codex":
            task_mode = patch["taskMode"]
            if task_mode not in TASK_MODES:
                raise AppError("VALIDATION", f'invalid taskMode "{task_mode}"')
            self._ctx.store.set_setting("taskMode", str(task_mode))

        if "questionSources" in patch and patch["questionSources"] is not None:
            current = (await self.get_settings()).question_sources
            merged = {**current.model_dump(by_alias=True), **_mapping(patch["questionSources"])}
            try:
                parsed = QuestionSources.model_validate(merged)
            except ValidationError as err:
                raise AppError("VALIDATION", "invalid questionSources setting") from err
            self._ctx.store.set_setting("questionSources", _json(parsed))

        if "voice" in patch and patch["voice"] is not None:
            current_voice = (await self.get_settings()).voice
            merged_voice = {**current_voice.model_dump(by_alias=True), **_mapping(patch["voice"])}
            try:
                parsed_voice = VoiceSettings.model_validate(merged_voice)
            except ValidationError as err:
                raise AppError("VALIDATION", "invalid voice setting") from err
            self._ctx.store.set_setting("voice", _json(parsed_voice))

        return await self.get_settings()
