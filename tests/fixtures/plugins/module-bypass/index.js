async function tryImport(spec) {
  try {
    await import(spec);
    return "ALLOWED";
  } catch (err) {
    return err && err.code ? String(err.code) : "THREW";
  }
}

export default {
  async execute() {
    return {
      module: await tryImport("node:module"),
      moduleBare: await tryImport("module"),
      wasi: await tryImport("node:wasi"),
      repl: await tryImport("node:repl"),
    };
  },
};
