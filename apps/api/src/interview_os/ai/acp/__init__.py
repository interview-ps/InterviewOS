"""Generic ACP (Agent Client Protocol) client + runtime.

Interview OS is the ACP *client*; each provider runs as an ACP *agent*
subprocess speaking JSON-RPC 2.0 over stdio. See
`docs/design/acp-runtime.md` for the method mapping and the security posture.
"""

from .client import AcpClient, AcpClientOptions, NotificationHandler
from .config import AcpAgentConfig, build_acp_child_env
from .detect import acp_health_check, find_acp_executable
from .events import extract_text, stop_reason_to_error, update_to_event
from .runtime import AcpRuntime, AcpRuntimeOptions

__all__ = [
    "AcpAgentConfig",
    "AcpClient",
    "AcpClientOptions",
    "AcpRuntime",
    "AcpRuntimeOptions",
    "NotificationHandler",
    "acp_health_check",
    "build_acp_child_env",
    "extract_text",
    "find_acp_executable",
    "stop_reason_to_error",
    "update_to_event",
]
