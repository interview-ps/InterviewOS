import { Hono } from "hono";
import type { AppEnv } from "../context.js";

export const companiesRoutes = new Hono<AppEnv>();

// §9.3: built-in company profiles for the selector.
companiesRoutes.get("/", (c) => c.json(c.var.orchestrator.listCompanyProfiles()));
