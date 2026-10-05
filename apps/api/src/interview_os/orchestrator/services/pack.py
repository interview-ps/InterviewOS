"""Pack service — port of `apps/server/src/orchestrator/pack-service.ts`."""

from __future__ import annotations

import re
from collections.abc import Awaitable, Callable, Mapping
from typing import Annotated, Literal

import yaml
from pydantic import Field, StringConstraints, ValidationError

from ...core import new_id
from ...core.models import (
    AppError,
    CamelModel,
    CompanyPackStage,
    InterviewPack,
    ModeId,
    PackItem,
    PackResource,
    PackSource,
    Provenance,
    QuestionCandidate,
    QuestionDifficulty,
    QuestionSource,
    QuestionSourceKind,
    RolePackDimension,
    SlugId,
)
from ...core.skill_id import SkillId
from ...packs.registry import InstallablePackKind, PackLoadError, PackRegistry
from ..context import ProgressOptions, WorkflowContext

__all__ = [
    "CompanyPackView",
    "CreateInterviewPackInput",
    "InterviewPackView",
    "PackListView",
    "PackService",
    "QuestionBankItem",
    "RolePackView",
    "slugify",
]

_SLUGIFY_RE = re.compile(r"[^a-z0-9]+")
_DASH_EDGES_RE = re.compile(r"^-+|-+$")


InterviewPackSource = Literal["bundled", "user", "imported"]


class InterviewPackView(CamelModel):
    pack: InterviewPack
    source: InterviewPackSource
    created_at: str | None = None
    updated_at: str | None = None


class PackItemView(CamelModel):
    """v0.4: everything the /packs UI needs — detail included, text-only."""

    group: str
    text: str
    provenance: Provenance
    source: SlugId | None = None


class CompanyPackView(CamelModel):
    id: str
    name: str
    version: str
    source: str
    description: str
    aliases: list[str]
    stages: list[CompanyPackStage]
    sources: list[PackSource]
    items: list[PackItemView]
    sourced_count: int
    community_count: int


class RolePackView(CamelModel):
    id: str
    name: str
    version: str
    source: str
    description: str
    dimensions: list[RolePackDimension]
    default_question_categories: list[ModeId]
    resources: list[PackResource]


class PackListView(CamelModel):
    companies: list[CompanyPackView]
    roles: list[RolePackView]
    load_errors: list[PackLoadError]


class QuestionBankItem(CamelModel):
    skill_id: SkillId
    text: str = Field(min_length=10, max_length=1200)
    difficulty: QuestionDifficulty | None = None
    mode: ModeId | None = None


class QuestionBankItemView(CamelModel):
    id: str
    skill_id: SkillId
    text: str
    difficulty: QuestionDifficulty | None = None
    mode: ModeId | None = None
    created_at: str


class CreateInterviewPackRound(CamelModel):
    mode: ModeId
    label: str = Field(min_length=1, max_length=80)
    planned_questions: int = Field(ge=1, le=6)


class CreateInterviewPackInput(CamelModel):
    name: str = Field(min_length=1, max_length=120)
    description: str = Field(default="", max_length=2000)
    author: str = Field(default="", max_length=120)
    version: Annotated[str | None, StringConstraints(min_length=1, max_length=32)] = None
    skills: list[SkillId] = Field(min_length=1, max_length=12)
    rounds: list[CreateInterviewPackRound] = Field(min_length=2, max_length=7)
    duration_minutes: int = Field(ge=15, le=600)


class InstallPackResult(CamelModel):
    id: str


class ExportInterviewPackResult(CamelModel):
    filename: str
    content: str


class ImportQuestionBankResult(CamelModel):
    imported: int


QUESTION_BANK_IMPORT_MAX = 500

_START_LOOP = Callable[[Mapping[str, object], ProgressOptions | None], Awaitable[object]]


