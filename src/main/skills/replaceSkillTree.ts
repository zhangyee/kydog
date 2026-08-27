import { promises as fsp, existsSync, lstatSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { assertSafeRel } from './safeRel';
import { sha256OfFile } from './sha';
import { logger } from '../log';

export interface ReplaceSkillTreeInputs {
  srcRoot: string;
  skillName: string;
  projection: Map<string, string>;
  targetDir: string;
  stagingRoot: string;
}

/**
 * 把一个 skill 的整棵投影树原子地换到 targetDir。
 *
 * 顺序是「全建好 → 全校验 → 再替换」，不要改成逐文件复制：sync 失败后应用会继续运行，
 * 半途失败留下的半英半中的树是可执行的，而且没有任何提示。
 *
 * stagingRoot 与 targetDir 必须在同一个卷上（都在 ~/.kydog 下），否则 rename 会 EXDEV。
 */
export async function replaceSkillTree(i: ReplaceSkillTreeInputs): Promise<void> {
  // 校验先一次性做完，避免校验途中中止时已经半应用
  for (const [projRel, srcRel] of i.projection) {
    assertSafeRel(projRel, 'replaceSkillTree target');
    assertSafeRel(srcRel, 'replaceSkillTree source');
  }

  await fsp.mkdir(i.stagingRoot, { recursive: true });
  const stage = path.join(i.stagingRoot, `${i.skillName}-${randomUUID()}`);
  const trash = path.join(i.stagingRoot, `.trash-${randomUUID()}`);

  try {
    // ① 完整生成
    for (const [projRel, srcRel] of i.projection) {
      const src = path.join(i.srcRoot, i.skillName, srcRel);
      const st = lstatSync(src);
      if (!st.isFile()) {
        // 软链/设备/FIFO：源在仓库里，出现即是错误，不能静默跳过
        throw new Error(`${src} is not a regular file`);
      }
      const dest = path.join(stage, projRel);
      mkdirSync(path.dirname(dest), { recursive: true });
      await fsp.copyFile(src, dest);
    }

    // ② 校验：逐个比 sha，防止复制过程中被截断
    for (const [projRel, srcRel] of i.projection) {
      const src = path.join(i.srcRoot, i.skillName, srcRel);
      const dest = path.join(stage, projRel);
      if (sha256OfFile(dest) !== sha256OfFile(src)) {
        throw new Error(`staged copy mismatch: ${i.skillName}/${projRel}`);
      }
    }

    // ③ 替换。rename 不跟随软链：targetDir 本身是软链时替换的是链而非其真身
    await fsp.mkdir(path.dirname(i.targetDir), { recursive: true });
    const hadOld = existsSync(i.targetDir);
    if (hadOld) await fsp.rename(i.targetDir, trash);
    try {
      await fsp.rename(stage, i.targetDir);
    } catch (err) {
      if (hadOld) {
        // 换回去这一步本身也可能失败（概率低，但发生时 targetDir 会两头落空）。
        // 换回失败不能盖掉原始错误，只能记日志把 trash 的位置留给人工恢复。
        try {
          await fsp.rename(trash, i.targetDir);
        } catch (rollbackErr) {
          logger.error('skills.replaceSkillTree', 'rollback rename failed, old tree stuck in trash', {
            trash, targetDir: i.targetDir, rollbackErr: String(rollbackErr),
          });
        }
      }
      throw err;
    }
    // ④ 清理旧树。fsp.rm 不跟随软链，只 unlink 链本身
    await fsp.rm(trash, { recursive: true, force: true });
  } finally {
    await fsp.rm(stage, { recursive: true, force: true }).catch(() => {});
  }
}
