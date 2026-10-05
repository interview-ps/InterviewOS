"""Devin provider: one-shot CLI runtime with a workspace prompt file."""

from .child_env import build_devin_child_env
from .cli import DevinRunner, DevinRunResult, run_devin_cli
from .detect import (
    DEVIN_SETUP_MESSAGE,
    devin_health_check,
    find_devin_executable,
    get_devin_version,
)
from .runtime import (
    DEFAULT_MODELS,
    DEFAULT_TASK_TIMEOUT_MS,
    DevinRuntime,
    DevinRuntimeOptions,
    parse_models_json,
    strip_fence,
)

__all__ = [
    "DEFAULT_MODELS",
    "DEFAULT_TASK_TIMEOUT_MS",
    "DEVIN_SETUP_MESSAGE",
    "DevinRunResult",
    "DevinRunner",
    "DevinRuntime",
    "DevinRuntimeOptions",
    "build_devin_child_env",
    "devin_health_check",
    "find_devin_executable",
    "get_devin_version",
    "parse_models_json",
    "run_devin_cli",
    "strip_fence",
]
