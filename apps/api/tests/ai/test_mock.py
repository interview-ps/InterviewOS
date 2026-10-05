"""MockRuntime: determinism, handlers, sessions, error paths."""

from __future__ import annotations

from interview_os.ai import (
    AgentTask,
    MockRuntime,
    MockRuntimeOptions,
    RuntimeEvent,
    RuntimeMessage,
    SessionInput,
)


def task(task_id: str, input: object = None) -> AgentTask:
    return AgentTask(task_id=task_id, instructions="", input=input, output_schema={})


async def test_dispatches_run_task_to_a_registered_handler() -> None:
    runtime = MockRuntime()
    runtime.register("echo", lambda value, _task: {"echoed": value})
    result = await runtime.run_task(task("echo", {"hello": "world"}))
    assert result.ok is True
    assert result.output == {"echoed": {"hello": "world"}}
    assert result.raw == '{"echoed":{"hello":"world"}}'


async def test_returns_protocol_error_for_an_unknown_task_id() -> None:
    result = await MockRuntime().run_task(task("nope"))
    assert result.ok is False
    assert result.error is not None
    assert result.error.code == "PROTOCOL"
    assert "nope" in result.error.message
    assert list(result.events) == [{"type": "started"}]


async def test_async_handlers_are_awaited() -> None:
    runtime = MockRuntime()

    async def handler(value: object, _task: AgentTask) -> object:
        return {"async": True}

    runtime.register("async-task", handler)
    result = await runtime.run_task(task("async-task"))
    assert result.ok is True
    assert result.output == {"async": True}


async def test_fallback_handles_unregistered_task_ids() -> None:
    runtime = MockRuntime()
    runtime.set_fallback(lambda task_id, value, _task: {"taskId": task_id, "value": value})
    result = await runtime.run_task(task("anything", 7))
    assert result.ok is True
    assert result.output == {"taskId": "anything", "value": 7}


async def test_fallback_returning_none_is_not_handled() -> None:
    runtime = MockRuntime()
    runtime.set_fallback(lambda task_id, value, _task: None)
    result = await runtime.run_task(task("anything"))
    assert result.ok is False
    assert result.error is not None
    assert result.error.code == "PROTOCOL"


async def test_run_task_streams_deltas_to_the_event_callback() -> None:
    runtime = MockRuntime()
    runtime.register("echo", lambda value, _task: {"n": 1})
    seen: list[RuntimeEvent] = []
    result = await runtime.run_task(
        AgentTask(
            task_id="echo",
            instructions="",
            input=None,
            output_schema={},
            on_event=seen.append,
        )
    )
    assert result.ok is True
    assert seen[0] == {"type": "started"}
    assert seen[-1] == {"type": "completed", "output": {"n": 1}, "raw": '{"n":1}'}
    deltas = [event for event in seen if event["type"] == "delta"]
    assert "".join(str(event["text"]) for event in deltas) == '{"n":1}'
    assert list(result.events) == list(seen)


async def test_chunk_delay_is_applied_between_deltas() -> None:
    runtime = MockRuntime(MockRuntimeOptions(chunk_delay_ms=1))
    runtime.register("echo", lambda value, _task: {"n": 1})
    result = await runtime.run_task(task("echo"))
    assert result.ok is True


async def test_supports_sessions_with_streaming_events() -> None:
    runtime = MockRuntime()
    runtime.register("chat", lambda value, _task: {"reply": f"turn:{value}"})
    session = await runtime.create_session(SessionInput())
    assert session.thread_id.startswith("mock-thread-")

    events: list[RuntimeEvent] = []
    async for event in runtime.send_message(
        session.id, RuntimeMessage(text="hi", task_id="chat", input=1)
    ):
        events.append(event)
    assert events[0] == {"type": "started"}
    assert any(event["type"] == "delta" for event in events)
    assert events[-1]["type"] == "completed"
    assert events[-1]["output"] == {"reply": "turn:1"}


async def test_session_turn_without_a_task_id_echoes_the_text_length() -> None:
    runtime = MockRuntime()
    session = await runtime.create_session(SessionInput())
    events: list[RuntimeEvent] = []
    async for event in runtime.send_message(session.id, RuntimeMessage(text="hello")):
        events.append(event)
    assert events[-1] == {"type": "completed", "raw": "[mock turn 1] 5 chars"}


async def test_session_turn_without_a_handler_errors() -> None:
    runtime = MockRuntime()
    session = await runtime.create_session(SessionInput())
    events: list[RuntimeEvent] = []
    async for event in runtime.send_message(session.id, RuntimeMessage(text="hi", task_id="ghost")):
        events.append(event)
    assert events[-1]["type"] == "error"
    assert events[-1]["error"] is not None
    assert events[-1]["error"].code == "PROTOCOL"


async def test_resumes_sessions_by_thread_id() -> None:
    runtime = MockRuntime()
    first = await runtime.create_session(SessionInput())
    second = await runtime.resume_session(first.thread_id, SessionInput())
    assert second.id == first.id
    third = await runtime.resume_session("never-seen", SessionInput())
    assert third.thread_id == "never-seen"


async def test_errors_for_unknown_sessions() -> None:
    events: list[RuntimeEvent] = []
    async for event in MockRuntime().send_message("ghost", RuntimeMessage(text="x")):
        events.append(event)
    assert events[0]["type"] == "error"


async def test_health_check_and_models() -> None:
    runtime = MockRuntime()
    status = await runtime.health_check()
    assert (status.runtime, status.available, status.status) == ("mock", True, "ready")
    models = await runtime.list_models()
    assert [model.id for model in models] == ["mock"]


async def test_dispose_drops_sessions() -> None:
    runtime = MockRuntime()
    session = await runtime.create_session(SessionInput())
    await runtime.close_session(session.id)
    events: list[RuntimeEvent] = []
    async for event in runtime.send_message(session.id, RuntimeMessage(text="x")):
        events.append(event)
    assert events[0]["type"] == "error"
