"""PackRegistry: bundled + installed packs, provenance rules, install/uninstall."""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest
import yaml

from interview_os.core.models import AppError
from interview_os.packs import PackDirs, PackRegistry

REPO_ROOT = Path(__file__).resolve().parents[4]
BUNDLED_PACKS = REPO_ROOT / "packs"


def _write_company_pack(directory: Path, body: str) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "company.yaml").write_text(body, encoding="utf-8")


SIMPLE_COMPANY_PACK = """format: interview-os.company-pack
id: fixture-co
name: FixtureCo
version: 1.0.0
sources:
  - id: blog
    title: FixtureCo Blog
    url: https://example.com/blog
stages:
  - { mode: technical, label: Tech, plannedQuestions: 3, provenance: community }
  - { mode: behavioral, label: Behav, plannedQuestions: 2, provenance: community }
behavioralFramework: { name: X, themes: [], guidance: "" }
competencies:
  - { text: "sourced fact", provenance: sourced, source: blog }
  - { text: "rumor on the street", provenance: community }
"""


def test_bundled_packs_load_with_zero_errors(tmp_path: Path) -> None:
    registry = PackRegistry(PackDirs(bundled=BUNDLED_PACKS, installed=tmp_path / "installed"))
    registry.ensure_loaded()

    assert [error.model_dump() for error in registry.load_errors] == []
    assert [entry.pack.id for entry in registry.list_company_packs()] == ["stripe"]
    assert sorted(entry.pack.id for entry in registry.list_role_packs()) == [
        "backend-engineer",
        "data-engineer",
        "data-scientist",
        "engineering-manager",
        "frontend-engineer",
        "product-manager",
        "sre",
    ]
    assert [pack.id for pack in registry.list_interview_packs()] == ["senior-backend"]
    assert registry.bundled_interview_pack("senior-backend") is not None
    assert registry.bundled_interview_pack("nope") is None


def test_no_dirs_degrades_to_builtins(tmp_path: Path) -> None:
    registry = PackRegistry()
    assert registry.list_company_packs() == []
    assert registry.list_role_packs() == []
    assert registry.list_interview_packs() == []
    assert [profile.id for profile in registry.list_company_profiles()] == [
        "generic",
        "google",
        "meta",
        "amazon",
        "microsoft",
    ]
    assert registry.installed_pack_dir("company") is None


def test_company_profile_lookup_and_matching(tmp_path: Path) -> None:
    registry = PackRegistry(PackDirs(bundled=BUNDLED_PACKS, installed=tmp_path / "installed"))
    assert registry.company_profile("stripe").id == "stripe"
    assert registry.company_profile("google").name == "Google"
    assert registry.company_profile("does-not-exist").id == "generic"
    assert registry.match_company_profile("Stripe").id == "stripe"
    assert registry.match_company_profile("AWS").id == "amazon"
    assert registry.match_company_profile("  Google  ").id == "google"
    assert registry.match_company_profile("SomeCo With No Profile").id == "generic"


def test_sourced_and_community_items(tmp_path: Path) -> None:
    bundled = tmp_path / "bundled"
    _write_company_pack(bundled / "companies" / "fixture-co", SIMPLE_COMPANY_PACK)
    registry = PackRegistry(PackDirs(bundled=bundled, installed=tmp_path / "installed"))
    registry.ensure_loaded()

    entry = registry.list_company_packs()[0]
    profile = entry.profile
    assert profile.id == "fixture-co"
    assert profile.pack is not None
    assert profile.pack.sourced_count == 1
    assert profile.pack.community_count == 3
    assert profile.disclaimer.endswith(
        "Community pack — items marked community are unverified observations."
    )
    assert [stage.mode for stage in profile.typical_loop] == ["technical", "behavioral"]


