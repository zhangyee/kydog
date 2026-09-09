import { useEffect, useState, type ReactNode } from 'react';
import type { IdpEntry, IdpListPublic, InstitutionPublic } from '../../shared/types';
import { confirm } from '../stores/confirmStore';
import { filterIdps, idpRowKey } from './institutionFilter';
import { buildSaveArgs, canSaveDraft, storedPasswordLost } from './institutionForm';
import { Card, BlockHeader, SubHeader, Btn, inputStyle, labelStyle, hintStyle } from './ui';

/**
 * 「机构账号」——  CARSI 登录用的那一份（spec §4.6）。
 *
 * ## 密码只往一个方向流
 *
 * 渲染层从来拿不到密文：`institution.get` 回的 `InstitutionPublic` 里只有
 * `hasPassword` 一个比特，回整份 settings 的那四条 RPC 也已经收口成
 * `toRendererSettings`。明文唯一的出口是 `institution.revealPassword` 这条**显式往返**，
 * 而且**用完即弃** —— 取回来的字符串只活在下面那个组件局部 state 里，
 * 不进任何 zustand store、不落盘、不进日志。**别在这边开第五条出口。**
 *
 * ## 两个错误码不能合并
 *
 * `settings.secure_storage_unavailable`（钥匙串这一刻不可用：**密码还在**，
 * 修好再试一次）与 `settings.stored_password_unreadable`（密文永久解不开：
 * 修钥匙串没有用，**只能重新填一次**）—— 用户要做的事正相反。
 *
 * 消息里那句「下一步」由主进程的 `REVEAL_NEXT_STEP` 定契约，这里**原样显示**，
 * 不在渲染层再抄一份措辞：抄一份就是第二个会漂的真相，而两句话调过来是一次
 * 「把用户支使到相反方向」且码上看不出任何异常的事故。
 *
 * **按码分支的只有一件事**：解不开之后 `hasPassword` 仍然是 `true`，
 * 「有一个密码、但它已经取不出来了」这个状态光靠那个比特说不出来 —— 所以记一个
 * `pwDead`，把下面那句「已设置」换成「要重新填」。判据是**码**，不是消息文字。
 */
