// Trusted local runtime provider fixture: wraps MockRuntime.
// Loaded via interview-os.runtimes.json → loadRuntimeProviders.
import { MockRuntime } from "@interview-os/runtime";

export default {
  kind: "fixture-runtime",
  label: "Fixture provider",
  create() {
    return new MockRuntime({ chunkDelayMs: 0 });
  },
  async healthCheck(_env, workspaceDir) {
    return {
      runtime: "fixture-runtime",
      available: true,
      workspace: workspaceDir,
      status: "ready",
      message: "fixture provider (wraps mock)",
    };
  },
};
