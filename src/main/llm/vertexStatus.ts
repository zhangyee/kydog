// src/main/llm/vertexStatus.ts
import { promises as fsp, constants as fsConstants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { VertexCfg } from '../../shared/types';

export type AuthStatus = {
  configured: boolean;
  source?: 'stored' | 'environment';
  label?: string;
};

/**
 * gcloud SDK ADC 默认位置（与 google-auth-library 行为一致）：
 *   - Windows: %APPDATA%\gcloud\application_default_credentials.json
 *   - macOS / Linux / *nix: $HOME/.config/gcloud/application_default_credentials.json
 *   GOOGLE_APPLICATION_CREDENTIALS env 优先级最高
 */
function defaultAdcPath(): string {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'gcloud', 'application_default_credentials.json');
  }
  return path.join(os.homedir(), '.config', 'gcloud', 'application_default_credentials.json');
}

export async function getVertexAuthStatus(cfg: VertexCfg | undefined): Promise<AuthStatus> {
  if (!cfg || !cfg.project || !cfg.location) return { configured: false };

  if (cfg.serviceAccountKeyPath) {
    try {
      await fsp.access(cfg.serviceAccountKeyPath, fsConstants.R_OK);
      return { configured: true, source: 'stored', label: `SA: ${path.basename(cfg.serviceAccountKeyPath)}` };
    } catch {
      return { configured: false, label: 'service account 文件不存在或不可读' };
    }
  }

  const adcPath = process.env.GOOGLE_APPLICATION_CREDENTIALS && process.env.GOOGLE_APPLICATION_CREDENTIALS !== ''
    ? process.env.GOOGLE_APPLICATION_CREDENTIALS
    : defaultAdcPath();
  try {
    await fsp.access(adcPath, fsConstants.R_OK);
    return { configured: true, source: 'environment', label: 'ADC' };
  } catch {
    return { configured: false, label: '未运行 gcloud auth application-default login' };
  }
}