def test_sourced_item_without_declared_source_is_a_load_error(tmp_path: Path) -> None:
    bundled = tmp_path / "bundled"
    _write_company_pack(
        bundled / "companies" / "bad-co",
        SIMPLE_COMPANY_PACK.replace("source: blog", "source: missing"),
    )
    registry = PackRegistry(PackDirs(bundled=bundled, installed=tmp_path / "installed"))
    registry.ensure_loaded()

    assert registry.list_company_packs() == []
    assert len(registry.load_errors) == 1
    error = registry.load_errors[0]
    assert error.dir == "companies/bad-co"
    assert error.file == "company.yaml"
    assert 'source "missing" is not declared in the pack' in error.error


def test_builtin_profile_collision_is_a_load_error(tmp_path: Path) -> None:
    bundled = tmp_path / "bundled"
    _write_company_pack(
        bundled / "companies" / "google-clone", SIMPLE_COMPANY_PACK.replace("fixture-co", "google")
    )
    registry = PackRegistry(PackDirs(bundled=bundled, installed=tmp_path / "installed"))
    registry.ensure_loaded()
    assert len(registry.load_errors) == 1
    assert "collides with a built-in profile" in registry.load_errors[0].error


def test_missing_company_yaml_and_role_id_mismatch_are_load_errors(tmp_path: Path) -> None:
    bundled = tmp_path / "bundled"
    (bundled / "companies" / "empty").mkdir(parents=True)
    role_dir = bundled / "roles" / "backend"
    role_dir.mkdir(parents=True)
    role_dir.joinpath("role.yaml").write_text(
        yaml.safe_dump(
            {
                "format": "interview-os.role-pack",
                "id": "not-backend",
                "name": "Backend",
                "version": "1.0.0",
                "dimensions": [{"skillId": "sql", "weight": 0.5}],
                "defaultQuestionCategories": ["technical", "behavioral"],
            }
        ),
        encoding="utf-8",
    )
    registry = PackRegistry(PackDirs(bundled=bundled, installed=tmp_path / "installed"))
    registry.ensure_loaded()

    errors = {error.dir: error.error for error in registry.load_errors}
    assert errors["companies/empty"] == "company pack is missing company.yaml"
    assert 'does not match directory "backend"' in errors["roles/backend"]


def test_role_pack_lookup_rubrics_resources_and_taxonomy(tmp_path: Path) -> None:
    registry = PackRegistry(PackDirs(bundled=BUNDLED_PACKS, installed=tmp_path / "installed"))
    registry.ensure_loaded()

    pack = registry.role_pack("backend-engineer")
    assert pack is not None
    assert registry.role_pack("nope") is None
    assert registry.role_rubrics("backend-engineer", "apis.rest", "technical") == [
        "Resource-oriented design",
        "Error and idempotency semantics",
    ]
    assert registry.role_rubrics("backend-engineer", "sql", "system_design") == [
        "Clarifies requirements before designing",
        "Names trade-offs and bottlenecks",
    ]
    assert registry.role_rubrics("backend-engineer", "sql", "technical") == []
    assert registry.role_rubrics(None, "sql", "technical") == []
    assert registry.role_rubrics("nope", "sql", "technical") == []

    resources = registry.role_pack_resources("backend-engineer", "sql")
    assert resources
    assert all(resource.source == "pack:backend-engineer" for resource in resources)
    assert all(resource.skill_id == "sql" for resource in resources)
    assert registry.role_pack_resources(None, "sql") == []


def test_question_candidates_prefer_overlays(tmp_path: Path) -> None:
    registry = PackRegistry(PackDirs(bundled=BUNDLED_PACKS, installed=tmp_path / "installed"))
    registry.ensure_loaded()

    questions = registry.company_pack_questions("stripe", "sql", "technical", "Backend Engineer")
    assert questions
    assert all(question.source.kind == "company_pack" for question in questions)
    assert registry.company_pack_questions("generic", "sql", "technical", "Backend") == []
    assert registry.company_pack_questions("stripe", "nope.nope", "technical", "Backend") == []

    role_questions = registry.role_pack_questions("backend-engineer", "sql", "technical")
    assert all(question.source.kind == "role_pack" for question in role_questions)
    assert registry.role_pack_questions("nope", "sql", "technical") == []


