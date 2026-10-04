export default {
  async execute() {
    const out = { binding: null, linked: null, dlopen: null };
    for (const [key, fn] of [
      ["binding", () => process.binding("tcp_wrap")],
      ["linked", () => process._linkedBinding("tcp_wrap")],
      ["dlopen", () => process.dlopen({ exports: {} }, "x.node")],
    ]) {
      try {
        fn();
        out[key] = "ALLOWED";
      } catch (err) {
        out[key] = err && err.code ? String(err.code) : "THREW";
      }
    }
    return out;
  },
};
