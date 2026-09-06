import { promises as fsp } from 'node:fs';
import { KydogError } from '../../shared/errors';
import { sidecarPath } from '../../shared/pdfSidecar';
import { validateTranslatedDoc, type TranslatedDoc } from '../../shared/zhSidecar';
import { isErrno } from './fsGuard';
import { atomicWrite } from '../persist/atomicWrite';
import { resolveActive } from '../agent/resolveActive';
import { getProviderRegistry } from '../llm/providerRegistry';
import type { ProviderId } from '../../shared/types';

export const pdfTranslation = {
  /** ENOENT 归 null（还没翻译过）；其他读错误照抛。 */
  async load({ pdfPath }: { pdfPath: string }): Promise<{ doc: TranslatedDoc | null }> {
    const file = sidecarPath(pdfPath, 'zh');
    let text: string;
    try {
      text = await fsp.readFile(file, 'utf8');
    } catch (err) {
      if (isErrno(err) && err.code === 'ENOENT') return { doc: null };
      throw new KydogError('fs.read_failed', `无法读取 ${file}`, err);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (err) {
      throw new KydogError('pdf.translation_invalid', `${file} 不是合法 JSON：${(err as Error).message}`, err);
    }
    return { doc: validateTranslatedDoc(raw, file) };
  },

  /**
   * 作业开始钉一次模型。传当前会话 id 就是会话模型；传 null / 该 thread 已不存在时
   * resolveActive 内部 override 为 undefined，自然落到全局默认——一行分支都不用加。
   *
   * 这里**立刻 getModel 校验一次**：否则设置里留着一个已经不存在的 model id 时，用户要先等
   * 抽完整份 PDF（几百页几十秒）才在第一页调用上看到「没有可用的模型」。
   */
  async resolveModel({ threadId }: { threadId: string | null }):
    Promise<{ providerId: ProviderId; modelId: string; runtimeRevision: number }> {
    let providerId: ProviderId; let modelId: string;
    try {
      ({ providerId, modelId } = await resolveActive(threadId ?? '', ''));
    } catch (err) {
      throw new KydogError('llm.not_configured', '没有可用的模型，请先在设置里配置', err);
    }
    const reg = getProviderRegistry();
    if (!reg.modelRuntime.getModel(providerId, modelId)) {
      throw new KydogError('llm.not_configured', `没有可用的模型 ${providerId}/${modelId}`);
    }
    return { providerId, modelId, runtimeRevision: reg.runtimeRevision };
  },

  /** 写盘方自己校验，不信任调用方。同 pdfAnnotations.save 的形状，只是多一道校验。 */
  async save({ pdfPath, doc }: { pdfPath: string; doc: TranslatedDoc }): Promise<void> {
    const file = sidecarPath(pdfPath, 'zh');
    validateTranslatedDoc(doc, file);
    try {
      await atomicWrite(file, JSON.stringify(doc, null, 2) + '\n');
    } catch (err) {
      throw new KydogError('fs.write_failed', `无法写入 ${file}`, err);
    }
  },

  /**
   * 删掉译文边车（spec 2026-09-06 §6）。ENOENT 当成功——删两次不报错；其它错误按写失败抛
   * （删除是写操作，不新增错误码）。路径只由 sidecarPath 推导，同 load / save。
   */
  async delete({ pdfPath }: { pdfPath: string }): Promise<void> {
    const file = sidecarPath(pdfPath, 'zh');
    try {
      await fsp.unlink(file);
    } catch (err) {
      if (isErrno(err) && err.code === 'ENOENT') return;
      throw new KydogError('fs.write_failed', `无法删除 ${file}`, err);
    }
  },
};