def test_overlay_applies_by_role_or_mode(tmp_path: Path) -> None:
    registry = PackRegistry(PackDirs(bundled=BUNDLED_PACKS, installed=tmp_path / "installed"))
    registry.ensure_loaded()
    pack = registry.company_pack("stripe")
    assert pack is not None and pack.overlays

    overlay = pack.overlays[0]
    keyword = overlay.applies_to.role_keywords[0]
    assert registry.overlay_applies(overlay, f"Senior {keyword} Engineer", "technical")
    assert not registry.overlay_applies(overlay, "Designer", "behavioral")


def test_plugin_pack_dirs_are_tagged_and_collide(tmp_path: Path) -> None:
    plugin_dir = tmp_path / "plugin"
    _write_company_pack(plugin_dir / "packs" / "companies" / "fixture-co", SIMPLE_COMPANY_PACK)
    registry = PackRegistry(PackDirs(installed=tmp_path / "installed"))
    registry.set_plugin_dirs([("fixture-plugin", plugin_dir)])
    registry.reload()

    entry = registry.list_company_packs()[0]
    assert entry.source == "plugin:fixture-plugin"

    other = tmp_path / "plugin2"
    _write_company_pack(other / "packs" / "companies" / "fixture-co", SIMPLE_COMPANY_PACK)
    registry.set_plugin_dirs([("fixture-plugin", plugin_dir), ("other-plugin", other)])
    registry.reload()
    assert [error.dir for error in registry.load_errors] == ["companies/fixture-co"]
    assert "collides with an existing pack" in registry.load_errors[0].error


def _has_git() -> bool:
    try:
        subprocess.run(["git", "--version"], capture_output=True, check=True)
    except (OSError, subprocess.CalledProcessError):
        return False
    return True


@pytest.mark.skipif(not _has_git(), reason="git is not on PATH")
async def test_install_pack_from_git_and_uninstall(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    repo.joinpath("company.yaml").write_text(SIMPLE_COMPANY_PACK, encoding="utf-8")
    for argv in (
        ["git", "init", "-q"],
        ["git", "add", "-A"],
        ["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"],
    ):
        subprocess.run(argv, cwd=repo, capture_output=True, check=True)

    installed = tmp_path / "installed"
    registry = PackRegistry(PackDirs(bundled=BUNDLED_PACKS, installed=installed))

    result = await registry.install_pack_from_git("company", str(repo))
    assert result == {"id": "fixture-co"}
    installed_entry = next(
        entry for entry in registry.list_company_packs() if entry.pack.id == "fixture-co"
    )
    assert installed_entry.source == "installed"
    assert (installed / "companies" / "fixture-co" / "company.yaml").exists()
    assert not (installed / "companies" / "fixture-co" / ".git").exists()

    await registry.uninstall_pack("company", "fixture-co")
    assert [entry.pack.id for entry in registry.list_company_packs()] == ["stripe"]


async def test_install_rejects_a_bad_source_and_bundled_uninstall(tmp_path: Path) -> None:
    registry = PackRegistry(PackDirs(bundled=BUNDLED_PACKS, installed=tmp_path / "installed"))

    with pytest.raises(AppError) as install_error:
        await registry.install_pack_from_git("company", "ssh://x@y/z")
    assert install_error.value.code == "PACK_INSTALL"
    assert install_error.value.args[0] == "source must be an https URL without credentials"

    registry.ensure_loaded()
    with pytest.raises(AppError) as bundled_error:
        await registry.uninstall_pack("company", "stripe")
    assert bundled_error.value.code == "VALIDATION"
    assert bundled_error.value.args[0] == 'pack "stripe" is bundled and cannot be uninstalled'

    with pytest.raises(AppError) as missing_error:
        await registry.uninstall_pack("role", "nope")
    assert missing_error.value.code == "NOT_FOUND"
    assert missing_error.value.args[0] == 'unknown role pack "nope"'


async def test_install_requires_configured_dirs() -> None:
    registry = PackRegistry()
    with pytest.raises(AppError) as error:
        await registry.install_pack_from_git("company", "https://example.com/x.git")
    assert error.value.code == "PACK_INSTALL"
    assert error.value.args[0] == "pack install requires configured pack directories"
