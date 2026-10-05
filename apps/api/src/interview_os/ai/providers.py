"""Provider registry and factories (port of `providers.ts`).

Custom providers are trusted local Python modules named by
`interview-os.runtimes.json` — local config only, never HTTP.
"""

from __future__ import annotations

import importlib.util
import inspect
import json
import re
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Protocol

from ..paths import REPO_ROOT
from .claude import ClaudeCodeRuntime, ClaudeRuntimeOptions
from .claude.detect import claude_health_check
from .codex import CodexRuntime, CodexRuntimeOptions
from .codex.detect import codex_health_check
from .devin import DevinRuntime, DevinRuntimeOptions
from .devin.detect import devin_health_check
from .interface import AIRuntime, RuntimeKind, RuntimeStatus
from .logger import Logger
from .mock import MockRuntime, MockRuntimeOptions
from .opencode import OpencodeRuntime, OpencodeRuntimeOptions
from .opencode.detect import opencode_health_check
from .process import env_number

__all__ = [
    "DEFAULT_WORKSPACE_DIR",
    "HEALTH_CHECKERS",
    "RUNTIME_KINDS",
    "LoadedProviders",
    "RuntimeHealthChecker",
    "RuntimeProviderSpec",
    "all_runtime_kinds",
    "health_checker_for",
    "instantiate_provider",
    "is_runtime_kind",
    "load_runtime_providers",
    "mock_delay_ms",
    "register_runtime_provider",
    "registered_runtime_providers",
    "workspace_dir_for",
]

RUNTIME_KINDS: tuple[RuntimeKind, ...] = ("codex", "mock", "claude", "opencode", "devin")

DEFAULT_WORKSPACE_DIR = str((REPO_ROOT / "data" / "codex-workspace").resolve())

SLUG_RE = re.compile(r"^[a-z][a-z0-9-]{0,39}$")

PROVIDER_MODULE_PREFIX = "interview_os_runtime_provider_"


class ProviderCreate(Protocol):
    """Build the provider's `AIRuntime` (called per switch + at startup)."""

    def __call__(
        self, *, env: Mapping[str, str], workspace_dir: str, logger: Logger | None
    ) -> AIRuntime | Awaitable[AIRuntime]: ...


RuntimeHealthChecker = Callable[[Mapping[str, str], str], Awaitable[RuntimeStatus]]


@dataclass(frozen=True, slots=True)
class RuntimeProviderSpec:
    #: Slug id — must not collide with a built-in kind.
    kind: str
    create: ProviderCreate
    label: str | None = None
    #: Optional detection probe (defaults to the runtime's own health check).
    health_check: RuntimeHealthChecker | None = None


@dataclass(frozen=True, slots=True)
class LoadedProviders:
    loaded: list[str]
    errors: list[str]


_custom_providers: dict[str, RuntimeProviderSpec] = {}


def register_runtime_provider(spec: RuntimeProviderSpec) -> None:
    """Register a trusted local runtime provider.

    Providers run in-process (they need networks and child processes) and are
    loaded only from the local `interview-os.runtimes.json`.
    """

    if SLUG_RE.match(spec.kind) is None:
        raise ValueError(f'invalid runtime provider kind "{spec.kind}"')
    if spec.kind in RUNTIME_KINDS:
        raise ValueError(f'runtime provider kind "{spec.kind}" collides with a built-in runtime')
    if not callable(spec.create):
        raise ValueError(f'runtime provider "{spec.kind}" must export create()')
    _custom_providers[spec.kind] = spec


def registered_runtime_providers() -> list[RuntimeProviderSpec]:
    return list(_custom_providers.values())


def all_runtime_kinds() -> list[RuntimeKind]:
    """Built-ins + registered custom providers."""

    return [*RUNTIME_KINDS, *_custom_providers]


def is_runtime_kind(value: str) -> bool:
    return value in all_runtime_kinds()


def workspace_dir_for(
    kind: RuntimeKind,
    env: Mapping[str, str],
    override: str | None = None,
) -> str:
    if override:
        return str(Path(override).resolve())
    per_provider = env.get(f"INTERVIEW_OS_{kind.upper()}_WORKSPACE")
    if per_provider:
        return str(Path(per_provider).resolve())
    if kind == "mock":
        return DEFAULT_WORKSPACE_DIR
    return str((REPO_ROOT / f"data/{kind}-workspace").resolve())


def mock_delay_ms(env: Mapping[str, str]) -> int:
    value = env_number(env, "INTERVIEW_OS_MOCK_DELAY_MS") or 0
    return int(max(0.0, value))


