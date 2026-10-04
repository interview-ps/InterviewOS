export default {
  execute: ({ request } = {}) => ({ ok: true, echo: request ?? null }),
};
