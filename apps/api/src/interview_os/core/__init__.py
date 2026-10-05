"""Core state shapes — the single source of truth for every model (invariant #1).

`interview_os.core.models` holds the Pydantic v2 port of `packages/core`'s Zod
schemas; `interview_os.core.plugin_api` holds the `PLUGIN_HOOKS` contracts.
"""

from . import plugin_api
from .models import *  # noqa: F403
from .models import __all__ as _models_all
from .plugin_api import (
    CAPABILITY_HOOKS,
    LEGACY_HOOK_KIND,
    MANIFEST_FEATURE_SINCE,
    PLUGIN_API_VERSION,
    PLUGIN_EVENT_HOOKS,
    PLUGIN_EVENT_NAMES,
    PLUGIN_HOOK_NAMES,
    PLUGIN_HOOKS,
    HookSpec,
    capability_hooks,
    hook_capability,
    is_plugin_hook_name,
)
from .skill_id import (
    SKILL_ID_REGEX,
    SkillId,
    humanize_skill_segment,
    is_skill_id,
    parent_skill_id,
)

__all__ = [
    "CAPABILITY_HOOKS",
    "LEGACY_HOOK_KIND",
    "MANIFEST_FEATURE_SINCE",
    "PLUGIN_API_VERSION",
    "PLUGIN_EVENT_HOOKS",
    "PLUGIN_EVENT_NAMES",
    "PLUGIN_HOOK_NAMES",
    "PLUGIN_HOOKS",
    "SKILL_ID_REGEX",
    "HookSpec",
    "SkillId",
    "capability_hooks",
    "hook_capability",
    "humanize_skill_segment",
    "is_plugin_hook_name",
    "is_skill_id",
    "parent_skill_id",
    "plugin_api",
    *_models_all,
]
