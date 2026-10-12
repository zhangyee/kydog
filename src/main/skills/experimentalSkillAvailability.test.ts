import { it, expect } from 'vitest';
import { defaultSettings } from '../persist/settingsFile';
import { hiddenExperimentalBuiltinSkills } from './experimentalSkillAvailability';

it('availability follows persisted flag while preserving disabled preferences', () => {
  const settings = defaultSettings();
  settings.skills.disabledBuiltins = ['x-research', 'fastpaper'];
  expect(hiddenExperimentalBuiltinSkills(settings)).toEqual(['x-research']);
  settings.research.xResearchEnabled = true;
  expect(hiddenExperimentalBuiltinSkills(settings)).toEqual([]);
  expect(settings.skills.disabledBuiltins).toEqual(['x-research', 'fastpaper']);
});
