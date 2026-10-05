"""SettingsService: defaults, persistence, catalog resolution and validation."""

from __future__ import annotations

import pytest

from interview_os.ai.interface import ModelInfo
from interview_os.ai.mock import MockRuntime
from interview_os.core.models import AppError
from interview_os.orchestrator.context import WorkflowContext
from interview_os.orchestrator.services.settings import (
    OrchestratorSettings,
    QuestionSources,
    SettingsService,
    TaskMode,
    VoiceSettings,
)


class CatalogRuntime(MockRuntime):
    """MockRuntime with a Codex-like model catalog."""

    kind = "codex"

    def __init__(self, models: list[ModelInfo]) -> None:
        super().__init__()
        self._models = models

    async def list_models(self) -> list[ModelInfo]:
        return self._models


CATALOG = [
    ModelInfo(
        id="gpt-5",
        display_name="GPT-5",
        supported_reasoning_efforts=["low", "medium", "high"],
        default_reasoning_effort="medium",
        is_default=True,
    ),
    ModelInfo(
        id="gpt-5-mini",
        display_name="GPT-5 mini",
        supported_reasoning_efforts=["low"],
        default_reasoning_effort="low",
    ),
]


def _service(ctx: WorkflowContext, runtime: MockRuntime) -> SettingsService:
    return SettingsService(ctx, runtime)


async def test_defaults(ctx: WorkflowContext) -> None:
    service = _service(ctx, MockRuntime())
    settings = await service.get_settings()
    assert settings.model is None
    assert settings.reasoning_effort is None
    assert settings.task_mode == TaskMode.APP_SERVER
    assert settings.question_sources == QuestionSources()
    assert settings.voice == VoiceSettings()


async def test_corrupt_stored_settings_fall_back_to_defaults(ctx: WorkflowContext) -> None:
    store = ctx.store
    store.set_setting("questionSources", "{not json")
    store.set_setting("voice", "[]")
    settings = await _service(ctx, MockRuntime()).get_settings()
    assert settings.question_sources == QuestionSources()
    assert settings.voice == VoiceSettings()


async def test_model_falls_back_to_the_catalog_default(ctx: WorkflowContext) -> None:
    store = ctx.store
    runtime = CatalogRuntime(CATALOG)
    service = _service(ctx, runtime)

    store.set_setting("model", "ghost-model")
    settings = await service.get_settings()
    assert settings.model == "ghost-model"

    updated = await service.update_settings({"model": "ghost-model"})
    assert updated.model == "gpt-5"
    assert store.get_setting("model") == "gpt-5"

    kept = await service.update_settings({"model": "gpt-5-mini"})
    assert kept.model == "gpt-5-mini"

    cleared = await service.update_settings({"model": None})
    assert cleared.model is None
    assert store.get_setting("model") is None


async def test_reasoning_effort_is_validated_against_the_model(ctx: WorkflowContext) -> None:
    store = ctx.store
    service = _service(ctx, CatalogRuntime(CATALOG))

    await service.update_settings({"model": "gpt-5"})
    ok = await service.update_settings({"reasoningEffort": "high"})
    assert ok.reasoning_effort == "high"

    with pytest.raises(AppError) as error:
        await service.update_settings({"reasoningEffort": "ultra"})
    assert error.value.code == "VALIDATION"
    assert error.value.args[0] == 'model "gpt-5" does not support effort "ultra"'
    assert store.get_setting("reasoningEffort") == "high"

    cleared = await service.update_settings({"reasoningEffort": None})
    assert cleared.reasoning_effort is None
    assert store.get_setting("reasoningEffort") is None


async def test_task_mode_only_applies_to_codex(ctx: WorkflowContext) -> None:
    store = ctx.store
    mock_service = _service(ctx, MockRuntime())
    await mock_service.update_settings({"taskMode": "exec"})
    assert store.get_setting("taskMode") is None

    codex_service = _service(ctx, CatalogRuntime(CATALOG))
    updated = await codex_service.update_settings({"taskMode": "exec"})
    assert updated.task_mode == TaskMode.EXEC
    assert store.get_setting("taskMode") == "exec"

    with pytest.raises(AppError) as error:
        await codex_service.update_settings({"taskMode": "turbo"})
    assert error.value.code == "VALIDATION"
    assert error.value.args[0] == 'invalid taskMode "turbo"'


async def test_question_sources_and_voice_merge_and_validate(ctx: WorkflowContext) -> None:
    store = ctx.store
    service = _service(ctx, MockRuntime())

    updated = await service.update_settings({"questionSources": {"userBank": False}})
    assert updated.question_sources.user_bank is False
    assert updated.question_sources.company_packs is True
    assert updated.question_sources.plugins == []
    assert store.get_setting("questionSources") == (
        '{"companyPacks":true,"rolePacks":true,"userBank":false,"plugins":[]}'
    )

    with_plugins = await service.update_settings(
        {"questionSources": {"plugins": ["postgres-interviewer"]}}
    )
    assert with_plugins.question_sources.plugins == ["postgres-interviewer"]
    assert with_plugins.question_sources.user_bank is False

    with pytest.raises(AppError) as error:
        await service.update_settings({"questionSources": {"userBank": "not-a-bool"}})
    assert error.value.code == "VALIDATION"
    assert error.value.args[0] == "invalid questionSources setting"

    voice = await service.update_settings({"voice": {"enabled": True}})
    assert voice.voice.enabled is True
    assert voice.voice.speak_questions is True
    assert store.get_setting("voice") == '{"enabled":true,"speakQuestions":true}'

    with pytest.raises(AppError) as voice_error:
        await service.update_settings({"voice": {"enabled": "yes"}})
    assert voice_error.value.code == "VALIDATION"
    assert voice_error.value.args[0] == "invalid voice setting"


async def test_untouched_keys_are_not_written(ctx: WorkflowContext) -> None:
    store = ctx.store
    service = _service(ctx, MockRuntime())
    settings = await service.update_settings({"questionSources": {"plugins": []}})
    assert isinstance(settings, OrchestratorSettings)
    assert store.get_setting("model") is None
    assert store.get_setting("reasoningEffort") is None
