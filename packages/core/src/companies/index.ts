import { genericProfile } from "./generic.js";
import { googleProfile } from "./google.js";
import { metaProfile } from "./meta.js";
import { amazonProfile } from "./amazon.js";
import { microsoftProfile } from "./microsoft.js";
import type { CompanyProfile } from "./types.js";

export const COMPANY_PROFILES: CompanyProfile[] = [
  genericProfile,
  googleProfile,
  metaProfile,
  amazonProfile,
  microsoftProfile,
];

export function getCompanyProfile(id: string): CompanyProfile {
  return COMPANY_PROFILES.find((p) => p.id === id) ?? genericProfile;
}

const norm = (s: string) => s.toLowerCase().trim();

/**
 * Match a free-text company name to a built-in profile by name/alias,
 * case-insensitive and on word boundaries; falls back to `generic`.
 */
export function matchCompanyProfile(companyName: string): CompanyProfile {
  const name = norm(companyName);
  if (!name) return genericProfile;
  const words = new Set(name.split(/[^a-z0-9]+/).filter(Boolean));
  for (const profile of COMPANY_PROFILES) {
    if (profile.id === "generic") continue;
    if (norm(profile.name) === name) return profile;
    for (const alias of profile.aliases) {
      const a = norm(alias);
      if (a === name) return profile;
      // multi-word aliases ("amazon web services") match as phrases;
      // single-word aliases match on a word boundary
      if (a.includes(" ") ? name.includes(a) : words.has(a)) return profile;
    }
  }
  return genericProfile;
}

export { COMPANY_DISCLAIMER, CompanyProfileSchema, ModeIdSchema, MODE_ID_LIST } from "./types.js";
export type { CompanyProfile } from "./types.js";
