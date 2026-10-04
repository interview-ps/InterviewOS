import { z } from "zod";

/** v0.4: slug ids shared by plugins and packs — safe as directory names. */
export const SLUG_ID_REGEX = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const SlugIdSchema = z
  .string()
  .regex(SLUG_ID_REGEX, "id must be a lowercase slug (a-z0-9 and '-')");
