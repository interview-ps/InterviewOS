// Minimal plugin entry: deterministic execute(), no capabilities.
export default {
  execute({ request }) {
    return { ok: true, echo: request ?? null, from: "contract-demo-plugin" };
  },
};
