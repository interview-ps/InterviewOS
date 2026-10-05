"""`plugin.yaml` manifest — the Octop-model replacement for `skill.yaml`.

Ports `octop_harness/plugins/manifest.py` onto Pydantic v2. One Interview OS
extension: the declarative `modes` block (§7.4), which reuses the existing
`PluginModeDefinition` model so the mode schema stays unchanged.

Validation (§4):
- `id`/`version` required; `id` is the slug regex (also the install dir name).
- unknown `kind` rejected (the `PluginKind` literal enforces it).
- `ui.entry`/`ui.manifest` (and `entry`) must not contain `..` or be absolute.
- a missing UI entry file is a warning (backend-only), never an error.
- `icon`/`group` parsing is lenient: an unparseable value becomes `None`.
"""

from __future__ import annotations

import logging
import re
from pathlib import Path
from typing import Literal

import yaml
from pydantic import (
    AliasChoices,
    BaseModel,
    ConfigDict,
    Field,
    ValidationError,
    field_validator,
    model_validator,
)

from ..core.models import (
    PluginAppliesTo,
    PluginInterviewMode,
    PluginModeDefinition,
    PluginSettingField,
    PluginTaxonomyNode,
)
from ..core.models.platform import compare_semver, parse_version
from ..core.models.skills import PluginUI as CorePluginUI

__all__ = [
    "PluginKind",
    "PluginManifest",
    "PluginManifestError",
    "PluginUI",
    "version_gt",
    "version_key",
]

_log = logging.getLogger(__name__)

PluginKind = Literal["tool", "skill", "hook"]

_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
_ABSOLUTE_RE = re.compile(r"^(?:[a-zA-Z]:|[\\/])")
_ICON_URL_RE = re.compile(r"^(?:https?://|data:image/)")
_ICON_FILE_RE = re.compile(
    r"^[\w./-]+\.(?:svg|png|jpe?g|gif|webp)$",
    re.IGNORECASE,
)
_GROUP_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,31}$")


class PluginManifestError(ValueError):
    """A `plugin.yaml` that cannot be read or fails validation."""


def _unsafe_relative(value: str) -> bool:
    """True when `value` is absolute, drive-qualified, or escapes its parent."""

    if _ABSOLUTE_RE.match(value):
        return True
    parts = value.replace("\\", "/").split("/")
    return ".." in parts


class PluginUI(CorePluginUI):
    """The rich UI block (phase-7 §1).

    Extends `core.models.skills.PluginUI` (declarative `navigation`/`commands`/
    `slots`/`pages`) with the `ui/dist` bundle paths the host serves. A plugin may
    ship rich declarative blocks, a prebuilt bundle, or both. `entry`/`manifest`
    must stay plugin-relative: absolute or `..`-escaping paths are rejected.
    """

    model_config = ConfigDict(frozen=True)

    entry: str = Field(default="ui/dist/index.js", min_length=1, max_length=300)
    manifest: str = Field(default="ui/dist/manifest.json", min_length=1, max_length=300)

    @field_validator("entry", "manifest")
    @classmethod
    def _relative_only(cls, value: str) -> str:
        if _unsafe_relative(value):
            raise ValueError('must be a relative path without ".."')
        return value


