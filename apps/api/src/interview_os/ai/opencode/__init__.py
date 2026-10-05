"""opencode provider: one-shot CLI runtime."""

from .child_env import build_opencode_child_env
from .cli import OpencodeRunner, OpencodeRunResult, run_opencode_cli
from .detect import (
    OPENCODE_SETUP_MESSAGE,
    find_opencode_executable,
    get_opencode_version,
    opencode_health_check,
)
from .runtime import (
    DEFAULT_TASK_TIMEOUT_MS,
    OpencodeRuntime,
    OpencodeRuntimeOptions,
    extract_assistant_text,
    parse_model,
    strip_fence,
)

__all__ = [
    "DEFAULT_TASK_TIMEOUT_MS",
    "OPENCODE_SETUP_MESSAGE",
    "OpencodeRunResult",
    "OpencodeRunner",
    "OpencodeRuntime",
    "OpencodeRuntimeOptions",
    "build_opencode_child_env",
    "extract_assistant_text",
    "find_opencode_executable",
    "get_opencode_version",
    "opencode_health_check",
    "parse_model",
    "run_opencode_cli",
    "strip_fence",
]
