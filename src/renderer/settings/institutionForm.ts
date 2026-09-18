import type { InstitutionPublic, InstitutionSaveArgs } from '../../shared/types';

/**
 * 「机构账号」那一块里**会出错的三个判断**，从组件里抠出来 —— 组件在这个仓库测不到
 * （vitest 跑 node 环境，没有 jsdom，也没有 React 测试库），而这三个各自都有一个
 * 具体的坏结果，且坏了之后界面看起来一切正常。
 *
 * 第二轮变异实测：把它们留在组件里时，「两个错误码的处置对调」（N17）与
 * 「没碰密码也把空串发过去」（N18）在三条 gate 下**全绿**。
 */

/** 设置页那一块的表单草稿。 */
export type InstitutionDraft = {
  name: string;
  entityID: string;
  username: string;
  /** 密码输入框里此刻的字。`pwTouched` 为 false 时它的内容不作数。 */
  password: string;
  /** 用户碰过密码框吗。**这一位决定 `password` 这个键出不出现在保存请求里。** */
  pwTouched: boolean;
};

/**
 * 组装保存请求。
 *
 * **`password` 三档，差一个键差一个密码**（`institutionService.nextPasswordEnc`）：
 * - **省略这个键** = 不动已经存下的那一份；
 * - `''` 或 `null` = 清除；
 * - 其余字符串 = 设为新值。
 *
 * 所以没碰过密码框时**不能**顺手带一个空串过去 —— 那是「把用户的密码删了」，
 * 而界面上只会显示「已保存」。
 */
export function buildSaveArgs(d: InstitutionDraft): InstitutionSaveArgs {
  const args: InstitutionSaveArgs = { name: d.name, entityID: d.entityID, username: d.username };
  if (d.pwTouched) args.password = d.password;
  return args;
}

/**
 * 「显示密码」失败之后，**那份已经存下的密码还在不在**。
 *
 * 两个码要用户做的事正相反，这是渲染层**唯一**按码分支的地方：
 * - `settings.stored_password_unreadable` —— 密文永久解不开（换了机器、钥匙串条目
 *   被删）。修钥匙串没有用，**只能重新填一次**。而 `hasPassword` 这时**仍然是 true**
 *   （`passwordEnc !== ''`），所以「有一个密码、但它已经取不出来了」这个状态光靠那个
 *   比特说不出来 —— 界面必须自己记一笔，把「已设置」换成「要重新填」。
 * - `settings.secure_storage_unavailable` —— 钥匙串这一刻不可用。**密码还在**，
 *   修好之后照常取得出来，界面不该把它说成失效。
 *
 * 判据是**码**，不是消息文字：那两句话的措辞（连同里面那个「下一步」记号）由主进程的
 * `REVEAL_NEXT_STEP` 管，渲染层原样显示，不在这边抄第二份。
 */
export function storedPasswordLost(code: string | undefined): boolean {
  return code === 'settings.stored_password_unreadable';
}

/**
 * 「保存」按钮能不能按。
 *
 * 三个标识字段缺一不可（与主进程 `checkInstitution` 同一条规矩：读路径会丢掉的记录，
 * 写的时候就该被拒，否则就是「保存成功、重启后消失」）；而且真有改动才让按 ——
 * 一个永远可按的保存按钮会让用户以为自己什么都没改却又存了一次。
 */
export function canSaveDraft(d: InstitutionDraft, current: InstitutionPublic): boolean {
  if (d.name.trim() === '' || d.entityID.trim() === '' || d.username.trim() === '') return false;
  return d.name !== (current?.name ?? '')
    || d.entityID !== (current?.entityID ?? '')
    || d.username !== (current?.username ?? '')
    || d.pwTouched;
}
