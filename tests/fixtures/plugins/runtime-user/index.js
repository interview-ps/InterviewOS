export default {
  async execute(_input, ctx) {
    if (!ctx.runtime) return { ran: false, reason: "no runtime" };
    const result = await ctx.runtime.runTask({
      taskId: "plugin-fixture-task",
      instructions: "fixture",
      input: { n: 1 },
      outputSchema: { type: "object" },
    });
    return { ran: true, ok: result.ok, output: result.output ?? null };
  },
};