class PluginManifest(BaseModel):
    """The parsed `plugin.yaml`; frozen so a loader cannot mutate it mid-flight."""

    model_config = ConfigDict(frozen=True, populate_by_name=True)

    id: str = Field(pattern=r"^[a-z0-9][a-z0-9-]{0,63}$")
    version: str = Field(min_length=1, max_length=64)
    name: str = ""
    kind: PluginKind = "tool"
    entry: str = Field(default="main.py", min_length=1, max_length=300)
    description: str = ""
    requires: tuple[str, ...] = ()
    icon: str | None = None
    group: str | None = None
    # Declared hook names; implied by the middleware methods a plugin implements.
    hooks: tuple[str, ...] = ()
    # `appliesTo` skill-prefix scoping; also accepts the snake_case key.
    applies_to: PluginAppliesTo | None = Field(
        default=None,
        validation_alias=AliasChoices("appliesTo", "applies_to", "applies_at"),
        serialization_alias="appliesTo",
    )
    # Per-plugin settings fields and extra taxonomy nodes (§1).
    settings: tuple[PluginSettingField, ...] = ()
    taxonomy: tuple[PluginTaxonomyNode, ...] = ()
    # App-registered interview modes; JSON key `interviewModes`.
    interview_modes: tuple[PluginInterviewMode, ...] = Field(
        default=(),
        validation_alias=AliasChoices("interviewModes", "interview_modes"),
        serialization_alias="interviewModes",
    )
    ui: PluginUI | None = None
    # Interview OS extension (§7.4): declarative interview modes for hook plugins.
    modes: tuple[PluginModeDefinition, ...] = ()

    @model_validator(mode="before")
    @classmethod
    def _default_name(cls, data: object) -> object:
        if isinstance(data, dict):
            if data.get("name") in (None, ""):
                identifier = data.get("id")
                if isinstance(identifier, str):
                    return {**data, "name": identifier}
        return data

    @model_validator(mode="before")
    @classmethod
    def _coerce_sequences(cls, data: object) -> object:
        if isinstance(data, dict):
            patched = dict(data)
            for key in ("requires", "hooks"):
                value = patched.get(key)
                if isinstance(value, str):
                    patched[key] = (value,)
            # Empty YAML keys parse as None; normalize them to empty tuples.
            for key in (
                "modes",
                "hooks",
                "settings",
                "taxonomy",
                "applies_to",
                "appliesTo",
                "applies_at",
                "interview_modes",
                "interviewModes",
            ):
                if key in patched and patched[key] is None and key not in (
                    "applies_to",
                    "appliesTo",
                    "applies_at",
                ):
                    patched[key] = ()
            return patched
        return data

    @field_validator("entry")
    @classmethod
    def _entry_relative(cls, value: str) -> str:
        if _unsafe_relative(value):
            raise ValueError('must be a relative path without ".."')
        return value

    @field_validator("icon", mode="before")
    @classmethod
    def _lenient_icon(cls, value: object) -> object:
        """emoji | http(s)/data URL | plugin-relative image path; else None."""

        if not isinstance(value, str):
            return None
        text = value.strip()
        if not text or len(text) > 2048:
            return None
        if _ICON_URL_RE.match(text):
            return text
        if _ICON_FILE_RE.match(text):
            return None if _unsafe_relative(text) else text
        return text if len(text) <= 8 else None

    @field_validator("group", mode="before")
    @classmethod
    def _lenient_group(cls, value: object) -> object:
        """Catalog slug; unknown-but-valid values pass through, junk becomes None."""

        if not isinstance(value, str):
            return None
        text = value.strip()
        return text if _GROUP_RE.match(text) else None

    @classmethod
    def load(cls, path: Path) -> PluginManifest:
        """Read and validate a `plugin.yaml` at `path`."""

        try:
            text = path.read_text(encoding="utf-8")
        except OSError as err:
            reason = err.strerror or "unreadable"
            raise PluginManifestError(
                f'cannot read plugin manifest "{path.name}": {reason}'
            ) from err
        try:
            raw = yaml.safe_load(text)
        except yaml.YAMLError as err:
            raise PluginManifestError(f'"{path.name}" is not valid YAML') from err
        if raw is None:
            raw = {}
        if not isinstance(raw, dict):
            raise PluginManifestError(f'"{path.name}" must contain a mapping')
        try:
            manifest = cls.model_validate(raw)
        except ValidationError as err:
            raise PluginManifestError(f'"{path.name}": {_summarize(err)}') from err
        if manifest.ui is not None and not (path.parent / manifest.ui.entry).is_file():
            _log.warning(
                "plugin.ui_entry_missing plugin=%s entry=%s (backend-only)",
                manifest.id,
                manifest.ui.entry,
            )
        return manifest

    def ui_entry_path(self, plugin_dir: Path) -> Path | None:
        """The declared UI entry file, or None when it is absent (backend-only)."""

        if self.ui is None:
            return None
        candidate = plugin_dir / self.ui.entry
        return candidate if candidate.is_file() else None


def _summarize(error: ValidationError, limit: int = 300) -> str:
    """A bounded, single-line summary of the first validation error."""

    first = error.errors()[0]
    location = ".".join(str(part) for part in first.get("loc", ())) or "manifest"
    message = str(first.get("msg", "invalid"))
    summary = f"{location}: {message}"
    return summary[:limit]


def version_key(version: str) -> tuple[int, ...]:
    """`version` as a tuple of ints (`1.2.0` -> `(1, 2, 0)`); junk parts are 0."""

    key: list[int] = []
    for part in version.strip().split("."):
        digits = part.split("-", 1)[0]
        key.append(int(digits) if digits.isdigit() else 0)
    return tuple(key)


def version_gt(newer: str, older: str | None) -> bool:
    """True when `newer` is a strictly higher version than `older` (None -> True).

    Semver triples use the core `compare_semver`; anything else compares by
    dotted-int tuples, matching the design's "compared as tuples" rule.
    """

    if older is None:
        return True
    left = parse_version(newer)
    right = parse_version(older)
    if left is not None and right is not None:
        return compare_semver(left, right) > 0
    return version_key(newer) > version_key(older)
