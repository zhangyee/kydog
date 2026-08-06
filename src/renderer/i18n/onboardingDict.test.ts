import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { onboardingDict } from './onboardingDict';

// __dirname 是 src/renderer/i18n/，向上两层是 src/。
const PRIVACY_MD = readFileSync(path.resolve(__dirname, '..', '..', 'about', 'privacy.md'), 'utf8');

/** 面板在关于页底部，不是独立的设置页。写成「设置 → 隐私与统计」就是给用户一条走不通的路。 */
const PRIVACY_PATH = '设置 → 关于 → 隐私与统计';

const LOCALES = ['zh', 'en'] as const;

describe('onboarding 统计文案与隐私说明的一致性', () => {
  it('隐私说明本身用的就是这条路径（下面两条断言的锚点）', () => {
    expect(PRIVACY_MD).toContain(PRIVACY_PATH);
  });

  it.each(LOCALES)('%s 文案指向同一条可走通的路径', (locale) => {
    expect(onboardingDict[locale].telemetryBody).toContain(PRIVACY_PATH);
  });

  it.each(LOCALES)('%s 文案给的服务端仓库与隐私说明是同一个', (locale) => {
    // privacy.md 里是带 scheme 的 <https://…>，向导文案里是裸域名，取仓库路径本身比较。
    const m = PRIVACY_MD.match(/https:\/\/(github\.com\/[\w.-]+\/[\w.-]+)/);
    expect(m, 'privacy.md 里找不到服务端仓库地址').not.toBeNull();
    expect(onboardingDict[locale].telemetryBody).toContain(m![1]);
  });

  it('中文文案的频率措辞与隐私说明一致', () => {
    expect(PRIVACY_MD).toContain('每天至多一次');
    expect(onboardingDict.zh.telemetryBody).toContain('每天至多一次');
  });
});
