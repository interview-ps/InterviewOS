export default {
  async execute() {
    try {
      const m = await import(
        "data:text/javascript,export const net = await import('node:net');"
      );
      return { dataNet: typeof m.net.createServer === "function" ? "ALLOWED" : "IMPORTED" };
    } catch (err) {
      return { dataNet: err && err.code ? String(err.code) : "THREW" };
    }
  },
};
