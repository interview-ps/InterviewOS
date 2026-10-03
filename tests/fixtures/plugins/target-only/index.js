export default {
  execute(input, ctx) {
    let runtimeError = null;
    try {
      void ctx.runtime.kind;
    } catch (e) {
      runtimeError = e.code ?? e.name ?? "ERROR";
    }
    return {
      keys: Object.keys(input),
      hasCandidate: input.candidate != null,
      target: input.target ?? null,
      runtimeError,
    };
  },
};
