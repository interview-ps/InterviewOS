import { bodyLimit } from "hono/body-limit";

export const apiBodyLimit = bodyLimit({
  maxSize: 200 * 1024,
  onError: (c) =>
    c.json({ error: { code: "TOO_LARGE", message: "body exceeds 200KB" } }, 413),
});

/** v0.4: full-state imports can be large — raised limit, /api/import only. */
export const importBodyLimit = bodyLimit({
  maxSize: 25 * 1024 * 1024,
  onError: (c) =>
    c.json({ error: { code: "TOO_LARGE", message: "import bundle exceeds 25MB" } }, 413),
});

export const docBodyLimit = bodyLimit({
  maxSize: 5 * 1024 * 1024,
  onError: (c) =>
    c.json({ error: { code: "TOO_LARGE", message: "file exceeds 5MB" } }, 413),
});
