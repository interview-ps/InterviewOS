"""Tool enablement, schema, config, and invocation (§7.1)."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from pydantic import ValidationError

from interview_os.plugins import LoadedPlugin, PluginManifest, ToolRegistration
from interview_os.plugins.tools import (
    _tool_enabled,
    build_plugin_tools,
    describe_tools,
    get_tool_config,
)


def make_loaded(*tools: ToolRegistration, plugin_id: str = "demo") -> LoadedPlugin:
    manifest = PluginManifest.model_validate({"id": plugin_id, "version": "1.0.0"})
    return LoadedPlugin(
        manifest=manifest,
        source_path=Path("/plugins") / plugin_id,
        tools=list(tools),
    )


@pytest.mark.parametrize(
    ("global_enabled", "config", "expected"),
    [
        (False, {}, False),
        (False, {"add": {"enabled": True}}, False),
        (True, {}, True),
        (True, {"add": {"enabled": True}}, True),
        (True, {"add": {"enabled": False}}, False),
        (True, {"add": {}}, True),
        (True, {"other": {"enabled": False}}, True),
    ],
)
def test_tool_enabled_matrix(
    global_enabled: bool, config: dict[str, Any], expected: bool
) -> None:
    assert (
        _tool_enabled("demo", "add", global_enabled=global_enabled, config=config) is expected
    )


def test_get_tool_config_defaults_to_empty() -> None:
    assert get_tool_config("anything") == {}


def test_build_plugin_tools_filters_disabled() -> None:
    registration = ToolRegistration(plugin_id="demo", name="add", fn=lambda a, b: a + b)
    loaded = make_loaded(registration)

    enabled = build_plugin_tools(loaded, global_enabled=True, config={})
    assert [tool.name for tool in enabled] == ["add"]

    disabled = build_plugin_tools(
        loaded, global_enabled=True, config={"add": {"enabled": False}}
    )
    assert disabled == []

    globally_off = build_plugin_tools(loaded, global_enabled=False, config={})
    assert globally_off == []


def test_tool_schema_comes_from_the_signature() -> None:
    def add(a: int, b: int, *, label: str = "n") -> int:
        return a + b

    loaded = make_loaded(ToolRegistration(plugin_id="demo", name="add", fn=add))
    (tool,) = build_plugin_tools(loaded, global_enabled=True, config={})
    assert tool.schema["properties"]["a"]["type"] == "integer"
    assert tool.schema["properties"]["label"]["default"] == "n"
    assert set(tool.schema["required"]) == {"a", "b"}


async def test_invoke_validates_arguments() -> None:
    loaded = make_loaded(ToolRegistration(plugin_id="demo", name="add", fn=lambda a, b: a + b))
    (tool,) = build_plugin_tools(loaded, global_enabled=True, config={})
    assert await tool.invoke({"a": 2, "b": 3}) == 5
    with pytest.raises(ValidationError):
        await tool.invoke({"a": 2})


async def test_invoke_awaits_async_tools() -> None:
    async def double(x: int) -> int:
        return x * 2

    loaded = make_loaded(ToolRegistration(plugin_id="demo", name="double", fn=double))
    (tool,) = build_plugin_tools(loaded, global_enabled=True, config={})
    assert await tool.invoke({"x": 21}) == 42


async def test_tool_config_is_readable_inside_the_call() -> None:
    def echo(text: str) -> str:
        return f"{get_tool_config('echo').get('prefix', '')}{text}"

    loaded = make_loaded(ToolRegistration(plugin_id="demo", name="echo", fn=echo))
    (tool,) = build_plugin_tools(
        loaded,
        global_enabled=True,
        config={"echo": {"enabled": True, "config": {"prefix": "> "}}},
    )
    assert tool.config == {"prefix": "> "}
    assert await tool.invoke({"text": "hi"}) == "> hi"
    # the contextvar is reset after the call
    assert get_tool_config("echo") == {}


def test_describe_tools_reports_enablement_and_config() -> None:
    registrations = [
        ToolRegistration(
            plugin_id="demo",
            name="add",
            fn=lambda a, b: a + b,
            description="adds",
            config_fields=[{"name": "a", "type": "number"}],
        ),
        ToolRegistration(plugin_id="demo", name="sub", fn=lambda a, b: a - b),
    ]
    loaded = make_loaded(*registrations)
    catalogue = describe_tools(
        loaded,
        global_enabled=True,
        config={"sub": {"enabled": False}, "add": {"config": {"a": 1}}},
    )
    by_name = {entry["name"]: entry for entry in catalogue}
    assert by_name["add"]["enabled"] is True
    assert by_name["add"]["config"] == {"a": 1}
    assert by_name["add"]["configFields"] == [{"name": "a", "type": "number"}]
    assert by_name["sub"]["enabled"] is False
