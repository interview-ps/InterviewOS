"""Skills package — port of `apps/server/src/skills/index.ts`."""

from __future__ import annotations

from .analyze import company_profiler, gap_analyzer, jd_analyzer, resume_analyzer
from .builtins import BUILTIN_SKILLS, register_builtin_skills
from .common import TaxonomyEntry, normalize_skill_id_value, normalize_skill_ids, taxonomy_entries
from .framework import (
    InterviewSkill,
    PluginKvStorage,
    ProgressUpdate,
    RuntimeOptions,
    SkillContext,
    SkillInput,
    SkillOutputError,
    SkillRuntimeError,
    SkillSchema,
    SkillTask,
    json_input,
    run_structured,
    validate_schema,
)
from .host import (
    PLUGIN_OUTPUT_MAX_BYTES,
    PLUGIN_TIMEOUT_MS,
    PermissionError,
    PluginError,
    PluginExecutor,
    PluginStateSlices,
    SkillHost,
    effective_permissions,
    is_manifest_compatible,
)
from .mock import install_mode_mock_fallback, register_mock_handlers

__all__ = [
    "BUILTIN_SKILLS",
    "PLUGIN_OUTPUT_MAX_BYTES",
    "PLUGIN_TIMEOUT_MS",
    "InterviewSkill",
    "PermissionError",
    "PluginError",
    "PluginExecutor",
    "PluginKvStorage",
    "PluginStateSlices",
    "ProgressUpdate",
    "RuntimeOptions",
    "SkillContext",
    "SkillHost",
    "SkillInput",
    "SkillOutputError",
    "SkillRuntimeError",
    "SkillSchema",
    "SkillTask",
    "TaxonomyEntry",
    "company_profiler",
    "effective_permissions",
    "gap_analyzer",
    "install_mode_mock_fallback",
    "is_manifest_compatible",
    "jd_analyzer",
    "json_input",
    "normalize_skill_id_value",
    "normalize_skill_ids",
    "register_builtin_skills",
    "register_mock_handlers",
    "resume_analyzer",
    "run_structured",
    "taxonomy_entries",
    "validate_schema",
]
