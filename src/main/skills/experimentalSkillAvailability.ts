import type { SettingsFile } from '../../shared/types';

export const X_RESEARCH_SKILL_NAME = 'x-research';

/** Availability is separate from the user's enabled/disabled preference. */
export function hiddenExperimentalBuiltinSkills(settings: SettingsFile): string[] {
  return settings.research.xResearchEnabled ? [] : [X_RESEARCH_SKILL_NAME];
}
