export default {
  async execute() {
    let fetchErr = null;
    try {
      await fetch("http://127.0.0.1:1/");
      fetchErr = "NONE";
    } catch (err) {
      fetchErr = err.name ?? (typeof fetch === "undefined" ? "UNDEFINED" : "ERR");
    }
    let httpErr = null;
    try {
      await import("node:http");
      httpErr = "NONE";
    } catch (err) {
      httpErr = "BLOCKED";
    }
    return { fetchType: typeof fetch, fetchErr, httpErr };
  },
};
