"""PackService: /packs views, interview packs, question bank, loop hand-off."""

from __future__ import annotations

from collections.abc import Mapping

import pytest
from pydantic import ValidationError

from interview_os.core.models import AppError, InterviewPack, Provenance
from interview_os.orchestrator.context import ProgressOptions, WorkflowContext
from interview_os.orchestrator.services.pack import (
    CreateInterviewPackInput,
    PackService,
    QuestionBankItem,
)


class LoopRecorder:
    def __init__(self) -> None:
        self.calls: list[tuple[Mapping[str, object], ProgressOptions | None]] = []

    async def __call__(self, input: Mapping[str, object], opts: ProgressOptions | None) -> object:
        self.calls.append((input, opts))
        return {"loop": {"id": "loop_1"}}


def _service(ctx: WorkflowContext, recorder: LoopRecorder | None = None) -> PackService:
    return PackService(ctx, start_loop=recorder if recorder is not None else LoopRecorder())


PACK_INPUT = CreateInterviewPackInput.model_validate(
    {
        "name": "My Loop",
        "skills": ["sql"],
        "rounds": [
            {"mode": "technical", "label": "Tech", "plannedQuestions": 2},
            {"mode": "behavioral", "label": "Behav", "plannedQuestions": 2},
        ],
        "durationMinutes": 60,
    }
)


async def test_list_packs_reports_provenance_counts(ctx: WorkflowContext) -> None:
    view = await _service(ctx).list_packs()

    assert view.load_errors == []
    assert [company.id for company in view.companies] == ["stripe"]
    stripe = view.companies[0]
    assert stripe.source == "bundled"
    assert stripe.sourced_count == 0
    assert stripe.community_count > 0
    assert {item.group for item in stripe.items} == {
        "competencies",
        "question style",
        "evaluation guidance",
    }
    assert all(item.provenance == Provenance.COMMUNITY for item in stripe.items)
    assert [stage.mode for stage in stripe.stages][:2] == ["technical", "coding"]

    assert "backend-engineer" in {role.id for role in view.roles}
    backend = next(role for role in view.roles if role.id == "backend-engineer")
    assert backend.source == "bundled"
    assert backend.default_question_categories == [
        "technical",
        "coding",
        "system_design",
        "behavioral",
    ]
    assert backend.resources


async def test_interview_pack_crud_and_conflicts(ctx: WorkflowContext) -> None:
    service = _service(ctx)

    bundled = await service.list_interview_packs()
    assert [entry.pack.id for entry in bundled] == ["senior-backend"]
    assert bundled[0].source == "bundled"
    assert bundled[0].created_at is None

    created = await service.create_interview_pack(PACK_INPUT)
    assert created.pack.id == "my-loop"
    assert created.pack.version == "1.0.0"
    assert created.source == "user"

    duplicate = await service.create_interview_pack(PACK_INPUT)
    assert duplicate.pack.id == "my-loop-2"

    fetched = await service.get_interview_pack("my-loop")
    assert fetched.pack.name == "My Loop"
    assert fetched.created_at is not None
    assert fetched.updated_at is not None

    exported = await service.export_interview_pack("my-loop")
    assert exported.filename == "my-loop-1.0.0.interview-pack.yaml"
    assert "interview-os.interview-pack" in exported.content
    assert "id: my-loop" in exported.content

    await service.delete_interview_pack("my-loop")
    with pytest.raises(AppError) as missing:
        await service.get_interview_pack("my-loop")
    assert missing.value.code == "NOT_FOUND"
    assert missing.value.args[0] == 'no interview pack "my-loop"'

    imported = await service.import_interview_pack(exported.content)
    assert imported.pack.id == "my-loop"
    assert imported.source == "imported"
    assert imported.created_at is None

    with pytest.raises(AppError) as conflict:
        await service.import_interview_pack(exported.content)
    assert conflict.value.code == "CONFLICT"
    assert conflict.value.args[0] == 'interview pack "my-loop" v1.0.0 already exists'

    with pytest.raises(AppError) as bundled_conflict:
        await service.import_interview_pack(
            exported.content.replace("id: my-loop", "id: senior-backend")
        )
    assert bundled_conflict.value.code == "CONFLICT"
    assert bundled_conflict.value.args[0] == 'interview pack id "senior-backend" is bundled'

    with pytest.raises(AppError) as read_only:
        await service.delete_interview_pack("senior-backend")
    assert read_only.value.code == "VALIDATION"
    assert read_only.value.args[0] == 'interview pack "senior-backend" is bundled and read-only'

    with pytest.raises(AppError) as not_found:
        await service.delete_interview_pack("nope")
    assert not_found.value.code == "NOT_FOUND"
    assert not_found.value.args[0] == 'no interview pack "nope"'


async def test_import_rejects_bad_content_and_upgrades_versions(ctx: WorkflowContext) -> None:
    service = _service(ctx)
    await service.create_interview_pack(PACK_INPUT)
    exported = await service.export_interview_pack("my-loop")

    with pytest.raises(AppError) as invalid_yaml:
        await service.import_interview_pack("{ not: [valid")
    assert invalid_yaml.value.code == "VALIDATION"
    assert invalid_yaml.value.args[0] == "interview pack content is not valid YAML/JSON"

    with pytest.raises(AppError) as invalid_pack:
        await service.import_interview_pack("id: x")
    assert invalid_pack.value.code == "VALIDATION"
    assert str(invalid_pack.value.args[0]).startswith("invalid interview pack: ")

    upgraded = await service.import_interview_pack(
        exported.content.replace("version: 1.0.0", "version: 2.0.0")
    )
    assert upgraded.source == "imported"
    assert upgraded.pack.version == "2.0.0"
    stored = await service.get_interview_pack("my-loop")
    assert stored.pack.version == "2.0.0"
    assert stored.source == "imported"


