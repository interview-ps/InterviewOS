"""Export/import service — port of `apps/server/src/orchestrator/export-service.ts`."""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Sequence
from typing import Any

from pydantic import ValidationError

from ...core.models import (
    EXPORT_PARTS,
    EXPORTED_SETTING_KEYS,
    INTERVIEW_OS_VERSION,
    AppError,
    ExportBundle,
)
from ..context import WorkflowContext

__all__ = ["ExportService", "ImportCounts"]

ImportCounts = dict[str, int]

_MODE = "replace"


def _duplicate_id(rows: Sequence[Any], table: str) -> None:
    seen: set[object] = set()
    for row in rows:
        row_id = row.id
        if row_id in seen:
            raise AppError("VALIDATION", f'duplicate id "{row_id}" in {table}')
        seen.add(row_id)


class ExportService:
    """v0.4 export/import. Export is a pure read; import replaces the exported
    domain in one transaction — validation happens before any write so a bad
    bundle can never partially apply."""

    def __init__(self, ctx: WorkflowContext) -> None:
        self._ctx = ctx
        self.recompute_after_import: Callable[[], Awaitable[object]] = _noop

    async def export_state(self) -> ExportBundle:
        store = self._ctx.store
        all_settings = store.all_settings()
        settings = {key: all_settings[key] for key in EXPORTED_SETTING_KEYS if key in all_settings}
        return ExportBundle.model_validate(
            {
                "format": "interview-os.export",
                "version": 1,
                "appVersion": INTERVIEW_OS_VERSION,
                "exportedAt": self._ctx.iso(),
                "candidate": {
                    "profiles": [
                        row.model_dump(by_alias=True, mode="json")
                        for row in store.list_candidates()
                    ]
                },
                "targets": [
                    row.model_dump(by_alias=True, mode="json") for row in store.list_targets()
                ],
                "readiness": {
                    "snapshots": [
                        row.model_dump(by_alias=True, mode="json")
                        for row in store.list_all_readiness()
                    ]
                },
                "evidence": [
                    row.model_dump(by_alias=True, mode="json") for row in store.list_evidence()
                ],
                "interviews": {
                    "sessions": [_session_json(row) for row in store.list_sessions()],
                    "questions": [
                        row.model_dump(by_alias=True, mode="json")
                        for row in store.list_all_questions()
                    ],
                    "answers": [
                        row.model_dump(by_alias=True, mode="json")
                        for row in store.list_all_answers()
                    ],
                    "evaluations": [
                        row.model_dump(by_alias=True, mode="json")
                        for row in store.list_all_evaluations()
                    ],
                    "debriefs": [
                        row.model_dump(by_alias=True, mode="json")
                        for row in store.list_all_debriefs()
                    ],
                    "loops": [
                        row.model_dump(by_alias=True, mode="json") for row in store.list_loops()
                    ],
                },
                "preparation": {
                    "actions": [
                        row.model_dump(by_alias=True, mode="json") for row in store.list_actions()
                    ]
                },
                "stories": [
                    row.model_dump(by_alias=True, mode="json") for row in store.list_all_stories()
                ],
                "resumeReviews": [
                    row.model_dump(by_alias=True, mode="json")
                    for row in store.list_all_resume_reviews()
                ],
                # user/imported only — bundled packs ship with the repo
                "interviewPacks": [
                    row.model_dump(by_alias=True, mode="json")
                    for row in store.list_interview_packs()
                    if row.source in ("user", "imported")
                ],
                "questionBank": [
                    row.model_dump(by_alias=True, mode="json")
                    for row in store.list_user_questions()
                ],
                "settings": settings,
                "externalContexts": [
                    row.model_dump(by_alias=True, mode="json")
                    for row in store.list_external_contexts()
                ],
            }
        )

    async def export_state_part(self, part: str) -> object:
        if part not in EXPORT_PARTS:
            raise AppError("NOT_FOUND", f'no export part "{part}"')
        bundle = await self.export_state()
        return getattr(bundle, part)

    def _validate_bundle(self, raw: object) -> ExportBundle:
        """Everything that can reject a bundle before a single write happens."""

        try:
            bundle = ExportBundle.model_validate(raw)
        except ValidationError as err:
            issue = err.errors()[0]
            location = ".".join(str(bit) for bit in issue["loc"])
            raise AppError(
                "VALIDATION", f"invalid export bundle: {location} {issue['msg']}"
            ) from err

        _duplicate_id(bundle.candidate.profiles, "candidate.profiles")
        _duplicate_id(bundle.targets, "targets")
        _duplicate_id(bundle.evidence, "evidence")
        _duplicate_id(bundle.interviews.sessions, "interviews.sessions")
        _duplicate_id(bundle.interviews.questions, "interviews.questions")
        _duplicate_id(bundle.interviews.answers, "interviews.answers")
        _duplicate_id(bundle.interviews.evaluations, "interviews.evaluations")
        _duplicate_id(bundle.interviews.debriefs, "interviews.debriefs")
        _duplicate_id(bundle.interviews.loops, "interviews.loops")
        _duplicate_id(bundle.preparation.actions, "preparation.actions")
        _duplicate_id(bundle.stories, "stories")
        _duplicate_id(bundle.resume_reviews, "resumeReviews")
        _duplicate_id(bundle.interview_packs, "interviewPacks")
        _duplicate_id(bundle.question_bank, "questionBank")
        _duplicate_id(bundle.external_contexts, "externalContexts")
        snapshot_ids: set[int] = set()
        for snapshot in bundle.readiness.snapshots:
            if snapshot.id in snapshot_ids:
                raise AppError("VALIDATION", f"duplicate id {snapshot.id} in readiness.snapshots")
            snapshot_ids.add(snapshot.id)

        # referential integrity (the checks the spec requires)
        session_ids = {session.id for session in bundle.interviews.sessions}
        question_ids = {question.id for question in bundle.interviews.questions}
        answer_ids = {answer.id for answer in bundle.interviews.answers}
        profile_ids = {profile.id for profile in bundle.candidate.profiles}
        for question in bundle.interviews.questions:
            if question.session_id not in session_ids:
                raise AppError(
                    "VALIDATION",
                    f"question {question.id} references missing session {question.session_id}",
                )
        for answer in bundle.interviews.answers:
            if answer.question_id not in question_ids:
                raise AppError(
                    "VALIDATION",
                    f"answer {answer.id} references missing question {answer.question_id}",
                )
        for evaluation in bundle.interviews.evaluations:
            if evaluation.answer_id not in answer_ids:
                raise AppError(
                    "VALIDATION",
                    f"evaluation {evaluation.id} references missing answer {evaluation.answer_id}",
                )
        for evidence in bundle.evidence:
            if evidence.candidate_id is not None and evidence.candidate_id not in profile_ids:
                raise AppError(
                    "VALIDATION",
                    f"evidence {evidence.id} references missing candidate {evidence.candidate_id}",
                )
        return bundle

    async def import_state(self, raw: object, *, mode: str = _MODE) -> ImportCounts:
        if mode != _MODE:
            raise AppError("VALIDATION", f'unsupported import mode "{mode}"')
        bundle = self._validate_bundle(raw)

        counts: ImportCounts = {}
        with self._ctx.store.transaction() as tx:
            tx.wipe_export_tables()

            for row in bundle.candidate.profiles:
                tx.insert_candidate_row(row)
            counts["candidate.profiles"] = len(bundle.candidate.profiles)
            for target in bundle.targets:
                tx.insert_target_row(target)
            counts["targets"] = len(bundle.targets)
            for loop in bundle.interviews.loops:
                tx.insert_loop_row(loop)
            counts["interviews.loops"] = len(bundle.interviews.loops)
            for session in bundle.interviews.sessions:
                tx.insert_session_row(session)
            counts["interviews.sessions"] = len(bundle.interviews.sessions)
            for question in bundle.interviews.questions:
                tx.insert_question_row(question)
            counts["interviews.questions"] = len(bundle.interviews.questions)
            for answer in bundle.interviews.answers:
                tx.insert_answer_row(answer)
            counts["interviews.answers"] = len(bundle.interviews.answers)
            for evaluation in bundle.interviews.evaluations:
                tx.insert_evaluation_row(evaluation)
            counts["interviews.evaluations"] = len(bundle.interviews.evaluations)
            for debrief in bundle.interviews.debriefs:
                tx.insert_debrief_row(debrief)
            counts["interviews.debriefs"] = len(bundle.interviews.debriefs)
            for evidence in bundle.evidence:
                tx.insert_evidence_row(evidence)
            counts["evidence"] = len(bundle.evidence)
            for snapshot in bundle.readiness.snapshots:
                tx.append_readiness_snapshot_row(snapshot)
            counts["readiness.snapshots"] = len(bundle.readiness.snapshots)
            for action in bundle.preparation.actions:
                tx.insert_action_row(action)
            counts["preparation.actions"] = len(bundle.preparation.actions)
            for story in bundle.stories:
                tx.insert_story_row(story)
            counts["stories"] = len(bundle.stories)
            for review in bundle.resume_reviews:
                tx.insert_resume_review_row(review)
            counts["resumeReviews"] = len(bundle.resume_reviews)
            for pack in bundle.interview_packs:
                tx.insert_interview_pack_row(pack)
            counts["interviewPacks"] = len(bundle.interview_packs)
            for bank_item in bundle.question_bank:
                tx.insert_user_question_row(bank_item)
            counts["questionBank"] = len(bundle.question_bank)
            for context in bundle.external_contexts:
                tx.insert_external_context_row(context)
            counts["externalContexts"] = len(bundle.external_contexts)

            # allowlisted settings are replaced, others left untouched
            for key in EXPORTED_SETTING_KEYS:
                tx.set_setting(key, bundle.settings.get(key))
            counts["settings"] = sum(1 for key in bundle.settings if key in EXPORTED_SETTING_KEYS)

        # post-import: one readiness snapshot per recomputed skill, reason "import"
        await self.recompute_after_import()
        self._ctx.logger.info("import.completed", {"tables": len(counts)})
        return counts


async def _noop() -> object:
    return None


def _session_json(row: Any) -> dict[str, Any]:
    """Sessions export without the machine-local `pluginModeId` column."""

    data: dict[str, Any] = row.model_dump(by_alias=True, mode="json")
    data.pop("pluginModeId", None)
    return data
