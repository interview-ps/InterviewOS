"""Pack loading and lookup — port of `apps/server/src/packs/registry.ts`.

Loads bundled + installed packs (company dirs, role dirs, interview YAML files),
compiles company profiles, and answers pack lookups. With no dirs configured it
degrades to built-ins only. `ready()` must be awaited once before the lookup
methods are used; it is idempotent.
"""

from __future__ import annotations

import os
import re
import shutil
import stat
import time
import uuid
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

import yaml
from pydantic import BaseModel

from ..adapters.git import clone_shallow, validate_git_source
from ..ai.logger import Logger
from ..core import taxonomy
from ..core.companies import COMPANY_PROFILES, compile_company_pack, match_profile_in
from ..core.models import (
    AppError,
    CamelModel,
    CompanyPack,
    CompanyPackOverlay,
    CompanyProfile,
    InterviewPack,
    PackQuestion,
    PackResource,
    PrepResource,
    QuestionCandidate,
    QuestionSource,
    QuestionSourceKind,
    RolePack,
)
from ..core.models.packs import CompanyPackWithOverlays, check_overlay_provenance
from ..core.models.shared import SLUG_ID_REGEX
from ..core.skill_id import SkillId
from ..core.taxonomy_seed import TaxonomyNodeSeed

__all__ = [
    "CompanyPackEntry",
    "InstallablePackKind",
    "InterviewPackEntry",
    "PACK_KIND_DIRS",
    "PackDirs",
    "PackLoadError",
    "PackRegistry",
    "RolePackEntry",
    "compatible_mode",
    "matches_skill",
]

InstallablePackKind = Literal["company", "role"]
PACK_KIND_DIRS: Mapping[InstallablePackKind, str] = {"company": "companies", "role": "roles"}

_YAML_SUFFIXES = (".yaml", ".yml")
_SLUG_ID_RE = re.compile(SLUG_ID_REGEX)


def _parse[M: BaseModel](model: type[M], raw: object) -> M:
    return model.model_validate(raw)


class PackLoadError(CamelModel):
    dir: str
    file: str
    error: str


class CompanyPackEntry(CamelModel):
    pack: CompanyPackWithOverlays
    profile: CompanyProfile
    source: str
    dir: str


class RolePackEntry(CamelModel):
    pack: RolePack
    source: str
    dir: str


class InterviewPackEntry(CamelModel):
    pack: InterviewPack
    source: Literal["bundled"]


@dataclass(frozen=True, slots=True)
class PackDirs:
    bundled: Path | None = None
    installed: Path | None = None


def matches_skill(question_skill: str, skill_id: str) -> bool:
    return question_skill == skill_id or question_skill.startswith(f"{skill_id}.")


def compatible_mode(mode: str | None, round_type: str) -> bool:
    return not mode or mode == round_type or round_type == "mixed"


def _plugin_source(plugin_id: str) -> str:
    return f"plugin:{plugin_id}"


def _strip_yaml_suffix(file_name: str) -> str:
    for suffix in _YAML_SUFFIXES:
        if file_name.endswith(suffix):
            return file_name[: -len(suffix)]
    return file_name


def _remove(path: Path) -> None:
    """Best-effort recursive delete — cloned git objects are read-only on Windows."""

    def handle(function: Callable[..., object], target: str, _exc: BaseException) -> None:
        try:
            os.chmod(target, stat.S_IWRITE)
            function(target)
        except OSError:
            pass

    if not path.exists():
        return
    shutil.rmtree(path, onexc=handle)


def _prep_resource(resource: PackResource, skill_id: SkillId, pack_id: str) -> PrepResource:
    return PrepResource(
        skill_id=skill_id,
        title=resource.title,
        url=resource.url,
        summary=resource.summary,
        kind=resource.kind,
        source=f"pack:{pack_id}",
    )


