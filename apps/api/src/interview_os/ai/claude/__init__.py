"""Claude provider: Agent SDK runtime behind an injectable seam."""

from .child_env import build_claude_child_env
from .detect import (
    CLAUDE_SETUP_MESSAGE,
    claude_health_check,
    find_claude_executable,
    get_claude_version,
)
from .runtime import (
    DEFAULT_MODELS,
    DEFAULT_TASK_TIMEOUT_MS,
    ClaudeCodeRuntime,
    ClaudeRuntimeOptions,
)
from .sdk import (
    ClaudeQuery,
    ClaudeSdk,
    ClaudeSdkMessage,
    ClaudeSdkModelInfo,
    ClaudeSdkOptions,
    RealClaudeSdk,
)

__all__ = [
    "CLAUDE_SETUP_MESSAGE",
    "DEFAULT_MODELS",
    "DEFAULT_TASK_TIMEOUT_MS",
    "ClaudeCodeRuntime",
    "ClaudeQuery",
    "ClaudeRuntimeOptions",
    "ClaudeSdk",
    "ClaudeSdkMessage",
    "ClaudeSdkModelInfo",
    "ClaudeSdkOptions",
    "RealClaudeSdk",
    "build_claude_child_env",
    "claude_health_check",
    "find_claude_executable",
    "get_claude_version",
]
