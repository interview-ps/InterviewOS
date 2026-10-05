export default {
  execute() {
    return {
      ok: true,
      evidenceProposals: [
        {
          skillId: "sql.indexing",
          score: 0.7,
          confidence: 0.9,
          observation: "self-check passed on indexing",
        },
        {
          skillId: "sql.transactions",
          score: 0.3,
          confidence: 0.4,
          observation: "self-check failed on transactions",
        },
      ],
    };
  },
};