class PackRegistry:
    def __init__(self, dirs: PackDirs | None = None, logger: Logger | None = None) -> None:
        self._dirs = dirs if dirs is not None else PackDirs()
        self._logger = logger
        self._company_packs: dict[str, CompanyPackEntry] = {}
        self._role_packs: dict[str, RolePackEntry] = {}
        self._interview_packs: dict[str, InterviewPackEntry] = {}
        self._plugin_dirs: list[tuple[str, Path]] = []
        self.load_errors: list[PackLoadError] = []
        self._loaded = False

    async def ready(self) -> None:
        """Load (or reload) all pack directories; safe to call repeatedly. Loads
        are synchronous filesystem reads so pack lookups can stay sync for
        callers."""

        self.ensure_loaded()

    def ensure_loaded(self) -> None:
        """Synchronous ensure-loaded for the sync lookup methods below."""

        if not self._loaded:
            self._load_all()
            self._loaded = True

    def set_plugin_dirs(self, dirs: Sequence[tuple[str, Path]]) -> None:
        """Plugin pack dirs currently in effect (enabled + compatible plugins with
        pack capabilities only); call `reload()` afterwards."""

        self._plugin_dirs = list(dirs)

    def reload(self) -> None:
        self._load_all()
        self._loaded = True

    # ------------------------------------------------------------- loading

    def _fail(self, dir: str, file: str, err: BaseException) -> None:
        error = str(err)[:300]
        self.load_errors.append(PackLoadError(dir=dir, file=file, error=error))
        if self._logger is not None:
            self._logger.warn("pack.load_failed", {"dir": dir, "file": file, "error": error})

    def _load_all(self) -> None:
        self._company_packs.clear()
        self._role_packs.clear()
        self._interview_packs.clear()
        self.load_errors.clear()
        bundled, installed = self._dirs.bundled, self._dirs.installed
        if bundled is not None:
            self._load_tree(bundled, "bundled")
        if installed is not None:
            self._load_tree(installed, "installed")
        # v1: enabled plugins may ship packs/ under their plugin dir; tagged
        # source `plugin:<id>` and id collisions are load errors for that pack.
        for plugin_id, directory in self._plugin_dirs:
            self._load_tree(directory / "packs", _plugin_source(plugin_id))
        # role packs may add taxonomy nodes — register once everything is loaded
        for entry in self._role_packs.values():
            if entry.pack.taxonomy:
                taxonomy.register_nodes(
                    [
                        TaxonomyNodeSeed(id=node.id, label=node.label, keywords=node.keywords)
                        for node in entry.pack.taxonomy
                    ]
                )

    def _load_tree(self, root: Path, source: str) -> None:
        self._load_company_dir(root / PACK_KIND_DIRS["company"], source)
        self._load_role_dir(root / PACK_KIND_DIRS["role"], source)
        if source == "bundled":
            self._load_interview_dir(root / "interview")

    def _subdirs(self, directory: Path) -> list[str]:
        try:
            entries = list(directory.iterdir())
        except OSError:
            return []
        return sorted(
            entry.name for entry in entries if entry.is_dir() and not entry.name.startswith(".")
        )

    def _yaml_files(self, directory: Path) -> list[str]:
        return sorted(
            entry.name
            for entry in directory.iterdir()
            if not entry.name.startswith(".") and entry.name.endswith(_YAML_SUFFIXES)
        )

    def _load_company_dir(self, root: Path, source: str) -> None:
        for name in self._subdirs(root):
            directory = root / name
            try:
                files = self._yaml_files(directory)
            except OSError as err:
                self._fail(f"{PACK_KIND_DIRS['company']}/{name}", "company.yaml", err)
                continue
            base_file = next(
                (file for file in files if file in ("company.yaml", "company.yml")), None
            )
            if base_file is None:
                self._fail(
                    f"{PACK_KIND_DIRS['company']}/{name}",
                    "company.yaml",
                    ValueError("company pack is missing company.yaml"),
                )
                continue
            try:
                raw = yaml.safe_load((directory / base_file).read_text(encoding="utf-8"))
                pack = _parse(CompanyPack, raw)
                if any(profile.id == pack.id for profile in COMPANY_PROFILES):
                    raise ValueError(
                        f'company pack id "{pack.id}" collides with a built-in profile'
                    )
                if source.startswith("plugin:") and pack.id in self._company_packs:
                    raise ValueError(f'company pack id "{pack.id}" collides with an existing pack')
                overlays: list[CompanyPackOverlay] = []
                for file in files:
                    if file == base_file:
                        continue
                    overlay_raw = yaml.safe_load((directory / file).read_text(encoding="utf-8"))
                    overlay = _parse(CompanyPackOverlay, overlay_raw)
                    check_overlay_provenance(_strip_yaml_suffix(file), overlay, pack.sources)
                    overlays.append(overlay)
                full = CompanyPackWithOverlays(**pack.model_dump(), overlays=overlays)
                self._company_packs[pack.id] = CompanyPackEntry(
                    pack=full,
                    profile=compile_company_pack(full),
                    source=source,
                    dir=str(directory),
                )
            except Exception as err:  # noqa: BLE001 - one bad pack must not stop the load
                self._fail(f"{PACK_KIND_DIRS['company']}/{name}", base_file, err)

    def _load_role_dir(self, root: Path, source: str) -> None:
        for name in self._subdirs(root):
            directory = root / name
            try:
                raw = yaml.safe_load((directory / "role.yaml").read_text(encoding="utf-8"))
                pack = _parse(RolePack, raw)
                if pack.id != name:
                    raise ValueError(f'role pack id "{pack.id}" does not match directory "{name}"')
                if source.startswith("plugin:") and pack.id in self._role_packs:
                    raise ValueError(f'role pack id "{pack.id}" collides with an existing pack')
                self._role_packs[pack.id] = RolePackEntry(
                    pack=pack, source=source, dir=str(directory)
                )
            except Exception as err:  # noqa: BLE001 - one bad pack must not stop the load
                self._fail(f"{PACK_KIND_DIRS['role']}/{name}", "role.yaml", err)

    def _load_interview_dir(self, root: Path) -> None:
        try:
            files = sorted(
                entry.name for entry in root.iterdir() if entry.name.endswith(_YAML_SUFFIXES)
            )
        except OSError:
            return
        for file in files:
            try:
                raw = yaml.safe_load((root / file).read_text(encoding="utf-8"))
                pack = _parse(InterviewPack, raw)
                self._interview_packs[pack.id] = InterviewPackEntry(pack=pack, source="bundled")
            except Exception as err:  # noqa: BLE001 - one bad pack must not stop the load
                self._fail(f"interview/{file}", file, err)

    # ------------------------------------------------------------- lookups

    def list_company_profiles(self) -> list[CompanyProfile]:
        """Built-in + pack-compiled company profiles."""

        self.ensure_loaded()
        return [*COMPANY_PROFILES, *(entry.profile for entry in self._company_packs.values())]

    def company_profile(self, profile_id: str) -> CompanyProfile:
        self.ensure_loaded()
        for profile in COMPANY_PROFILES:
            if profile.id == profile_id:
                return profile
        entry = self._company_packs.get(profile_id)
        if entry is not None:
            return entry.profile
        return next(profile for profile in COMPANY_PROFILES if profile.id == "generic")

    def match_company_profile(self, company_name: str) -> CompanyProfile:
        return match_profile_in(self.list_company_profiles(), company_name)

    def company_pack(self, pack_id: str) -> CompanyPackWithOverlays | None:
        self.ensure_loaded()
        entry = self._company_packs.get(pack_id)
        return None if entry is None else entry.pack

    def list_company_packs(self) -> list[CompanyPackEntry]:
        self.ensure_loaded()
        return list(self._company_packs.values())

    def role_pack(self, pack_id: str) -> RolePack | None:
        self.ensure_loaded()
        entry = self._role_packs.get(pack_id)
        return None if entry is None else entry.pack

    def list_role_packs(self) -> list[RolePackEntry]:
        self.ensure_loaded()
        return list(self._role_packs.values())

    def list_interview_packs(self) -> list[InterviewPack]:
        self.ensure_loaded()
        return [entry.pack for entry in self._interview_packs.values()]

    def bundled_interview_pack(self, pack_id: str) -> InterviewPack | None:
        self.ensure_loaded()
        entry = self._interview_packs.get(pack_id)
        return None if entry is None else entry.pack

    def installed_pack_dir(self, kind: InstallablePackKind) -> Path | None:
        if self._dirs.installed is None:
            return None
        return self._dirs.installed / PACK_KIND_DIRS[kind]

    # ------------------------------------------------------------- install

    async def install_pack_from_git(self, kind: InstallablePackKind, url: str) -> dict[str, str]:
        """Clone a pack repo into a temp dir under installed/<kind>s, validate it,
        rename to <id>, and reload the registry. Returns the pack id."""

        installed_root = self.installed_pack_dir(kind)
        if installed_root is None:
            raise AppError("PACK_INSTALL", "pack install requires configured pack directories")
        validate_git_source(url, "PACK_INSTALL")
        installed_root.mkdir(parents=True, exist_ok=True)
        tmp_dir = installed_root / f".tmp-{int(time.time() * 1000)}-{uuid.uuid4().hex[:6]}"
        try:
            await clone_shallow(url, tmp_dir, "PACK_INSTALL")
        except BaseException:
            _remove(tmp_dir)
            raise
        try:
            file = "company.yaml" if kind == "company" else "role.yaml"
            raw = yaml.safe_load((tmp_dir / file).read_text(encoding="utf-8"))
            if kind == "company":
                pack_id = _parse(CompanyPack, raw).id
            else:
                pack_id = _parse(RolePack, raw).id
            if _SLUG_ID_RE.fullmatch(pack_id) is None:
                raise ValueError(f'invalid pack id "{pack_id}"')
            dest = installed_root / pack_id
            _remove(tmp_dir / ".git")
            _remove(dest)
            tmp_dir.rename(dest)
            self._load_all()
            loaded = (
                pack_id in self._company_packs if kind == "company" else pack_id in self._role_packs
            )
            if not loaded:
                err = next(
                    (
                        error
                        for error in self.load_errors
                        if error.dir.endswith(f"/{pack_id}") or error.dir.endswith(f"\\{pack_id}")
                    ),
                    None,
                )
                raise AppError(
                    "PACK_INSTALL",
                    f'pack "{pack_id}" failed to load{": " + err.error if err is not None else ""}',
                )
            if self._logger is not None:
                self._logger.info("pack.installed", {"pack": pack_id, "kind": kind})
            return {"id": pack_id}
        except BaseException as err:
            _remove(tmp_dir)
            if isinstance(err, AppError):
                raise
            raise AppError("PACK_INSTALL", f"invalid pack: {str(err)[:200]}") from err

    async def uninstall_pack(self, kind: InstallablePackKind, pack_id: str) -> None:
        """Remove an installed pack; bundled packs cannot be removed."""

        entry = (
            self._company_packs.get(pack_id) if kind == "company" else self._role_packs.get(pack_id)
        )
        if entry is None:
            raise AppError("NOT_FOUND", f'unknown {kind} pack "{pack_id}"')
        if entry.source != "installed":
            raise AppError("VALIDATION", f'pack "{pack_id}" is bundled and cannot be uninstalled')
        _remove(Path(entry.dir))
        self._company_packs.pop(pack_id, None)
        self._role_packs.pop(pack_id, None)
        if self._logger is not None:
            self._logger.info("pack.uninstalled", {"pack": pack_id, "kind": kind})

    # ----------------------------------------------------- question sources

    def _pack_questions(
        self,
        questions: Sequence[PackQuestion],
        skill_id: SkillId,
        round_type: str,
        kind: QuestionSourceKind,
        pack_id: str,
    ) -> list[QuestionCandidate]:
        return [
            QuestionCandidate(
                skill_id=question.skill_id,
                text=question.text,
                difficulty=question.difficulty,
                mode=question.mode,
                source=QuestionSource(kind=kind, id=pack_id, provenance=question.provenance),
            )
            for question in questions
            if matches_skill(question.skill_id, skill_id)
            and compatible_mode(question.mode, round_type)
        ]

    def overlay_applies(
        self, overlay: CompanyPackOverlay, role: str, round_type: str | None = None
    ) -> bool:
        """Overlays matching a target role/round apply on top of the base pack."""

        role_hit = any(
            keyword.lower() in role.lower() for keyword in overlay.applies_to.role_keywords
        )
        mode = overlay.applies_to.mode
        mode_hit = mode is not None and round_type is not None and mode == round_type
        return role_hit or mode_hit

    def company_pack_questions(
        self, company_profile_id: str, skill_id: SkillId, round_type: str, role: str
    ) -> list[QuestionCandidate]:
        """Question candidates from a company profile's pack — overlay questions
        (matching role/mode) first, then base pack questions."""

        self.ensure_loaded()
        entry = self._company_packs.get(company_profile_id)
        if entry is None:
            return []
        overlay_questions = [
            question
            for overlay in entry.pack.overlays
            if self.overlay_applies(overlay, role, round_type)
            for question in self._pack_questions(
                overlay.questions,
                skill_id,
                round_type,
                QuestionSourceKind.COMPANY_PACK,
                entry.pack.id,
            )
        ]
        return [
            *overlay_questions,
            *self._pack_questions(
                entry.pack.questions,
                skill_id,
                round_type,
                QuestionSourceKind.COMPANY_PACK,
                entry.pack.id,
            ),
        ]

    def role_pack_questions(
        self, role_pack_id: str, skill_id: SkillId, round_type: str
    ) -> list[QuestionCandidate]:
        self.ensure_loaded()
        entry = self._role_packs.get(role_pack_id)
        if entry is None:
            return []
        return self._pack_questions(
            entry.pack.questions, skill_id, round_type, QuestionSourceKind.ROLE_PACK, entry.pack.id
        )

    def role_rubrics(self, role_pack_id: str | None, skill_id: SkillId, mode: str) -> list[str]:
        """Role-pack rubric criteria for a skill/mode (interviewer + evaluator
        guidance)."""

        self.ensure_loaded()
        if not role_pack_id:
            return []
        entry = self._role_packs.get(role_pack_id)
        if entry is None:
            return []
        return [
            criterion
            for rubric in entry.pack.rubrics
            if (rubric.skill_id == skill_id or rubric.skill_id is None)
            and (rubric.mode == mode or rubric.mode is None)
            for criterion in rubric.criteria
        ]

    def role_pack_resources(
        self, role_pack_id: str | None, skill_id: SkillId
    ) -> list[PrepResource]:
        self.ensure_loaded()
        if not role_pack_id:
            return []
        entry = self._role_packs.get(role_pack_id)
        if entry is None:
            return []
        return [
            _prep_resource(resource, skill_id, entry.pack.id)
            for resource in entry.pack.resources
            if matches_skill(resource.skill_id, skill_id) or resource.skill_id == skill_id
        ]