async def test_start_loop_from_pack_hands_the_rounds_over(ctx: WorkflowContext) -> None:
    recorder = LoopRecorder()
    service = _service(ctx, recorder)

    result = await service.start_loop_from_pack("senior-backend")
    assert result == {"loop": {"id": "loop_1"}}
    assert len(recorder.calls) == 1
    input, opts = recorder.calls[0]
    assert opts is None
    assert input["packId"] == "senior-backend"
    rounds = input["rounds"]
    assert isinstance(rounds, list)
    assert [round_["mode"] for round_ in rounds] == [
        "technical",
        "coding",
        "system_design",
        "behavioral",
    ]
    assert input["focusSkills"] == ["distributed-systems", "sql", "apis", "system-design"]

    with pytest.raises(AppError) as error:
        await service.start_loop_from_pack("nope")
    assert error.value.code == "NOT_FOUND"
    assert error.value.args[0] == 'no interview pack "nope"'


async def test_question_bank_crud(ctx: WorkflowContext) -> None:
    service = _service(ctx)

    added = await service.add_user_question(
        QuestionBankItem(skill_id="sql", text="Explain WAL versus shared_buffers tuning.")
    )
    assert added.id.startswith("uq_")
    assert added.difficulty is None
    assert added.mode is None

    bank = await service.list_question_bank()
    assert [item.text for item in bank] == ["Explain WAL versus shared_buffers tuning."]
    assert bank[0].source.kind == "user_bank"
    assert bank[0].source.id == added.id

    with pytest.raises(ValidationError):
        await service.add_user_question(QuestionBankItem(skill_id="sql", text="short"))

    await service.delete_user_question(added.id)
    assert await service.list_question_bank() == []

    with pytest.raises(AppError) as missing:
        await service.delete_user_question(added.id)
    assert missing.value.code == "NOT_FOUND"
    assert missing.value.args[0] == f'no question "{added.id}"'


async def test_question_bank_import_is_all_or_nothing(ctx: WorkflowContext) -> None:
    service = _service(ctx)

    with pytest.raises(AppError) as invalid_yaml:
        await service.import_question_bank("{ not: [valid")
    assert invalid_yaml.value.code == "VALIDATION"
    assert invalid_yaml.value.args[0] == "question bank content is not valid YAML/JSON"

    with pytest.raises(AppError) as invalid_item:
        await service.import_question_bank(
            '- skillId: sql\n  text: "Difference between DELETE and TRUNCATE?"\n'
            "- skillId: sql\n  text: short\n"
        )
    assert invalid_item.value.code == "VALIDATION"
    assert await service.list_question_bank() == []

    with pytest.raises(AppError) as too_many:
        await service.import_question_bank(
            "\n".join(
                f'- skillId: sql\n  text: "Question number {index} about indexes?"'
                for index in range(501)
            )
        )
    assert too_many.value.code == "VALIDATION"
    assert await service.list_question_bank() == []

    bank_yaml = (
        '- skillId: sql\n  text: "Difference between DELETE and TRUNCATE?"\n'
        "- skillId: sql.indexing\n"
        '  text: "When is a covering index worth it?"\n'
        "  difficulty: hard\n"
    )
    result = await service.import_question_bank(bank_yaml)
    assert result.imported == 2
    bank = await service.list_question_bank()
    assert len(bank) == 2
    assert {item.skill_id for item in bank} == {"sql", "sql.indexing"}
    assert [item.difficulty for item in bank] == [None, "hard"]


async def test_install_and_uninstall_delegate_to_the_registry(
    ctx: WorkflowContext, tmp_path: object
) -> None:
    service = _service(ctx)

    with pytest.raises(AppError) as bad_source:
        await service.install_pack_from_git("company", "ssh://x@y/z")
    assert bad_source.value.code == "PACK_INSTALL"

    with pytest.raises(AppError) as missing:
        await service.uninstall_pack("company", "nope")
    assert missing.value.code == "NOT_FOUND"
    assert missing.value.args[0] == 'unknown company pack "nope"'


async def test_services_without_a_pack_registry(
    file_store: object, host: object, runtime: object
) -> None:
    from interview_os.ai.logger import NullLogger
    from interview_os.skills import SkillHost
    from interview_os.store import Store

    ctx = WorkflowContext(
        store=file_store,  # type: ignore[arg-type]
        host=host,  # type: ignore[arg-type]
        runtime=runtime,  # type: ignore[arg-type]
        logger=NullLogger(),
        packs=None,
    )
    assert isinstance(file_store, Store)
    assert isinstance(host, SkillHost)
    service = _service(ctx)
    with pytest.raises(AppError) as error:
        await service.list_packs()
    assert error.value.code == "VALIDATION"
    assert error.value.args[0] == "no pack registry configured"


async def test_pack_view_serializes_camel_case(ctx: WorkflowContext) -> None:
    view = await _service(ctx).list_packs()
    payload = view.model_dump(by_alias=True, mode="json")
    stripe = payload["companies"][0]
    assert stripe["sourcedCount"] == 0
    assert stripe["communityCount"] > 0
    assert stripe["stages"][0]["plannedQuestions"] == 4
    assert isinstance(InterviewPack, type)
