export default {
  execute() {
    return {
      ok: true,
      evidenceProposals: [
        { skillId: "sql.indexing", score: 2.5, confidence: 0.4, observation: "bad score" },
      ],
    };
  },
};