export function InstitutionBlock() {
  const [inst, setInst] = useState<InstitutionPublic>(null);
  const [loading, setLoading] = useState(true);

  const [name, setName] = useState('');
  const [entityID, setEntityID] = useState('');
  const [username, setUsername] = useState('');
  // 密码草稿。**`pwTouched` 为 false 时保存不带 password 字段** —— 协议上「省略」
  // 才是「不动已存的那一份」，传空串是「清除」。两者差一个字段，后果差一个密码。
  const [password, setPassword] = useState('');
  const [pwTouched, setPwTouched] = useState(false);
  const [shown, setShown] = useState(false);
  const [pwDead, setPwDead] = useState(false);

  const [idps, setIdps] = useState<IdpListPublic | null>(null);
  const [idpBusy, setIdpBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  const [query, setQuery] = useState('');

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const hydrate = (v: InstitutionPublic) => {
    setInst(v);
    setName(v?.name ?? '');
    setEntityID(v?.entityID ?? '');
    setUsername(v?.username ?? '');
    setPassword('');
    setPwTouched(false);
    setShown(false);
    setPwDead(false);
  };

  useEffect(() => {
    void (async () => {
      try { hydrate(await window.kydog.invoke('institution.get')); }
      catch (e) { setErr(String((e as Error).message)); }
      finally { setLoading(false); }
    })();
  }, []);

  const edit = (fn: () => void) => { setSaved(false); setErr(null); fn(); };

  /**
   * 机构清单**懒加载**：它是一次真网络调用（`fsso.cnki.net/idp/list`），
   * 而多数时候用户进设置页不是来换学校的。第一次展开选择器时才拉，
   * `refresh: false` 让服务优先用落盘的那份。
   */
  const loadIdps = async (refresh: boolean) => {
    setIdpBusy(true);
    setErr(null);
    try { setIdps(await window.kydog.invoke('institution.listIdps', { refresh })); }
    catch (e) { setErr(String((e as Error).message)); }
    finally { setIdpBusy(false); }
  };

  const onSave = async () => {
    setBusy(true); setErr(null);
    try {
      const args = buildSaveArgs({ name, entityID, username, password, pwTouched });
      hydrate(await window.kydog.invoke('institution.save', args));
      setSaved(true);
    } catch (e) {
      setErr(String((e as Error).message));
    } finally {
      setBusy(false);
    }
  };

  /** 清除是破坏性的（一条存好的校园账号连密码一起没了）→ 走统一的 `confirm()`。
   *  **不靠颜色警示** —— 设计系统里没有危险色 token。 */
  const onClear = async () => {
    const ok = await confirm({
      title: '清除机构账号？',
      message: `会删掉「${inst?.name ?? ''}」这条记录，连同已保存的密码。之后 AI 就没法自动登录了。`,
      confirmLabel: '清除',
    });
    if (!ok) return;
    setBusy(true); setErr(null);
    try { await window.kydog.invoke('institution.clear'); hydrate(null); }
    catch (e) { setErr(String((e as Error).message)); }
    finally { setBusy(false); }
  };

  const onToggleReveal = async () => {
    if (shown) {
      // 收起来就把明文从内存里丢掉，而不是留着只改一个 input type。
      setShown(false);
      if (!pwTouched) setPassword('');
      return;
    }
    setErr(null);
    try {
      const r = await window.kydog.invoke('institution.revealPassword');
      setPassword(r.password);
      setPwTouched(false);
      setShown(true);
      setPwDead(false);
    } catch (e) {
      // 唯一按码分支的地方：密文永久失效之后 `hasPassword` 还是 true，
      // 「有一个密码、但取不出来了」只能靠这个记下来。判据在 `institutionForm.ts`
      // （有用例；留在这里的话「两个码对调」是一个三条 gate 全绿的改动，实测过）。
      if (storedPasswordLost((e as Error & { code?: string }).code)) setPwDead(true);
      setErr(String((e as Error).message));
    }
  };

  if (loading) return null;

  const canSave = canSaveDraft({ name, entityID, username, password, pwTouched }, inst);

  return (
    <>
      <BlockHeader>机构账号</BlockHeader>
      <Card>
        <SubHeader subtitle="CARSI 统一身份认证。账号明文存在 ~/.kydog/kydog.json；密码交给系统钥匙串，只有主进程解得开，界面这边永远拿不到密文" />

        <Row label="学校 / 机构" name="institution-name" hint="登录只用 entityID；名字是存下来给你看的">
          {picking ? (
            <IdpPicker
              list={idps}
              busy={idpBusy}
              query={query}
              onQuery={setQuery}
              onRefresh={() => void loadIdps(true)}
              onCancel={() => setPicking(false)}
              onPick={(e) => edit(() => {
                // **名字与 entityID 一起存。** entityID → 名字是一对多（实测一个
                // entityID 被 127 个中科院所共用），光存 entityID 反查不出用户选的是哪家。
                setName(e.name);
                setEntityID(e.entityID);
                setPicking(false);
              })}
            />
          ) : (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flex: 1 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                {/* 显示名一律用**存下来的 `name`**，不拿 entityID 去清单里反查。 */}
                <div className="truncate" style={{ fontSize: 12.5, color: 'var(--color-ink)' }}>
                  {name || '（未选择）'}
                </div>
                {entityID && (
                  <div className="font-mono truncate" style={{ fontSize: 10, color: 'var(--color-ink-faint)', marginTop: 2 }}>
                    {entityID}
                  </div>
                )}
              </div>
              <Btn
                variant="primary"
                testId="institution-pick"
                disabled={busy}
                onClick={() => { setPicking(true); setQuery(''); if (idps === null) void loadIdps(false); }}
              >{name ? '更换' : '选择学校'}</Btn>
            </div>
          )}
        </Row>

        <Row label="账号" name="institution-username" hint="学号 / 工号，前后空格不会被悄悄去掉">
          <input
            data-testid="institution-username"
            value={username}
            placeholder="未填写"
            disabled={busy}
            onChange={(e) => edit(() => setUsername(e.target.value))}
            style={{ ...inputStyle, flex: 1 }}
          />
        </Row>

        <Row
          label="密码"
          name="institution-password"
          hint={pwDead
            ? '已保存的那份解不开了，只能重新填一次'
            : inst?.hasPassword ? '已设置。留空不动它' : '还没设置'}
        >
          <input
            data-testid="institution-password"
            type={shown ? 'text' : 'password'}
            value={password}
            placeholder={inst?.hasPassword && !pwDead ? '已保存（留空则不改）' : '未设置'}
            disabled={busy}
            onChange={(e) => edit(() => { setPassword(e.target.value); setPwTouched(true); })}
            style={{ ...inputStyle, flex: 1 }}
          />
          {inst?.hasPassword && (
            <button
              type="button"
              data-testid="institution-reveal"
              onClick={() => void onToggleReveal()}
              disabled={busy}
              className="font-sans"
              style={{ background: 'transparent', color: 'var(--color-ink-soft)', fontSize: 11, padding: '4px 0' }}
            >{shown ? '隐藏' : '显示'}</button>
          )}
        </Row>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 16 }}>
          <Btn variant="primary" testId="institution-save" disabled={busy || !canSave} onClick={() => void onSave()}>
            {busy ? '保存中…' : '保存'}
          </Btn>
          {inst && (
            // 破坏性操作走 confirm()，**不用 danger 变体**（那是红的）。
            <Btn variant="secondary" testId="institution-clear" disabled={busy} onClick={() => void onClear()}>
              清除
            </Btn>
          )}
          {saved && (
            <span data-testid="institution-saved" className="font-serif italic" style={{ fontSize: 11, color: 'var(--color-ink-soft)' }}>
              已保存
            </span>
          )}
        </div>

        {err && (
          // **不用危险色**：设计系统里没有红色 token。靠一条竖线与斜体把它与正文分开。
          <div
            data-testid="institution-error"
            className="font-serif"
            style={{
              marginTop: 10, fontSize: 11.5, lineHeight: 1.6,
              color: 'var(--color-ink)',
              borderLeft: '2px solid var(--color-ink-hair)',
              paddingLeft: 10,
            }}
          >{err}</div>
        )}
      </Card>
    </>
  );
}

