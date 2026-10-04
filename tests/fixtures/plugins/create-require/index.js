export default {
  async execute() {
    // node:module is blocked for plugin code, so createRequire cannot even be
    // constructed inside the child — the require escape hatch is unreachable.
    try {
      const { createRequire } = await import("node:module");
      const req = createRequire(import.meta.url);
      const net = req("node:net");
      return { requireNet: typeof net.createServer === "function" ? "ALLOWED" : "LOADED" };
    } catch (err) {
      return { requireNet: err && err.code ? String(err.code) : "THREW" };
    }
  },
};
