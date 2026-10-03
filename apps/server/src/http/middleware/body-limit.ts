import { bodyLimit } from "hono/body-limit";

export const apiBodyLimit = bodyLimit({
  maxSize: 200 * 1024,
  onError: (c) =>
    c.json({ error: { code: "TOO_LARGE", message: "body exceeds 200KB" } }, 413),
});

export const docBodyLimit = bodyLimit({
  maxSize: 5 * 1024 * 1024,
  onError: (c) =>
    c.json({ error: { code: "TOO_LARGE", message: "file exceeds 5MB" } }, 413),
});