class _QuestionBankImport(CamelModel):
    items: list[QuestionBankItem] = Field(max_length=QUESTION_BANK_IMPORT_MAX)


def slugify(name: str) -> str:
    slug = _DASH_EDGES_RE.sub("", _SLUGIFY_RE.sub("-", name.lower()))[:60]
    return slug or "pack"


def compare_versions(a: str, b: str) -> int:
    """Loose semver compare: numeric x.y.z; returns <0 / 0 / >0."""

    parsed_a = [int(part) if part.isdigit() else 0 for part in a.split(".")]
    parsed_b = [int(part) if part.isdigit() else 0 for part in b.split(".")]
    for index in range(3):
        left = parsed_a[index] if index < len(parsed_a) else 0
        right = parsed_b[index] if index < len(parsed_b) else 0
        if left != right:
            return left - right
    return 0


class PackService:
    def __init__(
        self,
        ctx: WorkflowContext,
        *,
        start_loop: _START_LOOP,
    ) -> None:
        self._ctx = ctx
        self._start_loop = start_loop

    def _packs(self) -> PackRegistry:
        packs = self._ctx.packs
        if packs is None:
            raise AppError("VALIDATION", "no pack registry configured")
        return packs

    # ----------------------------------------------------------------- packs

    async def list_packs(self) -> PackListView:
        packs = self._packs()
        await packs.ready()
        companies: list[CompanyPackView] = []
        for entry in packs.list_company_packs():
            pack = entry.pack
            items = [
                *(_grouped("competencies", item) for item in pack.competencies),
                *(_grouped("question style", item) for item in pack.question_style),
                *(_grouped("evaluation guidance", item) for item in pack.evaluation_guidance),
            ]
            companies.append(
                CompanyPackView(
                    id=pack.id,
                    name=pack.name,
                    version=pack.version,
                    source=entry.source,
                    description=pack.description,
                    aliases=pack.aliases,
                    stages=list(pack.stages),
                    sources=pack.sources,
                    items=items,
                    sourced_count=sum(1 for item in items if item.provenance == Provenance.SOURCED),
                    community_count=sum(
                        1 for item in items if item.provenance == Provenance.COMMUNITY
                    ),
                )
            )
        roles = [
            RolePackView(
                id=entry.pack.id,
                name=entry.pack.name,
                version=entry.pack.version,
                source=entry.source,
                description=entry.pack.description,
                dimensions=entry.pack.dimensions,
                default_question_categories=entry.pack.default_question_categories,
                resources=entry.pack.resources,
            )
            for entry in packs.list_role_packs()
        ]
        return PackListView(
            companies=companies,
            roles=roles,
            load_errors=list(packs.load_errors),
        )

    async def install_pack_from_git(self, kind: InstallablePackKind, url: str) -> InstallPackResult:
        packs = self._packs()
        await packs.ready()
        installed = await packs.install_pack_from_git(kind, url)
        return InstallPackResult(id=installed["id"])

    async def uninstall_pack(self, kind: InstallablePackKind, id: str) -> None:
        packs = self._packs()
        await packs.ready()
        await packs.uninstall_pack(kind, id)

    # ------------------------------------------------------- interview packs

    async def list_interview_packs(self) -> list[InterviewPackView]:
        packs = self._packs()
        await packs.ready()
        views = [
            InterviewPackView(pack=pack, source="bundled") for pack in packs.list_interview_packs()
        ]
        for row in self._ctx.store.list_interview_packs():
            try:
                pack = InterviewPack.model_validate(row.data)
            except ValidationError:
                continue
            views.append(
                InterviewPackView(
                    pack=pack,
                    source=row.source,
                    created_at=row.created_at,
                    updated_at=row.updated_at,
                )
            )
        return views

    async def _find_pack(self, id: str) -> tuple[InterviewPack, InterviewPackSource] | None:
        """All known packs: DB rows first, bundled fallback."""

        row = self._ctx.store.get_interview_pack(id)
        if row is not None:
            try:
                return InterviewPack.model_validate(row.data), row.source
            except ValidationError:
                pass  # fall through to the bundled pack
        packs = self._ctx.packs
        if packs is None:
            return None
        await packs.ready()
        bundled = packs.bundled_interview_pack(id)
        return (bundled, "bundled") if bundled is not None else None

    async def create_interview_pack(self, input: CreateInterviewPackInput) -> InterviewPackView:
        parsed = CreateInterviewPackInput.model_validate(input)
        base = slugify(parsed.name)
        id = base
        taken = {view.pack.id for view in await self.list_interview_packs()}
        counter = 2
        while id in taken:
            id = f"{base}-{counter}"
            counter += 1
        pack = InterviewPack.model_validate(
            {
                **parsed.model_dump(by_alias=True),
                "id": id,
                "version": parsed.version or "1.0.0",
            }
        )
        now = self._ctx.iso()
        self._ctx.store.insert_interview_pack(
            id=pack.id, data=pack, source="user", created_at=now, updated_at=now
        )
        self._ctx.logger.info("state.mutated", {"entity": "interview_pack", "id": pack.id})
        return InterviewPackView(pack=pack, source="user")

    async def get_interview_pack(self, id: str) -> InterviewPackView:
        found = await self._find_pack(id)
        if found is None:
            raise AppError("NOT_FOUND", f'no interview pack "{id}"')
        pack, source = found
        row = self._ctx.store.get_interview_pack(id)
        return InterviewPackView(
            pack=pack,
            source=source,
            created_at=None if row is None else row.created_at,
            updated_at=None if row is None else row.updated_at,
        )

    async def delete_interview_pack(self, id: str) -> None:
        row = self._ctx.store.get_interview_pack(id)
        if row is None:
            bundled = await self._find_pack(id)
            if bundled is not None:
                raise AppError("VALIDATION", f'interview pack "{id}" is bundled and read-only')
            raise AppError("NOT_FOUND", f'no interview pack "{id}"')
        self._ctx.store.delete_interview_pack(id)
        self._ctx.logger.info(
            "state.mutated", {"entity": "interview_pack", "id": id, "deleted": True}
        )

    async def export_interview_pack(self, id: str) -> ExportInterviewPackResult:
        found = await self._find_pack(id)
        if found is None:
            raise AppError("NOT_FOUND", f'no interview pack "{id}"')
        pack, _ = found
        return ExportInterviewPackResult(
            filename=f"{pack.id}-{pack.version}.interview-pack.yaml",
            content=yaml.safe_dump(
                pack.model_dump(by_alias=True, mode="json"),
                sort_keys=False,
                allow_unicode=True,
                default_flow_style=False,
            ),
        )

    async def import_interview_pack(self, content: str) -> InterviewPackView:
        """Import YAML (or JSON) interview-pack content. Same id+version →
        conflict; bundled ids are read-only; a higher version replaces a
        user/imported pack."""

        try:
            raw = yaml.safe_load(content)
        except yaml.YAMLError as err:
            raise AppError("VALIDATION", "interview pack content is not valid YAML/JSON") from err
        try:
            pack = InterviewPack.model_validate(raw)
        except ValidationError as err:
            raise AppError("VALIDATION", f"invalid interview pack: {str(err)[:300]}") from err
        packs = self._packs()
        await packs.ready()
        if packs.bundled_interview_pack(pack.id) is not None:
            raise AppError("CONFLICT", f'interview pack id "{pack.id}" is bundled')
        existing = self._ctx.store.get_interview_pack(pack.id)
        if existing is not None:
            try:
                current = InterviewPack.model_validate(existing.data)
            except ValidationError:
                current = None
            if current is not None and compare_versions(current.version, pack.version) >= 0:
                raise AppError(
                    "CONFLICT",
                    f'interview pack "{pack.id}" v{current.version} already exists',
                )
        now = self._ctx.iso()
        self._ctx.store.upsert_interview_pack(
            id=pack.id,
            data=pack,
            source="imported",
            created_at=now if existing is None else existing.created_at,
            updated_at=now,
        )
        self._ctx.logger.info("state.mutated", {"entity": "interview_pack", "id": pack.id})
        return InterviewPackView(pack=pack, source="imported")

    async def start_loop_from_pack(self, id: str, opts: ProgressOptions | None = None) -> object:
        """Start a loop from an interview pack: rounds + focus skills come from
        the pack."""

        found = await self._find_pack(id)
        if found is None:
            raise AppError("NOT_FOUND", f'no interview pack "{id}"')
        pack, _ = found
        return await self._start_loop(
            {
                "rounds": [
                    {
                        "mode": round_.mode,
                        "label": round_.label,
                        "plannedQuestions": round_.planned_questions,
                    }
                    for round_ in pack.rounds
                ],
                "packId": pack.id,
                "focusSkills": list(pack.skills),
            },
            opts,
        )

    # --------------------------------------------------------- question bank

    async def list_question_bank(self) -> list[QuestionCandidate]:
        return [
            QuestionCandidate(
                skill_id=row.skill_id,
                text=row.text,
                difficulty=(
                    QuestionDifficulty(row.difficulty) if row.difficulty is not None else None
                ),
                mode=row.mode,
                source=QuestionSource(kind=QuestionSourceKind.USER_BANK, id=row.id),
            )
            for row in self._ctx.store.list_user_questions()
        ]

    async def add_user_question(self, item: QuestionBankItem) -> QuestionBankItemView:
        parsed = QuestionBankItem.model_validate(item)
        row = QuestionBankItemView(
            id=new_id("uq"),
            skill_id=parsed.skill_id,
            text=parsed.text,
            difficulty=parsed.difficulty,
            mode=parsed.mode,
            created_at=self._ctx.iso(),
        )
        self._ctx.store.insert_user_question(
            id=row.id,
            skill_id=row.skill_id,
            text=row.text,
            difficulty=row.difficulty.value if row.difficulty is not None else None,
            mode=row.mode,
            created_at=row.created_at,
        )
        self._ctx.logger.info("state.mutated", {"entity": "user_question", "id": row.id})
        return row

    async def delete_user_question(self, id: str) -> None:
        row = self._ctx.store.get_user_question(id)
        if row is None:
            raise AppError("NOT_FOUND", f'no question "{id}"')
        self._ctx.store.delete_user_question(id)

    async def import_question_bank(self, content: str) -> ImportQuestionBankResult:
        """All-or-nothing import of a YAML/JSON question-bank array (max 500)."""

        try:
            raw = yaml.safe_load(content)
        except yaml.YAMLError as err:
            raise AppError("VALIDATION", "question bank content is not valid YAML/JSON") from err
        try:
            items = _parse_question_bank(raw)
        except ValidationError as err:
            raise AppError("VALIDATION", f"invalid question bank: {str(err)[:300]}") from err
        created_at = self._ctx.iso()
        with self._ctx.store.transaction() as tx:
            for item in items:
                tx.insert_user_question(
                    id=new_id("uq"),
                    skill_id=item.skill_id,
                    text=item.text,
                    difficulty=item.difficulty.value if item.difficulty is not None else None,
                    mode=item.mode,
                    created_at=created_at,
                )
        self._ctx.logger.info("state.mutated", {"entity": "user_question", "imported": len(items)})
        return ImportQuestionBankResult(imported=len(items))


def _grouped(group: str, item: PackItem) -> PackItemView:
    return PackItemView(group=group, text=item.text, provenance=item.provenance, source=item.source)


def _parse_question_bank(raw: object) -> list[QuestionBankItem]:
    return _QuestionBankImport.model_validate({"items": raw}).items
