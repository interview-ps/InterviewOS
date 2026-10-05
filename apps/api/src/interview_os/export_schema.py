"""Write `openapi.json` and one JSON Schema file per core model group.

`uv run python -m interview_os.export_schema` regenerates `apps/api/openapi.json`
(the FastAPI document) and `apps/api/schema/<group>.json` (Pydantic
`model_json_schema()` for every model defined in that core module). Output is
byte-identical between runs, so a CI check can regenerate and `git diff`.

There is deliberately no TypeScript generator yet: `apps/web` and
`packages/core` are only migrated at cut-over (design §5, phases 6/8).
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from types import ModuleType
from typing import Any

from pydantic import BaseModel

from . import core
from .main import create_app
from .store.schema import TABLE_NAMES

__all__ = ["API_DIR", "SCHEMA_DIR", "build_schemas", "main", "write_schemas"]

API_DIR = Path(__file__).resolve().parents[2]
SCHEMA_DIR = API_DIR / "schema"
OPENAPI_PATH = API_DIR / "openapi.json"

_MODEL_GROUPS: dict[str, ModuleType] = {
    "shared": core.models.shared,
    "candidate": core.models.candidate,
    "target": core.models.target,
    "assessment": core.models.assessment,
    "readiness": core.models.readiness,
    "gaps": core.models.gaps,
    "preparation": core.models.preparation,
    "interview": core.models.interview,
    "resume": core.models.resume,
    "companies": core.models.companies,
    "packs": core.models.packs,
    "skills": core.models.skills,
    "platform": core.models.platform,
    "state": core.models.state,
    "plugin_api": core.plugin_api,
}


def _models_of(module: ModuleType) -> dict[str, type[BaseModel]]:
    return {
        name: value
        for name, value in vars(module).items()
        if isinstance(value, type)
        and issubclass(value, BaseModel)
        and value.__module__ == module.__name__
        and not name.startswith("_")
    }


def build_schemas() -> dict[str, dict[str, Any]]:
    groups: dict[str, dict[str, Any]] = {}
    for group, module in _MODEL_GROUPS.items():
        models = _models_of(module)
        if not models:
            continue
        groups[group] = {
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "group": group,
            "models": {
                name: model.model_json_schema(mode="serialization")
                for name, model in sorted(models.items())
            },
        }
    groups["store"] = {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "group": "store",
        "tables": list(TABLE_NAMES),
    }
    return groups


def write_schemas() -> list[Path]:
    written: list[Path] = []
    SCHEMA_DIR.mkdir(parents=True, exist_ok=True)
    for group, document in sorted(build_schemas().items()):
        path = SCHEMA_DIR / f"{group}.json"
        path.write_text(_dumps(document), encoding="utf-8")
        written.append(path)
    OPENAPI_PATH.write_text(_dumps(create_app().openapi()), encoding="utf-8")
    written.append(OPENAPI_PATH)
    return written


def _dumps(document: Any) -> str:
    return json.dumps(document, indent=2, sort_keys=True, ensure_ascii=False) + "\n"


def main() -> int:
    for path in write_schemas():
        print(path.relative_to(API_DIR).as_posix())
    return 0


if __name__ == "__main__":
    sys.exit(main())
