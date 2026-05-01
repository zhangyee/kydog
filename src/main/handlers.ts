import { app, dialog } from 'electron';
import { registerHandler } from './ipc/dispatcher';
import { oauthCoordinator } from './llm/oauth';
import { settingsService } from './settings/settingsService';
import { llmService } from './llm/llmService';
import { projectService } from './project/projectService';
import { threadService } from './thread/threadService';
import { skillSyncStateHolder } from './skills/skillSyncStateHolder';
import { skillsService } from './skills/skillsService';
import { toolsService } from './skills/toolsService';

export function registerAllHandlers(): void {
  registerHandler('app.bootstrap', async () => {
    const [settings, projects, threads] = await Promise.all([
      settingsService.get(),
      projectService.list(),
      threadService.listAll(),
    ]);
    return { settings, projects, threads, appVersion: app.getVersion() };
  });

  registerHandler('settings.get', () => settingsService.get());
  registerHandler('settings.update', (args) => settingsService.update(args));

  registerHandler('project.open', () => projectService.open());
  registerHandler('project.list', () => projectService.list());
  registerHandler('project.close', (args) => projectService.close(args));
  registerHandler('project.readDir', (args) => projectService.readDir(args));
  registerHandler('project.openInOS', (args) => projectService.openInOS(args));
  registerHandler('project.update', (args) => projectService.update(args));

  registerHandler('thread.create', (args) => threadService.create(args));
  registerHandler('thread.list', (args) => threadService.list(args));
  registerHandler('thread.delete', (args) => threadService.delete(args));
  registerHandler('thread.rename', (args) => threadService.rename(args));
  registerHandler('thread.loadHistory', (args) => threadService.loadHistory(args));
  registerHandler('thread.send', (args) => threadService.send(args));
  registerHandler('thread.abort', (args) => threadService.abort(args));
  registerHandler('thread.update', (args) => threadService.update(args));

  registerHandler('skill.getPendingSync', () => skillSyncStateHolder.getStatus());
  registerHandler('skill.applyOverrides', async (args) => {
    await skillSyncStateHolder.applyOverrides(args.operations);
    return skillSyncStateHolder.getStatus();
  });

  registerHandler('skill.list', () => skillsService.list());
  registerHandler('skill.setEnabled', (args) => skillsService.setEnabled(args.name, args.enabled));
  registerHandler('skill.uninstall', (args) => skillsService.uninstall(args.name));
  registerHandler('skill.openInOS', (args) => skillsService.openInOS(args.name));
  registerHandler('skill.previewFromFolder', (args) => skillsService.previewFromFolder(args));
  registerHandler('skill.previewFromUrl', (args) => skillsService.previewFromUrl(args));
  registerHandler('skill.commitFromPreview', (args) => skillsService.commitFromPreview(args));
  registerHandler('skill.pickFolder', async () => {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory'] });
    if (r.canceled || r.filePaths.length === 0) return null;
    return r.filePaths[0];
  });
  registerHandler('tool.list', (args) => toolsService.list({ force: args?.force }));
  registerHandler('tool.addExternal', () => toolsService.addExternal());
  registerHandler('tool.removeExternal', (args) => toolsService.removeExternal(args));

  registerHandler('llm.list', () => llmService.list());
  registerHandler('llm.configure', (args) => llmService.configure(args));
  registerHandler('llm.remove', (args) => llmService.remove(args.providerId));
  registerHandler('llm.removeCustom', (args) => llmService.removeCustom(args.customId));
  registerHandler('llm.setDefault', (args) => llmService.setDefault(args.providerId, args.modelId));
  registerHandler('llm.setThreadOverride', (args) => llmService.setThreadOverride(args.threadId, args.override));
  registerHandler('llm.testConnection', (args) => llmService.testConnection(args.providerId));

  // OAuth — Phase 5
  registerHandler('llm.login', (args) => oauthCoordinator.login(args.providerId));
  registerHandler('llm.loginCancel', async (args) => oauthCoordinator.cancel(args.providerId));
  registerHandler('llm.loginPromptReply', async (args) => oauthCoordinator.promptReply(args.providerId, args.value));
  registerHandler('llm.logout', async (args) => {
    await oauthCoordinator.logout(args.providerId);
    const { llmService } = await import('./llm/llmService');
    return llmService.list();
  });

  registerHandler('dialog.pickFile', async (args) => {
    const r = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: args?.filters,
    });
    if (r.canceled || r.filePaths.length === 0) return null;
    return r.filePaths[0];
  });
}
