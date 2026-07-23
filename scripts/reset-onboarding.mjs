// 开发用：重置 onboarding 状态，方便反复测试首启向导。
// - kydog.json 的 onboarding.completedAt 置 null（auth/provider/项目索引不动）
// - 删除三个 harness 文件（SOUL/USER/AGENTS.md），让播种重新发生
// - 清掉残留的 seed manifest（含 .bad），确保进全新向导而非补齐界面
// 用法：npm run onboarding:reset（请先退出 KyDog，运行中的 app 会用内存缓存回写覆盖）
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ROOT = path.join(os.homedir(), '.kydog');
const SETTINGS = path.join(ROOT, 'kydog.json');

async function rmIfExists(p) {
  try { await fsp.unlink(p); return true; }
  catch (err) { if (err.code !== 'ENOENT') throw err; return false; }
}

let settings;
try {
  settings = JSON.parse(await fsp.readFile(SETTINGS, 'utf8'));
} catch (err) {
  if (err.code === 'ENOENT') {
    console.log(`未找到 ${SETTINGS}——本来就是全新状态，无需重置。`);
    process.exit(0);
  }
  throw err;
}

if (settings.onboarding?.completedAt != null) {
  settings.onboarding.completedAt = null;
  await fsp.writeFile(SETTINGS, JSON.stringify(settings, null, 2));
  console.log('onboarding.completedAt -> null');
} else {
  console.log('onboarding.completedAt 已是 null，跳过');
}

for (const name of ['SOUL.md', 'USER.md', 'AGENTS.md', '.onboarding-seed.json', '.onboarding-seed.json.bad']) {
  if (await rmIfExists(path.join(ROOT, name))) console.log(`已删除 ${name}`);
}

console.log('完成。请确认 KyDog 已退出后再启动，即可重走向导。');
