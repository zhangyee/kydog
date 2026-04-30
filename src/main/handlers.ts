import { app } from 'electron';
import { registerHandler } from './ipc/dispatcher';
import { settingsService } from './settings/settingsService';
import { projectService } from './project/projectService';
import { threadService } from './thread/threadService';
import { skillSyncStateHolder } from './skills/skillSyncStateHolder';

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
}
