"""Manifest validation per plugin design §4 / phase-7 §1."""

from __future__ import annotations

from pathlib import Path

import pytest
from pydantic import ValidationError

from interview_os.plugins import PluginManifest, PluginManifestError, version_gt, version_key


def write_manifest(tmp_path: Path, body: str) -> Path:
    path = tmp_path / "plugin.yaml"
    path.write_text(body, encoding="utf-8")
    return path


def test_defaults_apply_and_name_falls_back_to_id(tmp_path: Path) -> None:
    manifest = PluginManifest.load(write_manifest(tmp_path, "id: demo\nversion: 1.0.0\n"))
    assert manifest.id == "demo"
    assert manifest.name == "demo"
    assert manifest.kind == "tool"
    assert manifest.entry == "main.py"
    assert manifest.requires == ()
    assert manifest.ui is None
    assert manifest.modes == ()
    assert manifest.icon is None
    assert manifest.group is None


def test_explicit_fields_parse(tmp_path: Path) -> None:
    manifest = PluginManifest.load(
        write_manifest(
            tmp_path,
            "id: demo-toolkit\n"
            "version: 2.3.4\n"
            "name: Demo Toolkit\n"
            "kind: hook\n"
            "entry: src/main.py\n"
            "description: shows things\n"
            "requires:\n  - httpx\n",
        )
    )
    assert manifest.name == "Demo Toolkit"
    assert manifest.kind == "hook"
    assert manifest.entry == "src/main.py"
    assert manifest.requires == ("httpx",)
    assert manifest.description == "shows things"


def test_single_string_requires_is_coerced(tmp_path: Path) -> None:
    manifest = PluginManifest.load(
        write_manifest(tmp_path, "id: demo\nversion: 1.0.0\nrequires: httpx\n")
    )
    assert manifest.requires == ("httpx",)


def test_unknown_kind_is_rejected(tmp_path: Path) -> None:
    with pytest.raises(PluginManifestError):
        PluginManifest.load(write_manifest(tmp_path, "id: demo\nversion: 1.0.0\nkind: widget\n"))


def test_missing_id_or_version_is_rejected(tmp_path: Path) -> None:
    with pytest.raises(PluginManifestError):
        PluginManifest.load(write_manifest(tmp_path, "version: 1.0.0\n"))
    with pytest.raises(PluginManifestError):
        PluginManifest.load(write_manifest(tmp_path, "id: demo\n"))


@pytest.mark.parametrize("bad_id", ["Demo", "demo_toolkit", "-demo", "demo!"])
def test_id_must_be_a_slug(tmp_path: Path, bad_id: str) -> None:
    with pytest.raises(PluginManifestError):
        PluginManifest.load(write_manifest(tmp_path, f"id: {bad_id}\nversion: 1.0.0\n"))


def test_ui_paths_may_not_contain_parent_traversal(tmp_path: Path) -> None:
    with pytest.raises(PluginManifestError):
        PluginManifest.load(
            write_manifest(
                tmp_path,
                "id: demo\nversion: 1.0.0\nui:\n  entry: ../evil.js\n",
            )
        )


def test_entry_may_not_escape_the_plugin_dir(tmp_path: Path) -> None:
    with pytest.raises(PluginManifestError):
        PluginManifest.load(
            write_manifest(tmp_path, "id: demo\nversion: 1.0.0\nentry: ../../evil.py\n")
        )


def test_missing_ui_entry_is_a_backend_only_warning(tmp_path: Path) -> None:
    manifest = PluginManifest.load(
        write_manifest(
            tmp_path,
            "id: demo\nversion: 1.0.0\nui:\n  entry: ui/dist/index.js\n",
        )
    )
    assert manifest.ui is not None
    assert manifest.ui_entry_path(tmp_path) is None


def test_present_ui_entry_resolves(tmp_path: Path) -> None:
    (tmp_path / "ui" / "dist").mkdir(parents=True)
    (tmp_path / "ui" / "dist" / "index.js").write_text("export {};", encoding="utf-8")
    manifest = PluginManifest.load(
        write_manifest(
            tmp_path,
            "id: demo\nversion: 1.0.0\nui:\n  entry: ui/dist/index.js\n",
        )
    )
    resolved = manifest.ui_entry_path(tmp_path)
    assert resolved is not None
    assert resolved.name == "index.js"


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("🧩", "🧩"),
        ("https://example.com/icon.svg", "https://example.com/icon.svg"),
        ("data:image/png;base64,AAAA", "data:image/png;base64,AAAA"),
        ("assets/icon.png", "assets/icon.png"),
        ("../evil.svg", None),
        ("x" * 40, None),
        (123, None),
    ],
)
def test_icon_parsing_is_lenient(tmp_path: Path, raw: object, expected: object) -> None:
    manifest = PluginManifest.model_validate(
        {"id": "demo", "version": "1.0.0", "icon": raw}
    )
    assert manifest.icon == expected


@pytest.mark.parametrize(
    ("raw", "expected"),
    [("modes", "modes"), ("tools", "tools"), ("Not A Slug", None), ("", None), (7, None)],
)
def test_group_parsing_is_lenient(tmp_path: Path, raw: object, expected: object) -> None:
    manifest = PluginManifest.model_validate({"id": "demo", "version": "1.0.0", "group": raw})
    assert manifest.group == expected


def test_modes_block_parses_into_plugin_mode_definitions(tmp_path: Path) -> None:
    manifest = PluginManifest.load(
        write_manifest(
            tmp_path,
            "id: demo-mode\n"
            "version: 1.0.0\n"
            "kind: hook\n"
            "modes:\n"
            "  - id: focus\n"
            "    label: Focus mode\n"
            "    rubric:\n"
            "      - id: clarity\n"
            "        label: Clarity\n",
        )
    )
    assert len(manifest.modes) == 1
    assert manifest.modes[0].id == "focus"
    assert manifest.modes[0].rubric[0].id == "clarity"


def test_invalid_yaml_is_rejected(tmp_path: Path) -> None:
    with pytest.raises(PluginManifestError):
        PluginManifest.load(write_manifest(tmp_path, "id: [unterminated\n"))


def test_non_mapping_yaml_is_rejected(tmp_path: Path) -> None:
    with pytest.raises(PluginManifestError):
        PluginManifest.load(write_manifest(tmp_path, "- one\n- two\n"))


def test_missing_file_is_rejected(tmp_path: Path) -> None:
    with pytest.raises(PluginManifestError):
        PluginManifest.load(tmp_path / "nope" / "plugin.yaml")


def test_manifest_is_frozen(tmp_path: Path) -> None:
    manifest = PluginManifest.load(write_manifest(tmp_path, "id: demo\nversion: 1.0.0\n"))
    with pytest.raises(ValidationError):
        manifest.version = "9.9.9"


def test_version_key_and_compare() -> None:
    assert version_key("1.2.3") == (1, 2, 3)
    assert version_key("1.2") == (1, 2)
    assert version_key("1.x.0") == (1, 0, 0)
    assert version_gt("1.2.0", "1.1.9") is True
    assert version_gt("1.1.0", "1.1.0") is False
    assert version_gt("1.0.0", "2.0.0") is False
    # unknown installed version -> an update is available
    assert version_gt("1.0.0", None) is True
