"""`MiddlewareRuntime` — before/after model hooks (§7.3)."""

from __future__ import annotations

from dataclasses import replace

from interview_os.ai.interface import (
    AgentResult,
    AgentTask,
    AIRuntime,
    RuntimeMessage,
    SessionInput,
)
from interview_os.ai.middleware import MiddlewareRuntime, ModelCall, ModelResult
from interview_os.ai.mock import MockRuntime


def make_runtime() -> MockRuntime:
    runtime = MockRuntime()
    runtime.register(
        "t", lambda payload, task: {"instructions": task.instructions, "payload": payload}
    )
    return runtime


class Recorder:
    """Records hook order and optionally rewrites the call/result."""

    def __init__(self, tag: str = "") -> None:
        self.tag = tag
        self.before: list[str] = []
        self.after: list[str] = []
        self.streams: list[ModelResult] = []

    async def before_model(self, call: ModelCall) -> ModelCall | None:
        self.before.append(self.tag)
        if call.operation == "run_task" and call.task is not None:
            task = replace(call.task, instructions=f"{call.task.instructions}{self.tag}")
            return ModelCall(operation="run_task", task=task)
        return None

    async def after_model(self, call: ModelCall, result: ModelResult) -> ModelResult | None:
        self.after.append(self.tag)
        return None


async def test_before_model_can_rewrite_the_task() -> None:
    runtime = make_runtime()
    tagged = Recorder("!")
    wrapped = MiddlewareRuntime(runtime, [tagged])
    task = AgentTask(task_id="t", instructions="hi", input={}, output_schema={})
    result = await wrapped.run_task(task)
    assert result.output == {"instructions": "hi!", "payload": {}}
    assert tagged.before == ["!"]
    assert tagged.after == ["!"]


async def test_after_model_can_replace_the_result() -> None:
    class Rewriter:
        async def after_model(self, call: ModelCall, result: ModelResult) -> ModelResult | None:
            replacement = AgentResult.success(
                output="rewritten", raw=None, duration_ms=0, events=[]
            )
            return ModelResult(call=call, result=replacement)

    wrapped = MiddlewareRuntime(make_runtime(), [Rewriter()])
    task = AgentTask(task_id="t", instructions="hi", input={}, output_schema={})
    result = await wrapped.run_task(task)
    assert result.output == "rewritten"


async def test_chain_runs_in_order() -> None:
    first = Recorder("a")
    second = Recorder("b")
    wrapped = MiddlewareRuntime(make_runtime(), [first, second])
    task = AgentTask(task_id="t", instructions="", input={}, output_schema={})
    result = await wrapped.run_task(task)
    assert result.output == {"instructions": "ab", "payload": {}}
    assert first.before == ["a"]
    assert second.before == ["b"]


async def test_middleware_without_hooks_is_tolerated() -> None:
    wrapped = MiddlewareRuntime(make_runtime(), [object()])
    task = AgentTask(task_id="t", instructions="x", input={}, output_schema={})
    result = await wrapped.run_task(task)
    assert result.output == {"instructions": "x", "payload": {}}


async def test_send_message_wraps_the_stream() -> None:
    runtime = make_runtime()

    class MessageRewriter:
        def __init__(self) -> None:
            self.after_event_counts: list[int] = []

        async def before_model(self, call: ModelCall) -> ModelCall | None:
            if call.operation == "send_message" and call.message is not None:
                message = replace(call.message, text=f"{call.message.text} world")
                return ModelCall(
                    operation="send_message", session_id=call.session_id, message=message
                )
            return None

        async def after_model(self, call: ModelCall, result: ModelResult) -> ModelResult | None:
            self.after_event_counts.append(len(result.events))
            return None

    middleware = MessageRewriter()
    wrapped = MiddlewareRuntime(runtime, [middleware])
    session = await runtime.create_session(SessionInput())

    events = [event async for event in wrapped.send_message(session.id, RuntimeMessage(text="hi"))]
    types = [event["type"] for event in events]
    assert types[0] == "started"
    assert types[-1] == "completed"
    # the mock echoes the *rewritten* message length ("hi world" -> 8 chars)
    assert any("8 chars" in (event.get("text") or "") for event in events)
    assert middleware.after_event_counts == [len(events)]


async def test_passthrough_delegates() -> None:
    runtime = make_runtime()
    wrapped: AIRuntime = MiddlewareRuntime(runtime, [])

    assert wrapped.kind == "mock"
    assert (await wrapped.health_check()).status == "ready"
    assert [model.id for model in await wrapped.list_models()] == ["mock"]

    session = await wrapped.create_session(SessionInput(instructions="x"))
    resumed = await wrapped.resume_session(session.thread_id, SessionInput())
    assert resumed.thread_id == session.thread_id
    await wrapped.close_session(session.id)
    await wrapped.dispose()


async def test_nested_middleware_runtimes() -> None:
    outer_tag = Recorder("<")
    inner_tag = Recorder(">")
    inner = MiddlewareRuntime(make_runtime(), [inner_tag])
    outer = MiddlewareRuntime(inner, [outer_tag])
    task = AgentTask(task_id="t", instructions="", input={}, output_schema={})
    result = await outer.run_task(task)
    assert result.output == {"instructions": "<>", "payload": {}}