async def instantiate_provider(
    kind: RuntimeKind,
    *,
    env: Mapping[str, str],
    workspace_dir: str,
    logger: Logger | None = None,
) -> AIRuntime:
    """Instantiate a provider in its own workspace dir (callers mkdir first)."""

    custom = _custom_providers.get(kind)
    if custom is not None:
        created = custom.create(env=env, workspace_dir=workspace_dir, logger=logger)
        return await created if inspect.isawaitable(created) else created
    if kind == "mock":
        return MockRuntime(MockRuntimeOptions(chunk_delay_ms=mock_delay_ms(env)))
    if kind == "claude":
        return ClaudeCodeRuntime(
            ClaudeRuntimeOptions(env=env, workspace_dir=workspace_dir, logger=logger)
        )
    if kind == "opencode":
        return OpencodeRuntime(
            OpencodeRuntimeOptions(env=env, workspace_dir=workspace_dir, logger=logger)
        )
    if kind == "devin":
        return DevinRuntime(
            DevinRuntimeOptions(env=env, workspace_dir=workspace_dir, logger=logger)
        )
    return CodexRuntime(CodexRuntimeOptions(env=env, workspace_dir=workspace_dir, logger=logger))


async def _mock_health(_env: Mapping[str, str], workspace_dir: str) -> RuntimeStatus:
    return RuntimeStatus(
        runtime="mock",
        available=True,
        workspace=workspace_dir,
        status="ready",
        message="deterministic mock",
    )


#: Per-provider detection probes — cheap (PATH scan + `--version`).
HEALTH_CHECKERS: dict[str, RuntimeHealthChecker] = {
    "codex": codex_health_check,
    "claude": claude_health_check,
    "opencode": opencode_health_check,
    "devin": devin_health_check,
    "mock": _mock_health,
}


def health_checker_for(kind: RuntimeKind) -> RuntimeHealthChecker:
    """Probe for a kind: built-in checker, then the provider's own."""

    custom = _custom_providers.get(kind)
    if custom is not None and custom.health_check is not None:
        check = custom.health_check

        async def custom_with_probe(env: Mapping[str, str], workspace_dir: str) -> RuntimeStatus:
            return replace(await check(env, workspace_dir), trusted_local=True)

        return custom_with_probe
    if custom is not None:

        async def custom_probe(env: Mapping[str, str], workspace_dir: str) -> RuntimeStatus:
            runtime = await instantiate_provider(
                kind, env=env, workspace_dir=workspace_dir, logger=None
            )
            try:
                return replace(await runtime.health_check(), trusted_local=True)
            finally:
                await runtime.dispose()

        return custom_probe
    checker = HEALTH_CHECKERS.get(kind)
    if checker is not None:
        return checker

    async def unknown(_env: Mapping[str, str], workspace_dir: str) -> RuntimeStatus:
        return RuntimeStatus(
            runtime=kind,
            available=False,
            workspace=workspace_dir,
            status="unavailable",
            message=f'unknown runtime "{kind}"',
        )

    return unknown


def _load_provider_module(module_path: Path, kind: str) -> RuntimeProviderSpec:
    """Import a provider module and read its `PROVIDER` spec.

    The Python analogue of the TypeScript `default` export: a module-level
    `RuntimeProviderSpec` named `PROVIDER` (or `provider`).
    """

    if not module_path.is_file():
        raise FileNotFoundError(f"cannot load provider module {module_path}")
    module_name = PROVIDER_MODULE_PREFIX + re.sub(r"[^a-z0-9_]", "_", kind)
    spec = importlib.util.spec_from_file_location(module_name, module_path)
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot import provider module {module_path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    provider = getattr(module, "PROVIDER", None)
    if provider is None:
        provider = getattr(module, "provider", None)
    if not isinstance(provider, RuntimeProviderSpec):
        raise TypeError("module must export a RuntimeProviderSpec named PROVIDER")
    return provider


def load_runtime_providers(
    config_path: str | Path,
    logger: Logger | None = None,
) -> LoadedProviders:
    """Load trusted local runtime providers from `interview-os.runtimes.json`.

    Each entry names a Python module (absolute or relative to the config file)
    exporting a `PROVIDER` spec. A bad module must not stop the server.
    """

    loaded: list[str] = []
    errors: list[str] = []
    try:
        raw = json.loads(Path(config_path).read_text(encoding="utf-8"))
    except FileNotFoundError:
        return LoadedProviders(loaded, errors)
    except (OSError, ValueError) as err:
        errors.append(f"cannot read {config_path}: {str(err)[:200]}")
        return LoadedProviders(loaded, errors)

    entries: object = raw
    if isinstance(raw, dict):
        entries = raw.get("providers")
    if not isinstance(entries, list):
        errors.append(f"{config_path}: expected an array or {{ providers: [...] }}")
        return LoadedProviders(loaded, errors)

    config_dir = Path(config_path).resolve().parent
    for entry in entries:
        kind = entry.get("kind") if isinstance(entry, dict) else None
        module = entry.get("module") if isinstance(entry, dict) else None
        try:
            if not isinstance(kind, str) or not isinstance(module, str):
                raise ValueError("entries must be { kind, module }")
            module_path = Path(module)
            if not module_path.is_absolute():
                module_path = config_dir / module_path
            spec = _load_provider_module(module_path, kind)
            register_runtime_provider(replace(spec, kind=kind))
            loaded.append(kind)
        except Exception as err:  # a bad entry must not stop the server
            message = f"{kind if kind is not None else '?'}: {err}"[:300]
            errors.append(message)
            if logger is not None:
                logger.warn("runtime.provider_load_failed", {"error": message})
    return LoadedProviders(loaded, errors)