function Row({ label, name, hint, children }: {
  label: string; name: string; hint: string; children: ReactNode;
}) {
  return (
    <div
      data-testid={`institution-row-${name}`}
      style={{ display: 'flex', gap: 24, padding: '14px 0', borderTop: '0.5px solid var(--color-ink-hair-soft)', alignItems: 'flex-start' }}
    >
      <div style={{ width: 200, flexShrink: 0 }}>
        <div style={labelStyle}>{label}</div>
        <div style={hintStyle}>{hint}</div>
      </div>
      <div style={{ flex: 1, display: 'flex', gap: 8, alignItems: 'center', minWidth: 0 }}>{children}</div>
    </div>
  );
}

/**
 * 机构选择器。
 *
 * 清单**每个 SP 一份**，不存在全局 CARSI 清单；抓不到时服务会回落到落盘的旧清单 ——
 * 所以「哪天抓的、是不是回落的」必须摆在用户眼前（`IdpListPublic` 的 `fetchedAt` /
 * `stale`）。一份空 `entries` 在界面上等于「这个源一个机构都没有」，与「我没抓到」
 * 长得一样，那正是这两个字段存在的理由。
 *
 * 筛选规则与「为什么不做重名消歧」见 `institutionFilter.ts`。
 */
function IdpPicker({ list, busy, query, onQuery, onPick, onRefresh, onCancel }: {
  list: IdpListPublic | null;
  busy: boolean;
  query: string;
  onQuery: (q: string) => void;
  onPick: (e: IdpEntry) => void;
  onRefresh: () => void;
  onCancel: () => void;
}) {
  const rows = list === null ? [] : filterIdps(list.entries, query);
  return (
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input
          data-testid="institution-search"
          autoFocus
          value={query}
          placeholder="学校名，或者 pku / tsinghua 这样的字母"
          onChange={(e) => onQuery(e.target.value)}
          style={{ ...inputStyle, flex: 1 }}
        />
        <Btn variant="secondary" testId="institution-idp-refresh" disabled={busy} onClick={onRefresh}>
          {busy ? '拉取中…' : '刷新清单'}
        </Btn>
        <Btn variant="secondary" onClick={onCancel}>取消</Btn>
      </div>

      {list !== null && (
        <div className="font-serif italic" style={{ fontSize: 10.5, color: 'var(--color-ink-faint)', marginTop: 6 }}>
          {`共 ${list.entries.length} 所 · 清单抓取于 ${list.fetchedAt}`}
          {list.stale && ' · 这一份来自本机缓存，不是刚抓的'}
        </div>
      )}

      <div
        data-testid="institution-idp-list"
        style={{
          marginTop: 6, maxHeight: 260, overflowY: 'auto',
          border: '0.5px solid var(--color-ink-hair-soft)', borderRadius: 4,
        }}
      >
        {busy && list === null && (
          <div style={{ padding: '10px 12px', fontSize: 11.5, color: 'var(--color-ink-soft)' }}>装载中…</div>
        )}
        {list !== null && rows.length === 0 && (
          <div className="font-serif italic" style={{ padding: '10px 12px', fontSize: 11.5, color: 'var(--color-ink-faint)' }}>
            没有匹配的学校。换个说法试试，或者先「刷新清单」。
          </div>
        )}
        {rows.map((e, i) => (
          // key 不能用 entityID —— 实测一个 entityID 被 127 个中科院所共用。
          <button
            key={idpRowKey(e, i)}
            type="button"
            onClick={() => onPick(e)}
            className="w-full text-left hover:bg-[color:var(--color-hover-bg)]"
            style={{ display: 'block', padding: '6px 12px', background: 'transparent' }}
          >
            <div style={{ fontSize: 12, color: 'var(--color-ink)' }}>{e.name}</div>
            <div className="font-mono truncate" style={{ fontSize: 9.5, color: 'var(--color-ink-faint)' }}>{e.entityID}</div>
          </button>
        ))}
      </div>
    </div>
  );
}
