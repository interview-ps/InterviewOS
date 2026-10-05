"""Core model round-trips, bundled-example validation and hook contract pairs.

Every representative payload is written with the JSON (camelCase) keys the API
returns, so a mismatch in the `alias_generator` setup fails here.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, get_args

import pytest
from pydantic import BaseModel, ValidationError

from interview_os import core
from interview_os.core import (
    PLUGIN_EVENT_HOOKS,
    PLUGIN_HOOK_NAMES,
    PLUGIN_HOOKS,
    is_plugin_hook_name,
)
from interview_os.core.models import (
    UI_TREE_LIMITS,
    AnswerEvaluation,
    AtsResult,
    CamelModel,
    CandidateProfile,
    CandidateSkill,
    CompanyPack,
    CompanyPackWithOverlays,
    CompanyProfile,
    ExportBundle,
    ExternalContext,
    InterviewOSState,
    InterviewPack,
    InterviewSession,
    Level,
    LoopDebrief,
    LoopRound,
    LooseCamelModel,
    McpConfig,
    PluginOutputExtensions,
    PrepResource,
    QuestionCandidate,
    ResumeReview,
    RolePack,
    SkillManifest,
    StrictCamelModel,
    TargetRole,
    VoiceFeedback,
    VoiceMetrics,
    plugin_evidence_proposals,
    validate_ui_tree,
)
from interview_os.core.skill_id import is_skill_id, parent_skill_id

ANSWER_EVALUATION: dict[str, Any] = {
    "summary": "Solid REST design answer with a clear idempotency story.",
    "dimensions": {
        "correctness": {"score": 0.8, "rationale": "Correct status codes and idempotent PUT."},
        "technicalDepth": {"score": 0.7, "rationale": "Mentions ETags but not conditional writes."},
        "reasoning": {"score": 0.75, "rationale": "Explains trade-offs between PUT and POST."},
        "structure": {"score": 0.9, "rationale": "Moves from contract to failure modes."},
        "communication": {"score": 0.85, "rationale": "Concise, names the resource model early."},
        "evidence": {"score": 0.6, "rationale": "One concrete example from Acme Payments."},
        "roleRelevance": {"score": 0.8, "rationale": "Maps to the JD's API ownership."},
    },
    "strengths": [{"skill": "apis.rest", "evidence": "Named idempotency keys for retries."}],
    "weaknesses": [
        {"skill": "sql.transactions", "severity": "medium", "evidence": "No isolation level named."}
    ],
    "scores": [{"skill": "apis.rest", "score": 0.9, "confidence": 0.7}],
    "missingConcepts": ["conditional requests"],
    "betterApproach": "Lead with the resource contract, then retries, then pagination.",
    "followUpTopics": ["pagination"],
    "star": None,
    "rubric": [{"id": "api-contract", "label": "API contract", "score": 0.8, "rationale": ""}],
    "designUpdates": None,
    "modeSignals": {"designUpdates": [{"dimension": "storage", "status": "partial"}]},
}

CANDIDATE: dict[str, Any] = {
    "id": "cand_00000000-0000-0000-0000-000000000001",
    "name": "Jordan Reyes",
    "headline": "Backend engineer who builds REST APIs and Python services.",
    "experience": [
        {
            "title": "Senior Backend Engineer",
            "company": "Acme Payments",
            "start": "2021-03",
            "end": None,
            "highlights": ["Designed Python REST APIs for payment processing"],
        }
    ],
    "skills": [
        {
            "skillId": "python",
            "level": 0.9,
            "source": "resume",
            "evidence": "owned Python services and a SQL datastore",
        },
        {
            "skillId": "apis.rest",
            "level": 0.9,
            "source": "resume",
            "evidence": "designed Python REST APIs",
        },
    ],
    "projects": [
        {"name": "LedgerSync", "description": "Reconciliation service", "technologies": ["Python"]}
    ],
    "achievements": ["Cut reconciliation time by 40%"],
    "education": [
        {"institution": "Ridgeview University", "degree": "BSc", "field": "CS", "end": "2015"}
    ],
    "starStories": [
        {
            "id": "story_1",
            "title": "Ledger migration",
            "situation": "Two ledgers disagreed nightly.",
            "task": "Own the migration.",
            "action": "Built a reconciler with idempotent writes.",
            "result": "Discrepancies dropped to zero.",
            "skillIds": ["sql.transactions"],
        }
    ],
}

TARGET: dict[str, Any] = {
    "id": "target_00000000-0000-0000-0000-000000000002",
    "company": "Northwind Cloud",
    "role": "Senior Backend Engineer",
    "level": "senior",
    "jobDescription": "Own the payments API and its data model.",
    "companyNotes": "Values written design docs.",
    "requirements": [
        {
            "skillId": "sql",
            "label": "SQL",
            "importance": 0.8,
            "baseImportance": 0.75,
            "kind": "required",
            "evidence": "owns a relational datastore",
            "boostedBy": "company-profile",
            "origin": "jd",
        }
    ],
    "preferredSkills": [
        {
            "skillId": "infrastructure.kubernetes",
            "label": "Kubernetes",
            "importance": 0.5,
            "kind": "preferred",
            "evidence": "nice to have",
        }
    ],
    "companyProfile": {
        "values": ["customer obsession"],
        "interviewStyle": "bar-raiser led",
        "focusSkillIds": ["sql"],
        "behavioralThemes": ["ownership"],
    },
    "companyProfileId": "generic",
    "rolePackId": "backend-engineer",
}

GAP: dict[str, Any] = {
    "skillId": "distributed-systems.caching",
    "label": "Caching",
    "importance": 0.9,
    "targetScore": 0.8,
    "currentScore": None,
    "gap": 0.8,
    "uncertainty": 1,
    "severity": "high",
    "reason": "no evidence for required skill; senior target is 0.8",
}

SKILL_READINESS: dict[str, Any] = {
    "skillId": "apis",
    "label": "APIs",
    "score": 0.9,
    "confidence": 0.194709,
    "evidenceIds": ["ev_00000000-0000-0000-0000-000000000003"],
    "children": ["apis.rest"],
    "status": "strong",
}

PREP_ACTION: dict[str, Any] = {
    "id": "act_00000000-0000-0000-0000-000000000004",
    "skillId": "distributed-systems.caching",
    "priority": 0.72,
    "reason": "high severity gap",
    "action": "Write a cache-aside design for the payments ledger.",
    "successCriteria": ["Name the invalidation strategy"],
    "status": "open",
    "createdAt": "2026-01-01T00:00:00.000Z",
    "sourceEvidenceIds": [],
}

QUESTION: dict[str, Any] = {
    "id": "q_00000000-0000-0000-0000-000000000005",
    "sessionId": "sess_00000000-0000-0000-0000-000000000006",
    "skillId": "sql.indexing",
    "topic": "Index selection",
    "text": "How would you choose an index for this query?",
    "subSkills": ["sql.query-optimization"],
    "expectedConcepts": [{"concept": "composite index", "skillId": "sql.indexing", "keywords": []}],
    "difficulty": "medium",
    "followUpOf": None,
    "createdAt": "2026-01-01T00:00:00.000Z",
}

ANSWER: dict[str, Any] = {
    "id": "ans_00000000-0000-0000-0000-000000000007",
    "questionId": QUESTION["id"],
    "sessionId": QUESTION["sessionId"],
    "text": "I would start from the selectivity of the filter columns.",
    "createdAt": "2026-01-01T00:00:00.000Z",
}

INTERVIEW_OS_STATE: dict[str, Any] = {
    "candidate": CANDIDATE,
    "target": TARGET,
    "assessment": {
        "strengths": [{"skillId": "apis", "note": "Clear contract thinking", "evidenceIds": []}],
        "gaps": [GAP],
        "weakAnswers": [],
        "strongAnswers": [],
        "observations": ["Prefers concrete examples"],
        "skillAssessments": {"apis": SKILL_READINESS},
    },
    "preparation": {
        "priorities": ["distributed-systems.caching"],
        "completedTopics": ["REST basics"],
        "nextActions": [PREP_ACTION],
        "practiceHistory": [
            {
                "id": "practice_1",
                "skillId": "sql",
                "actionId": PREP_ACTION["id"],
                "note": "Ran one practice question",
                "score": 0.7,
                "createdAt": "2026-01-01T00:00:00.000Z",
            }
        ],
    },
    "interview": {
        "sessionId": QUESTION["sessionId"],
        "currentRound": 1,
        "previousQuestions": [QUESTION],
        "previousAnswers": [ANSWER],
        "interviewerObservations": ["Asked for a concrete example"],
        "activeQuestion": QUESTION,
    },
    "readiness": {
        "overall": 0.62,
        "overallConfidence": 0.35,
        "dimensions": {"apis": SKILL_READINESS},
        "lastUpdated": "2026-01-01T00:00:00.000Z",
    },
}

EVIDENCE_ROW: dict[str, Any] = {
    "id": "ev_00000000-0000-0000-0000-000000000003",
    "candidateId": CANDIDATE["id"],
    "skillId": "apis.rest",
    "type": "interview_answer",
    "score": 0.9,
    "confidence": 0.124827,
    "observation": "Named idempotency keys for retries.",
    "sessionId": QUESTION["sessionId"],
    "questionId": QUESTION["id"],
    "source": "plugin:postgres-interviewer",
    "createdAt": "2026-01-01T00:00:00.000Z",
}

PREP_RESOURCE: dict[str, Any] = {
    "skillId": "sql.indexing",
    "title": "PostgreSQL documentation — Indexes",
    "url": "https://www.postgresql.org/docs/current/indexes.html",
    "summary": "B-tree basics and when a composite index wins.",
    "kind": "docs",
    "source": "builtin",
}

READINESS_SNAPSHOT: dict[str, Any] = {
    "overall": 0.62,
    "requirements": {"sql": 0.6, "apis.rest": 0.9, "distributed-systems.caching": None},
}

LOOP_ROUND: dict[str, Any] = {
    "mode": "technical",
    "label": "Technical screen",
    "plannedQuestions": 4,
    "sessionId": QUESTION["sessionId"],
    "status": "complete",
    "readinessBefore": READINESS_SNAPSHOT,
    "readinessAfter": {"overall": 0.66, "requirements": {"sql": 0.65}},
    "handoff": {
        "weakSkills": [
            {
                "skillId": "sql.transactions",
                "label": "SQL Transactions",
                "score": 0.4,
                "observation": "No isolation level named.",
            }
        ],
        "strongSkills": [{"skillId": "apis.rest", "label": "REST APIs", "score": 0.9}],
        "observations": ["Solid contract thinking."],
    },
    "skillDeltas": [{"skillId": "sql", "label": "SQL", "before": 0.6, "after": 0.65}],
}

LOOP_DEBRIEF: dict[str, Any] = {
    "summary": "Two rounds: strong API design, weak transaction reasoning.",
    "rounds": [
        {"mode": "technical", "label": "Technical screen", "signal": "mixed", "evidence": ["q1"]}
    ],
    "readinessChange": {"before": 0.58, "after": 0.66},
    "topActions": ["Rehearse transaction isolation trade-offs"],
}

VOICE_FEEDBACK: dict[str, Any] = {
    "signals": [
        {"id": "structure", "status": "ok", "message": "Answer reads as structured."},
        {"id": "filler", "status": "ok", "message": "Filler usage is within a normal range."},
        {"id": "pauses", "status": "watch", "message": "3 long pause(s), longest 9s."},
        {"id": "length", "status": "ok", "message": "Length is within a good range."},
        {"id": "conclusion", "status": "ok", "message": "Answer lands on a conclusion."},
        {"id": "clarity", "status": "ok", "message": "Sentences are easy to parse."},
    ],
    "wordCount": 184,
    "fillerCount": 3,
    "wordsPerMinute": 122.0,
    "disclaimer": core.VOICE_DISCLAIMER,
}

RESUME_REVIEW: dict[str, Any] = {
    "id": "review_00000000-0000-0000-0000-000000000008",
    "candidateId": CANDIDATE["id"],
    "targetId": TARGET["id"],
    "ats": {
        "score": 71,
        "checks": [
            {
                "id": "keywords",
                "label": "Required-skill keywords",
                "status": "warn",
                "detail": "5 of 8 required skills appear in the resume (63%).",
                "weight": 3,
            }
        ],
        "keywordCoverage": {
            "present": [{"skillId": "sql", "label": "SQL", "snippet": "SQL datastore"}],
            "missing": [{"skillId": "apis.rest", "label": "REST APIs"}],
        },
    },
    "suggestions": [
        {
            "original": "worked on APIs",
            "improved": "Designed 4 Python REST APIs",
            "rationale": "Lead with the verb and the count.",
            "skillIds": ["apis.rest"],
            "dropped": None,
        }
    ],
    "tailoring": {
        "summary": "Emphasise the payments domain.",
        "emphasize": ["idempotency"],
        "deEmphasize": ["internal tooling"],
        "alignment": [
            {
                "requirement": "SQL",
                "resumeEvidence": "owned Python services and a SQL datastore",
                "suggestion": "Add the schema size.",
            }
        ],
        "prepGaps": ["sql.transactions"],
    },
    "linkedGapSkillIds": ["sql.transactions"],
    "guard": {"substitutions": 1, "dropped": 0},
    "createdAt": "2026-01-01T00:00:00.000Z",
}

COMPANY_PROFILE: dict[str, Any] = {
    "id": "amazon",
    "name": "Amazon",
    "aliases": ["aws", "amazon web services"],
    "disclaimer": core.COMPANY_DISCLAIMER,
    "typicalLoop": [{"mode": "technical", "label": "Technical screen", "plannedQuestions": 4}],
    "emphasis": [{"skillId": "behavioral.ownership", "weight": 0.1}],
    "behavioralFramework": {
        "name": "Leadership Principles",
        "themes": ["customer obsession", "ownership"],
        "guidance": "Answer with STAR and a measurable result.",
    },
    "followUpDepth": 2,
    "rubricEmphasis": {"api-contract": 1.2},
    "roleExpectations": {"senior": ["owns a service end to end"]},
    "pack": {"version": "1.0.0", "kind": "company", "sourcedCount": 3, "communityCount": 1},
}

COMPANY_PACK: dict[str, Any] = {
    "format": "interview-os.company-pack",
    "id": "northwind",
    "name": "Northwind Cloud",
    "version": "1.0.0",
    "description": "Publicly reported loop for Northwind Cloud.",
    "maintainers": ["community"],
    "aliases": ["northwind"],
    "sources": [
        {
            "id": "engineering-blog",
            "title": "Northwind engineering blog",
            "url": "https://example.com/blog",
        }
    ],
    "stages": [
        {
            "mode": "technical",
            "label": "Technical screen",
            "plannedQuestions": 4,
            "provenance": "sourced",
            "source": "engineering-blog",
        },
        {
            "mode": "behavioral",
            "label": "Values interview",
            "plannedQuestions": 3,
            "provenance": "community",
        },
    ],
    "competencies": [
        {"text": "Owns a service end to end", "provenance": "sourced", "source": "engineering-blog"}
    ],
    "emphasis": [{"skillId": "apis.rest", "weight": 0.05}],
    "behavioralFramework": {"name": "Values", "themes": ["ownership"], "guidance": "Be concrete."},
    "followUpDepth": 3,
    "questionStyle": [],
    "evaluationGuidance": [],
    "roleExpectations": {"senior": ["leads design reviews"]},
    "questions": [
        {
            "skillId": "apis.rest",
            "text": "How would you version a public API without breaking clients?",
            "difficulty": "medium",
            "mode": "technical",
            "provenance": "community",
        }
    ],
    "overlays": [
        {
            "appliesTo": {"roleKeywords": ["payments"], "mode": "technical"},
            "competencies": [{"text": "Ledger experience", "provenance": "community"}],
            "questionStyle": [],
            "evaluationGuidance": [],
            "stages": None,
            "questions": [],
        }
    ],
}

ROLE_PACK: dict[str, Any] = {
    "format": "interview-os.role-pack",
    "id": "backend-engineer",
    "name": "Backend Engineer",
    "version": "1.0.0",
    "description": "Backend skills and rubrics.",
    "maintainers": [],
    "sources": [],
    "taxonomy": [{"id": "apis.rest", "label": "REST APIs", "keywords": ["rest"]}],
    "dimensions": [{"skillId": "apis.rest", "weight": 0.4}],
    "defaultQuestionCategories": ["technical", "behavioral"],
    "rubrics": [
        {"skillId": "apis.rest", "criteria": ["names the resource model", "handles retries"]},
        {"mode": "system_design", "criteria": ["estimates capacity"]},
    ],
    "resources": [
        {
            "skillId": "sql.indexing",
            "title": "PostgreSQL documentation — Indexes",
            "url": "https://www.postgresql.org/docs/current/indexes.html",
            "summary": "B-tree basics and when a composite index wins.",
            "kind": "docs",
        }
    ],
    "questions": [],
}

INTERVIEW_PACK: dict[str, Any] = {
    "format": "interview-os.interview-pack",
    "id": "payments-loop",
    "name": "Payments loop",
    "version": "1.0.0",
    "description": "A 90-minute payments-focused loop.",
    "author": "Jordan",
    "skills": ["apis.rest", "sql.transactions"],
    "rounds": [
        {"mode": "technical", "label": "Technical", "plannedQuestions": 4},
        {"mode": "behavioral", "label": "Behavioral", "plannedQuestions": 3},
    ],
    "durationMinutes": 90,
}

QUESTION_CANDIDATE: dict[str, Any] = {
    "skillId": "sql.indexing",
    "text": "How would you choose an index for this query?",
    "difficulty": "medium",
    "expectedConcepts": ["composite index"],
    "mode": "technical",
    "source": {"kind": "company_pack", "id": "northwind", "provenance": "community"},
}

SKILL_MANIFEST: dict[str, Any] = {
    "id": "postgres-interviewer",
    "version": "1.2.0",
    "kind": "plugin",
    "description": "Postgres-flavoured technical questions.",
    "inputs": [{"key": "candidate", "permission": "candidate.read"}],
    "outputs": ["questions"],
    "permissions": ["candidate.read", "evidence.write"],
    "name": "Postgres interviewer",
    "author": "community",
    "capabilities": ["question_source", "checklist", "interview_mode"],
    "engines": {"interview-os": "^0.4.0", "plugin-api": ">=1.1.0"},
    "hooks": ["questions.suggest"],
    "events": ["answerEvaluated"],
    "appliesTo": {"skillPrefixes": ["sql"]},
    "settings": [
        {
            "key": "difficulty",
            "label": "Difficulty",
            "type": "enum",
            "options": ["easy", "medium", "hard"],
            "default": "medium",
            "description": "Question difficulty",
        }
    ],
    "ui": {
        "navigation": [{"label": "Postgres", "icon": "database", "page": "/postgres"}],
        "commands": [
            {
                "id": "run-check",
                "label": "Run check",
                "action": {"type": "navigate", "to": "/skills"},
            }
        ],
        "slots": {
            "interview.question": [
                {"component": "hint", "kind": "declarative", "title": "Postgres hint"}
            ]
        },
        "pages": [
            {
                "path": "/postgres",
                "title": "Postgres",
                "kind": "frame",
                "component": "main",
                "entry": "index.js",
            }
        ],
    },
    "interviewModes": [
        {
            "id": "postgres-deep-dive",
            "label": "Postgres deep dive",
            "description": "Index and transaction probes.",
            "roundType": "technical",
            "focusSkills": ["sql.indexing"],
            "plannedQuestions": 4,
            "guidance": "Probe index selection first.",
        }
    ],
    "modes": [
        {
            "id": "postgres_mode",
            "label": "Postgres mode",
            "description": "Mode state tracks covered index types.",
            "scope": {"include": ["sql"], "exclude": ["sql.transactions"]},
            "fallbackSkills": ["sql.indexing"],
            "rubric": [{"id": "indexing", "label": "Indexing", "description": "Picks an index."}],
            "answerFormat": "text",
            "answerFields": [],
            "initialState": {"covered": []},
            "reduce": {"copyExtra": ["indexTypes"], "set": {"covered": True}},
            "context": {"companyThemes": True, "storyTitles": False},
            "followUp": "rules",
            "followUpRules": [{"rubricId": "indexing", "below": 0.6, "focus": "index choice"}],
            "interviewerPrompt": "prompts/interviewer.md",
            "evaluatorPrompt": "prompts/evaluator.md",
        }
    ],
    "taxonomy": [{"id": "sql.indexing", "label": "SQL Indexing", "keywords": ["index"]}],
}

MCP_CONFIG: dict[str, Any] = {
    "servers": [
        {
            "id": "fake",
            "name": "Fake MCP",
            "description": "Test server",
            "command": "node",
            "args": ["tests/fixtures/fake-mcp-server.mjs"],
            "envPassthrough": ["GITHUB_TOKEN"],
        }
    ]
}

EXTERNAL_CONTEXT: dict[str, Any] = {
    "id": "ctx_00000000-0000-0000-0000-000000000009",
    "serverId": "fake",
    "tool": "search",
    "title": "Company engineering blog",
    "text": "Public interview notes.",
    "createdAt": "2026-01-01T00:00:00.000Z",
}

PLUGIN_OUTPUT_EXTENSIONS: dict[str, Any] = {
    "evidenceProposals": [
        {
            "skillId": "sql.indexing",
            "score": 0.7,
            "confidence": 0.5,
            "observation": "Explained composite index ordering.",
        }
    ]
}

UI_TREE: dict[str, Any] = {
    "type": "stack",
    "gap": "md",
    "children": [
        {"type": "heading", "text": "Readiness", "level": 2},
        {"type": "text", "text": "Evidence-backed", "tone": "muted"},
        {"type": "row", "children": [{"type": "badge", "text": "senior", "tone": "blue"}]},
        {"type": "stat", "label": "Overall", "value": "0.62", "trend": "up", "tone": "green"},
        {"type": "skillScore", "skillId": "sql", "label": "SQL", "score": 0.6, "confidence": 0.4},
        {"type": "progressList", "items": [{"label": "APIs", "value": 0.9, "tone": "green"}]},
        {"type": "list", "items": [{"text": "Owns a service end to end", "tone": "amber"}]},
        {
            "type": "evidenceList",
            "items": [
                {
                    "skillId": "apis.rest",
                    "observation": "Named idempotency keys.",
                    "score": 0.9,
                    "createdAt": "2026-01-01T00:00:00.000Z",
                }
            ],
        },
        {"type": "readinessChart", "points": [0.4, 0.55, 0.62], "label": "Last 3 sessions"},
        {"type": "tabs", "tabs": [{"label": "Gaps", "children": [{"type": "divider"}]}]},
        {"type": "emptyState", "title": "No interviews yet", "description": "Start one."},
        {
            "type": "card",
            "title": "Actions",
            "subtitle": "Top 3",
            "children": [{"type": "divider"}],
        },
        {
            "type": "button",
            "label": "Start practice",
            "variant": "primary",
            "action": {"type": "startPractice", "skillId": "sql"},
        },
    ],
}

EXPORT_BUNDLE: dict[str, Any] = {
    "format": "interview-os.export",
    "version": 1,
    "appVersion": "0.4.0",
    "exportedAt": "2026-01-01T00:00:00.000Z",
    "candidate": {
        "profiles": [
            {
                "id": CANDIDATE["id"],
                "active": 1,
                "name": "Jordan Reyes",
                "headline": CANDIDATE["headline"],
                "resumeText": "resume text",
                "data": CANDIDATE,
                "createdAt": "2026-01-01T00:00:00.000Z",
            }
        ]
    },
    "targets": [
        {
            "id": TARGET["id"],
            "active": 1,
            "company": TARGET["company"],
            "role": TARGET["role"],
            "level": TARGET["level"],
            "jobDescription": TARGET["jobDescription"],
            "data": TARGET,
            "createdAt": "2026-01-01T00:00:00.000Z",
        }
    ],
    "readiness": {
        "snapshots": [
            {
                "id": 1,
                "skillId": "sql",
                "score": 0.6,
                "confidence": 0.4,
                "evidenceIds": [EVIDENCE_ROW["id"]],
                "reason": "1 evidence row",
                "computedAt": "2026-01-01T00:00:00.000Z",
            }
        ]
    },
    "evidence": [EVIDENCE_ROW],
    "interviews": {
        "sessions": [
            {
                "id": QUESTION["sessionId"],
                "candidateId": CANDIDATE["id"],
                "targetId": TARGET["id"],
                "status": "question",
                "currentRound": 0,
                "plannedQuestions": 4,
                "mode": "interview",
                "roundType": "technical",
                "focusSkillId": None,
                "actionId": None,
                "modeState": {},
                "loopId": None,
                "loopRound": None,
                "contextId": None,
                "createdAt": "2026-01-01T00:00:00.000Z",
                "completedAt": None,
            }
        ],
        "questions": [
            {
                "id": QUESTION["id"],
                "sessionId": QUESTION["sessionId"],
                "skillId": QUESTION["skillId"],
                "topic": QUESTION["topic"],
                "text": QUESTION["text"],
                "subSkills": QUESTION["subSkills"],
                "expectedConcepts": QUESTION["expectedConcepts"],
                "difficulty": "medium",
                "selectionPriority": 0.7,
                "selectionReason": "high severity gap",
                "selectionFactors": {"gap": 0.8},
                "followUpOf": None,
                "followUpFocus": None,
                "extra": {},
                "position": 0,
                "createdAt": "2026-01-01T00:00:00.000Z",
            }
        ],
        "answers": [
            {
                "id": ANSWER["id"],
                "questionId": ANSWER["questionId"],
                "sessionId": ANSWER["sessionId"],
                "text": ANSWER["text"],
                "code": None,
                "language": None,
                "voice": None,
                "status": "evaluated",
                "createdAt": "2026-01-01T00:00:00.000Z",
            }
        ],
        "evaluations": [
            {
                "id": "eval_1",
                "answerId": ANSWER["id"],
                "questionId": QUESTION["id"],
                "sessionId": QUESTION["sessionId"],
                "data": ANSWER_EVALUATION,
                "readinessDelta": [{"skillId": "sql", "before": 0.6, "after": 0.65}],
                "createdAt": "2026-01-01T00:00:00.000Z",
            }
        ],
        "debriefs": [
            {
                "id": "debrief_1",
                "sessionId": QUESTION["sessionId"],
                "data": {"summary": "Strong API design."},
                "createdAt": "2026-01-01T00:00:00.000Z",
            }
        ],
        "loops": [
            {
                "id": "loop_1",
                "targetId": TARGET["id"],
                "companyProfileId": "generic",
                "rounds": [LOOP_ROUND],
                "status": "complete",
                "packId": None,
                "focusSkills": [],
                "currentRound": 1,
                "abandoned": 0,
                "debrief": LOOP_DEBRIEF,
                "createdAt": "2026-01-01T00:00:00.000Z",
                "completedAt": None,
            }
        ],
    },
    "preparation": {
        "actions": [
            {
                "id": PREP_ACTION["id"],
                "skillId": PREP_ACTION["skillId"],
                "targetId": TARGET["id"],
                "priority": PREP_ACTION["priority"],
                "reason": PREP_ACTION["reason"],
                "action": PREP_ACTION["action"],
                "successCriteria": PREP_ACTION["successCriteria"],
                "status": "open",
                "severity": "high",
                "createdAt": PREP_ACTION["createdAt"],
                "sourceEvidenceIds": [],
                "resources": [],
            }
        ]
    },
    "stories": [
        {
            "id": "story_1",
            "candidateId": CANDIDATE["id"],
            "title": "Ledger migration",
            "situation": "Two ledgers disagreed nightly.",
            "task": "Own the migration.",
            "action": "Built a reconciler.",
            "result": "Zero discrepancies.",
            "skillIds": ["sql.transactions"],
            "source": "resume",
            "updatedAt": "2026-01-01T00:00:00.000Z",
        }
    ],
    "resumeReviews": [
        {
            "id": RESUME_REVIEW["id"],
            "candidateId": RESUME_REVIEW["candidateId"],
            "targetId": RESUME_REVIEW["targetId"],
            "ats": RESUME_REVIEW["ats"],
            "suggestions": RESUME_REVIEW["suggestions"],
            "tailoring": RESUME_REVIEW["tailoring"],
            "linkedGapSkillIds": RESUME_REVIEW["linkedGapSkillIds"],
            "guard": RESUME_REVIEW["guard"],
            "createdAt": RESUME_REVIEW["createdAt"],
        }
    ],
    "interviewPacks": [
        {
            "id": INTERVIEW_PACK["id"],
            "data": INTERVIEW_PACK,
            "source": "user",
            "createdAt": "2026-01-01T00:00:00.000Z",
            "updatedAt": "2026-01-01T00:00:00.000Z",
        }
    ],
    "questionBank": [
        {
            "id": "uq_1",
            "skillId": "sql",
            "text": "Explain MVCC.",
            "difficulty": "hard",
            "mode": "technical",
            "createdAt": "2026-01-01T00:00:00.000Z",
        }
    ],
    "settings": {"model": "gpt-5", "voice": "on"},
    "externalContexts": [EXTERNAL_CONTEXT],
}

HOOK_SAMPLES: dict[str, tuple[dict[str, Any], dict[str, Any]]] = {
    "questions.suggest": (
        {"skillId": "sql.indexing", "roundType": "technical", "level": "senior", "count": 5},
        {"questions": [QUESTION_CANDIDATE], "extra": "ignored"},
    ),
    "resources.suggest": (
        {"skillIds": ["sql.indexing"]},
        {
            "resources": [
                {
                    "title": "Use The Index, Luke",
                    "url": "https://use-the-index-luke.com/",
                    "kind": "article",
                    "skillId": "sql.indexing",
                    "source": "plugin:postgres-interviewer",
                }
            ]
        },
    ),
    "ui.render": (
        {"slot": "readiness.panels", "component": "panel", "params": {"skillId": "sql"}},
        {"ui": UI_TREE},
    ),
    "ui.frameRun": (
        {"component": "main", "page": "/postgres", "request": {"op": "list"}},
        {"output": {"rows": 3}, "ui": UI_TREE},
    ),
    "evaluation.review": (
        {
            "question": {
                "skillId": "apis.rest",
                "text": "How would you version a public API?",
                "roundType": "technical",
                "expectedConcepts": ["versioning"],
            },
            "answer": {
                "text": "I would use URI versioning.",
                "code": None,
                "language": None,
                "fields": None,
            },
            "evaluation": ANSWER_EVALUATION,
        },
        {
            "observations": [{"text": "Mentions deprecation windows.", "tone": "green"}],
            "evidenceProposals": PLUGIN_OUTPUT_EXTENSIONS["evidenceProposals"],
        },
    ),
    "preparation.suggest": (
        {"gaps": [GAP], "skillIds": ["sql.transactions"]},
        {
            "activities": [
                {
                    "skillId": "sql.transactions",
                    "title": "Isolation levels",
                    "action": "Write down the four levels and one anomaly each.",
                    "successCriteria": ["Names the anomaly"],
                }
            ]
        },
    ),
    "mode.reduce": (
        {
            "modeId": "postgres_mode",
            "state": {"covered": []},
            "evaluation": ANSWER_EVALUATION,
            "question": {
                "skillId": "sql.indexing",
                "topic": "Indexing",
                "extra": {"indexTypes": 2},
            },
        },
        {"state": {"covered": ["btree"]}},
    ),
    "mode.followUp": (
        {
            "modeId": "postgres_mode",
            "evaluation": ANSWER_EVALUATION,
            "state": {},
            "depth": 0,
            "maxDepth": 2,
        },
        {"ask": True, "focus": "index choice", "reason": "indexing scored 0.60"},
    ),
    "mode.mock": (
        {"modeId": "postgres_mode", "task": "interviewer", "input": {"skillId": "sql.indexing"}},
        {"output": {"question": "How would you index this?"}},
    ),
    "mode.prepareTurn": (
        {"modeId": "postgres_mode", "state": {}, "followUp": False},
        {"turn": {"focusDimension": "indexing"}},
    ),
    "events.sessionCompleted": (
        {
            "sessionId": QUESTION["sessionId"],
            "roundType": "technical",
            "scores": {"sql": {"meanScore": 0.7, "answers": 2}},
        },
        {},
    ),
    "events.readinessUpdated": (
        {"changedSkillIds": ["sql", "apis.rest"]},
        {"evidenceProposals": PLUGIN_OUTPUT_EXTENSIONS["evidenceProposals"]},
    ),
    "events.answerEvaluated": (
        {
            "sessionId": QUESTION["sessionId"],
            "questionId": QUESTION["id"],
            "skillId": "sql.indexing",
            "roundType": "technical",
            "rubric": [{"id": "indexing", "score": 0.6}],
            "scores": [{"skill": "sql.indexing", "score": 0.65}],
        },
        {},
    ),
    "events.loopCompleted": (
        {"loopId": "loop_1", "rounds": [{"mode": "technical", "sessionId": None}]},
        {},
    ),
    "events.targetChanged": (
        {"targetId": TARGET["id"], "role": TARGET["role"], "company": TARGET["company"]},
        {},
    ),
}

SAMPLES: dict[str, tuple[type[BaseModel], dict[str, Any]]] = {
    "InterviewOSState": (InterviewOSState, INTERVIEW_OS_STATE),
    "CandidateProfile": (CandidateProfile, CANDIDATE),
    "TargetRole": (TargetRole, TARGET),
    "AnswerEvaluation": (AnswerEvaluation, ANSWER_EVALUATION),
    "ResumeReview": (ResumeReview, RESUME_REVIEW),
    "CompanyProfile": (CompanyProfile, COMPANY_PROFILE),
    "CompanyPack": (
        CompanyPack,
        {key: value for key, value in COMPANY_PACK.items() if key != "overlays"},
    ),
    "CompanyPackWithOverlays": (CompanyPackWithOverlays, COMPANY_PACK),
    "RolePack": (RolePack, ROLE_PACK),
    "InterviewPack": (InterviewPack, INTERVIEW_PACK),
    "QuestionCandidate": (QuestionCandidate, QUESTION_CANDIDATE),
    "SkillManifest": (SkillManifest, SKILL_MANIFEST),
    "McpConfig": (McpConfig, MCP_CONFIG),
    "ExternalContext": (ExternalContext, EXTERNAL_CONTEXT),
    "PluginOutputExtensions": (PluginOutputExtensions, PLUGIN_OUTPUT_EXTENSIONS),
    "ExportBundle": (ExportBundle, EXPORT_BUNDLE),
    "InterviewSession": (InterviewSession, {"id": "sess_1", "plannedQuestions": 4}),
    "LoopRound": (LoopRound, LOOP_ROUND),
    "LoopDebrief": (LoopDebrief, LOOP_DEBRIEF),
    "VoiceFeedback": (VoiceFeedback, VOICE_FEEDBACK),
    "VoiceMetrics": (
        VoiceMetrics,
        {"durationSec": 92.5, "longPauseCount": 3, "longestPauseSec": 9},
    ),
    "PrepResource": (PrepResource, PREP_RESOURCE),
}

BEHAVIOUR_SAMPLES: dict[str, tuple[type[BaseModel], dict[str, Any]]] = {
    "EvidenceRow": (core.models.Evidence, EVIDENCE_ROW),
}


@pytest.mark.parametrize("name", sorted(SAMPLES))
def test_sample_round_trips_by_alias(name: str) -> None:
    model, payload = SAMPLES[name]
    parsed = model.model_validate(payload)
    dumped = parsed.model_dump(mode="json", by_alias=True)
    for key in payload:
        assert key in dumped, f"{name} dropped {key}"
    # Defaults materialize on the first dump; from then on it is byte-stable.
    assert model.model_validate(dumped).model_dump(mode="json", by_alias=True) == dumped


def test_defaults_materialize_but_do_not_drop_input() -> None:
    requirement = TARGET["preferredSkills"][0]
    dumped = TargetRole.model_validate(TARGET).model_dump(mode="json", by_alias=True)
    assert dumped["preferredSkills"][0] == {
        **requirement,
        "baseImportance": None,
        "boostedBy": None,
        "origin": None,
    }


def test_capability_transform_normalizes_checklist() -> None:
    manifest = SkillManifest.model_validate(SKILL_MANIFEST)
    assert manifest.capabilities == [
        core.models.PluginCapability.QUESTION_SOURCE,
        core.models.PluginCapability.PREPARATION,
        core.models.PluginCapability.INTERVIEW_MODE,
    ]


def test_state_uses_camel_case_aliases() -> None:
    state = InterviewOSState.model_validate(INTERVIEW_OS_STATE)
    dumped = state.model_dump(mode="json", by_alias=True)
    assert set(dumped) == set(INTERVIEW_OS_STATE)
    assert "starStories" in dumped["candidate"]
    assert "overallConfidence" in dumped["readiness"]
    assert "jobDescription" in dumped["target"]
    assert "skillAssessments" in dumped["assessment"]
    assert "sourceEvidenceIds" in dumped["preparation"]["nextActions"][0]
    assert "plannedQuestions" in InterviewSession(id="s", planned_questions=4).model_dump(
        by_alias=True
    )


def test_snake_case_input_is_accepted() -> None:
    profile = CandidateProfile(id="cand_1", star_stories=[])
    assert profile.model_dump(by_alias=True)["starStories"] == []


def test_unknown_keys_are_stripped_like_zod() -> None:
    parsed = CandidateProfile.model_validate({"id": "cand_1", "surprise": True})
    assert "surprise" not in parsed.model_dump()


def test_candidate_skills_dedupe_keeps_first_claim() -> None:
    profile = CandidateProfile.model_validate(
        {
            "id": "cand_1",
            "skills": [
                {"skillId": "python", "level": 0.9, "source": "resume", "evidence": "first"},
                {"skillId": "python", "level": 0.4, "source": "resume", "evidence": "duplicate"},
                {"skillId": "apis.rest", "level": 0.9, "source": "resume", "evidence": "second"},
            ],
        }
    )
    assert [skill.skill_id for skill in profile.skills] == ["python", "apis.rest"]
    assert profile.skills[0].level == 0.9


def test_bundled_example_parses_into_candidate_and_target(examples_dir: Path) -> None:
    directory = examples_dir / "backend-engineer"
    meta = json.loads((directory / "meta.json").read_text(encoding="utf-8"))
    resume_lines = (directory / "resume.md").read_text(encoding="utf-8").splitlines()
    job_description = (directory / "job.md").read_text(encoding="utf-8")

    name = resume_lines[0].lstrip("# ").strip()
    headline = next(line.strip() for line in resume_lines[1:] if line.strip())
    candidate = CandidateProfile(
        id="cand_example",
        name=name,
        headline=headline,
        skills=[
            CandidateSkill(
                skill_id="python",
                level=0.9,
                source="resume",
                evidence="built REST APIs and Python services",
            ),
            CandidateSkill(
                skill_id="apis.rest",
                level=0.85,
                source="resume",
                evidence="designed Python REST APIs",
            ),
        ],
    )
    target = TargetRole(
        id="target_example",
        company=meta["company"],
        role=meta["role"],
        level=meta["level"],
        job_description=job_description,
    )

    assert candidate.name == "Jordan Reyes"
    assert candidate.headline is not None
    assert candidate.headline.startswith("Backend engineer")
    assert target.level is Level.SENIOR
    assert target.company == "Northwind Cloud"
    assert target.job_description.strip()


def test_evidence_row_shape() -> None:
    evidence = core.models.Evidence.model_validate(EVIDENCE_ROW)
    assert evidence.type is core.models.EvidenceType.INTERVIEW_ANSWER
    assert evidence.session_id == QUESTION["sessionId"]
    assert evidence.created_at == "2026-01-01T00:00:00.000Z"


def test_readiness_snapshot_shape() -> None:
    snapshot = core.models.ReadinessSnapshot.model_validate(READINESS_SNAPSHOT)
    assert snapshot.overall == 0.62
    assert snapshot.requirements["distributed-systems.caching"] is None
    graph = core.models.ReadinessGraph.model_validate(INTERVIEW_OS_STATE["readiness"])
    assert graph.dimensions["apis"].children == ["apis.rest"]


@pytest.mark.parametrize("hook", PLUGIN_HOOK_NAMES)
def test_plugin_hook_request_and_response(hook: str) -> None:
    request_payload, response_payload = HOOK_SAMPLES[hook]
    spec = PLUGIN_HOOKS[hook]
    request = spec.request.model_validate(request_payload)
    response = spec.response.model_validate(response_payload)
    assert request.model_validate(request.model_dump(mode="json", by_alias=True)) == request
    assert response.model_validate(response.model_dump(mode="json", by_alias=True)) == response


def test_hook_registry_shape() -> None:
    assert len(PLUGIN_HOOK_NAMES) == 15
    assert set(PLUGIN_HOOK_NAMES) == set(HOOK_SAMPLES)
    assert is_plugin_hook_name("mode.reduce")
    assert not is_plugin_hook_name("mode.unknown")
    events = [name for name in PLUGIN_HOOK_NAMES if name.startswith("events.")]
    assert events == list(PLUGIN_EVENT_HOOKS)
    for name, spec in PLUGIN_HOOKS.items():
        assert spec.since in ("1.0.0", "1.1.0"), name
        assert spec.description, name
        if name.startswith("events."):
            assert spec.capability is None
        else:
            assert spec.capability is not None


def test_loose_hook_responses_keep_extra_keys() -> None:
    parsed = PLUGIN_HOOKS["questions.suggest"].response.model_validate(
        {"questions": [QUESTION_CANDIDATE], "extra": "kept"}
    )
    assert parsed.model_dump()["extra"] == "kept"
    assert issubclass(PLUGIN_HOOKS["questions.suggest"].response, LooseCamelModel)


def test_skill_id_helpers() -> None:
    assert is_skill_id("sql.indexing")
    assert not is_skill_id("SQL Indexing")
    assert parent_skill_id("sql.indexing") == "sql"
    assert parent_skill_id("sql") is None


def test_plugin_evidence_proposals_parses_extensions() -> None:
    proposals = plugin_evidence_proposals(PLUGIN_OUTPUT_EXTENSIONS)
    assert proposals is not None and proposals[0].confidence == 0.5
    assert plugin_evidence_proposals({}) == []
    assert plugin_evidence_proposals("not an object") == []
    assert plugin_evidence_proposals({"evidenceProposals": [{"skillId": "sql"}]}) is None


def test_ui_tree_validates_and_bounds() -> None:
    parsed = validate_ui_tree(UI_TREE)
    assert parsed.type == "stack"
    assert len(parsed.children) == 13

    with pytest.raises(ValidationError):
        validate_ui_tree({"type": "nope"})
    with pytest.raises(ValueError):
        validate_ui_tree({"type": "text", "text": "hi", "surprise": True})
    with pytest.raises(ValueError):
        validate_ui_tree(
            {
                "type": "button",
                "label": "Go",
                "action": {"type": "navigate", "to": "/etc/passwd"},
            }
        )
    with pytest.raises(ValueError):
        validate_ui_tree(
            {
                "type": "button",
                "label": "Go",
                "action": {
                    "type": "runPlugin",
                    "request": {"blob": "x" * UI_TREE_LIMITS["maxRunPluginRequestBytes"]},
                },
            }
        )


def test_ui_tree_allows_plugin_owned_routes() -> None:
    tree = {
        "type": "button",
        "label": "Open",
        "action": {"type": "openPluginPage", "path": "/details"},
    }
    assert validate_ui_tree(tree, plugin_id="postgres-interviewer")


def test_mode_id_rules() -> None:
    with pytest.raises(ValidationError):
        LoopRound.model_validate(LOOP_ROUND | {"mode": "mixed"})
    with pytest.raises(ValidationError):
        LoopRound.model_validate(LOOP_ROUND | {"mode": "Technical"})
    assert LoopRound.model_validate(LOOP_ROUND | {"mode": "system_design"}).mode == "system_design"


def test_answer_fields_require_choice_options() -> None:
    manifest = dict(SKILL_MANIFEST)
    modes = [dict(manifest["modes"][0])]
    modes[0]["answerFormat"] = "fields"
    modes[0]["answerFields"] = [{"key": "approach", "label": "Approach", "type": "choice"}]
    manifest["modes"] = modes
    with pytest.raises(ValidationError):
        SkillManifest.model_validate(manifest)


def test_manifest_requires_interview_mode_capability() -> None:
    manifest = dict(SKILL_MANIFEST)
    manifest["capabilities"] = ["question_source"]
    with pytest.raises(ValidationError):
        SkillManifest.model_validate(manifest)


def test_manifest_rejects_escaping_prompt_paths() -> None:
    manifest = dict(SKILL_MANIFEST)
    modes = [dict(manifest["modes"][0])]
    modes[0]["interviewerPrompt"] = "../secrets.md"
    manifest["modes"] = modes
    with pytest.raises(ValidationError):
        SkillManifest.model_validate(manifest)


def test_pack_sourced_items_need_a_declared_source() -> None:
    pack = dict(COMPANY_PACK)
    pack["sources"] = []
    with pytest.raises(ValidationError):
        CompanyPackWithOverlays.model_validate(pack)


def test_pack_version_must_be_semver() -> None:
    with pytest.raises(ValidationError):
        RolePack.model_validate(ROLE_PACK | {"version": "v1"})


def test_resume_review_guard_defaults() -> None:
    without_guard = {key: value for key, value in RESUME_REVIEW.items() if key != "guard"}
    review = ResumeReview.model_validate(without_guard)
    assert review.guard.substitutions == 0
    assert review.guard.dropped == 0


def test_ats_result_score_bounds() -> None:
    with pytest.raises(ValidationError):
        AtsResult.model_validate(RESUME_REVIEW["ats"] | {"score": 101})


def test_strict_models_reject_unknown_keys() -> None:
    assert issubclass(core.models.UINodeButton, StrictCamelModel)
    with pytest.raises(ValidationError):
        core.models.UINodeButton.model_validate(
            {
                "type": "button",
                "label": "Start",
                "action": {"type": "navigate", "to": "/readiness"},
                "surprise": 1,
            }
        )


def _referenced_models(model: type[BaseModel]) -> set[type[BaseModel]]:
    found: set[type[BaseModel]] = set()
    for field in model.model_fields.values():
        found |= _models_in(field.annotation)
    return found


def _models_in(annotation: Any) -> set[type[BaseModel]]:
    if isinstance(annotation, type):
        return {annotation} if issubclass(annotation, BaseModel) else set()
    found: set[type[BaseModel]] = set()
    for argument in get_args(annotation):
        found |= _models_in(argument)
    return found


def test_every_core_model_is_exercised_by_a_sample() -> None:
    sampled: set[type[BaseModel]] = {model for model, _ in SAMPLES.values()}
    sampled |= {model for model, _ in BEHAVIOUR_SAMPLES.values()}
    for spec in PLUGIN_HOOKS.values():
        sampled |= {spec.request, spec.response}

    covered: set[type[BaseModel]] = set()
    pending = list(sampled)
    while pending:
        model = pending.pop()
        for referenced in _referenced_models(model):
            if referenced not in covered and referenced not in sampled:
                covered.add(referenced)
                pending.append(referenced)

    exported = {
        model
        for model in vars(core.models).values()
        if isinstance(model, type)
        and issubclass(model, BaseModel)
        and model.__module__.startswith("interview_os.core.models")
    }
    bases = {CamelModel, LooseCamelModel, StrictCamelModel}
    missing = sorted(model.__name__ for model in exported - sampled - covered - bases)
    assert not missing, f"core models with no sample or reachable parent: {missing}"


def test_store_row_models_are_covered_by_the_export_bundle() -> None:
    from interview_os.store import store as store_module

    rows = [
        store_module.CandidateRow,
        store_module.TargetRow,
        store_module.SessionRow,
        store_module.QuestionRow,
        store_module.AnswerRow,
        store_module.EvaluationRow,
        store_module.EvidenceRow,
        store_module.ReadinessRow,
        store_module.PrepActionRow,
    ]
    assert all(issubclass(row, CamelModel) for row in rows)
    dumped = store_module.ReadinessRow(
        id=1,
        skill_id="sql",
        score=0.6,
        confidence=0.4,
        evidence_ids=["ev_1"],
        reason="1 evidence row",
        computed_at="2026-01-01T00:00:00.000Z",
    ).model_dump(mode="json", by_alias=True)
    assert dumped["evidenceIds"] == ["ev_1"]
    assert dumped["computedAt"] == "2026-01-01T00:00:00.000Z"
