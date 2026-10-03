import type { SkillId } from "../../skill-id.js";
import type { RoundType } from "../rounds.js";
import { technicalMode } from "./technical.js";
import { codingMode } from "./coding.js";
import { systemDesignMode } from "./system-design.js";
import { behavioralMode } from "./behavioral.js";
import { hiringManagerMode } from "./hiring-manager.js";
import { hrMode } from "./hr.js";
import { MODE_IDS, type ModeDefinition, type ModeId } from "./types.js";

const MODES: Record<ModeId, ModeDefinition> = {
  technical: technicalMode,
  coding: codingMode,
  system_design: systemDesignMode,
  behavioral: behavioralMode,
  hiring_manager: hiringManagerMode,
  hr: hrMode,
};

/** v0.2 legacy round: whole pool, no rubric contract, no mode state/follow-ups. */
const MIXED_MODE: ModeDefinition = {
  id: "mixed",
  label: "Mixed",
  description: "Weakness-driven mix of all areas (legacy v0.2 round).",
  inScope: () => true,
  fallbackSkills: [],
  rubric: [],
  initialState: () => ({}),
  reduce: (state) => state,
  followUp: () => ({ ask: false, reason: "mixed rounds do not follow up" }),
};

export function getMode(id: RoundType | ModeId): ModeDefinition {
  return id === "mixed" ? MIXED_MODE : MODES[id as ModeId];
}

export function allModes(): ModeDefinition[] {
  return MODE_IDS.map((id) => MODES[id]);
}

export const isModeId = (v: unknown): v is ModeId =>
  typeof v === "string" && (MODE_IDS as readonly string[]).includes(v);

export { MODE_IDS };
export type { ModeId };
export * from "./types.js";
export {
  DESIGN_DIMENSION_IDS,
  DIMENSION_SKILL,
  nextUncoveredDimension,
  systemDesignMode,
} from "./system-design.js";
export type {
  DesignDimensionState,
  DesignStatus,
  SystemDesignState,
} from "./system-design.js";
export type { CodingModeState, CodingProblem } from "./coding.js";
export type { BehavioralModeState } from "./behavioral.js";
export type { HiringManagerState } from "./hiring-manager.js";
export type { HrModeState } from "./hr.js";
export { codingMode } from "./coding.js";
export { technicalMode } from "./technical.js";
export { behavioralMode } from "./behavioral.js";
export { hiringManagerMode } from "./hiring-manager.js";
export { hrMode } from "./hr.js";
