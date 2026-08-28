// src/renderer/settings/forms/OAuthForm.tsx
import { useState, type ReactNode } from 'react';
import { useLlmStore } from '../../stores/llmStore';
import { useUiStore } from '../../stores/uiStore';
import { useOAuthLoginFlow } from '../hooks/useOAuthLoginFlow';
import { ProviderRowModelPicker } from '../ProviderRowModelPicker';

const HELPER_TEXT: Record<string, string> = {
  'github-copilot': '若提示 model not supported，请在 VS Code Copilot Chat 模型选择器里启用对应模型。',
};

export function OAuthForm({ providerId }: { providerId: string }) {
  const configured = useLlmStore((s) => s.configured.find((c) => c.providerId === providerId));
  const refresh = useLlmStore((s) => s.refresh);
  const closeDetail = useUiStore((s) => s.closeSettingsDetail);
  const flow = useOAuthLoginFlow(providerId);
  const [code, setCode] = useState('');

  const isLoggedIn = !!configured?.authStatus.configured;
  const helper = HELPER_TEXT[providerId];

  if (flow.state.phase === 'success') {
    void refresh();
    flow.reset();
  }

  // 登录详情里的四块彼此独立，显示条件各管各的：
  //   select    —— 选择登录方式（Codex 的第一步，早于 auth_url）
  //   authUrl   —— 授权链接，只有 pi 真的发过 auth_url 才有
  //   manualCode—— 粘贴框
  //   progress  —— 进度行
  // 尤其 progress 不能再挂在「有授权链接」这个条件下面：device_code（Copilot 的整条登录、
  // Codex 的 headless 分支）就是退化成 progress 送过来的，而它到达时 phase 是 finishing，
  // 既没有 url 也没有粘贴框——挂在一起的话用户要抄的代码就永远不会显示。
  const authUrl = 'url' in flow.state ? flow.state.url : '';
  const progress = 'progress' in flow.state ? flow.state.progress : [];
  const showDetail =
    flow.state.phase === 'select' || flow.state.phase === 'manualCode' || !!authUrl || progress.length > 0;

  const onLogin = async () => { await flow.start(); };
  const onLogout = async () => {
    if (!confirm('确认登出？')) return;
    await window.kydog.invoke('llm.logout', { providerId });
    await refresh();
  };

  return (
    <div>
      <Section label="登录状态">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span className="font-serif italic" style={{ fontSize: 12, color: 'var(--color-ink-soft)' }}>
            {isLoggedIn ? `已登录${configured?.authStatus.label ? ` · ${configured.authStatus.label}` : ''}` :
             flow.state.phase === 'idle' ? '未登录' :
             flow.state.phase === 'select' ? '等待选择登录方式…' :
             flow.state.phase === 'authPrompt' ? '等待浏览器授权…' :
             flow.state.phase === 'manualCode' ? '等待回调码…' :
             flow.state.phase === 'finishing' ? '正在完成…' :
             flow.state.phase === 'error' ? `错误：${flow.state.error}` : ''}
          </span>
          {isLoggedIn ? (
            <button type="button" onClick={onLogout}
              className="font-sans" style={{ background: 'transparent', color: 'var(--color-accent, #a04040)', fontSize: 11 }}>
              登出
            </button>
          ) : flow.state.phase === 'idle' || flow.state.phase === 'error' ? (
            <button type="button" onClick={onLogin}
              className="font-sans bg-[color:var(--color-paper-deep)]"
              style={{ padding: '5px 12px', borderRadius: 999, fontSize: 11, border: '0.5px solid var(--color-ink-hair)' }}>
              登录
            </button>
          ) : (
            <button type="button" onClick={() => void flow.cancel()}
              className="font-sans" style={{ background: 'transparent', color: 'var(--color-accent, #a04040)', fontSize: 11 }}>
              取消
            </button>
          )}
        </div>
      </Section>

      {showDetail ? (
        <div style={{ paddingTop: 10, marginTop: -10, marginBottom: 16 }}>
          {flow.state.phase === 'select' ? (
            <>
              {/* select 早于 auth_url，此时还没有授权链接，所以这一块不带 URL 展示。 */}
              <div className="font-mono uppercase" style={{ fontSize: 9, color: 'var(--color-ink-faint)', letterSpacing: 1.2 }}>
                选择登录方式
              </div>
              {/* pi 的原文与选项措辞照抄：KyDog 不认识各家 provider 的选项含义，翻译只会失真。 */}
              <div className="font-serif italic" style={{ fontSize: 11, color: 'var(--color-ink-faint)', marginTop: 4 }}>
                {flow.state.message}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 8, marginTop: 8 }}>
                {flow.state.options.map((o) => (
                  <div key={o.id}>
                    <button type="button" onClick={() => void flow.reply(o.id)}
                      className="font-sans bg-[color:var(--color-paper-deep)]"
                      style={{ padding: '5px 12px', borderRadius: 999, fontSize: 11, border: '0.5px solid var(--color-ink-hair)' }}>
                      {o.label}
                    </button>
                    {o.description ? (
                      <div className="font-serif italic" style={{ fontSize: 10.5, color: 'var(--color-ink-faint)', marginTop: 3 }}>
                        {o.description}
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            </>
          ) : null}

          {/* 授权链接那一块整体绑在「真的有 url」上：Copilot 的第一个提问（GitHub Enterprise 域名）
              发生在任何 auth_url 之前，url 是空串，不能摆一个空盒子加两个点了没反应的按钮。 */}
          {authUrl ? (
            <>
              <div className="font-serif italic" style={{ fontSize: 11, color: 'var(--color-ink-faint)' }}>
                浏览器已打开授权页 — 完成后回到这里
              </div>
              <div className="font-mono" style={{ fontSize: 10, color: 'var(--color-ink)', background: 'var(--color-paper-deep)', padding: '6px 8px', wordBreak: 'break-all', marginTop: 6 }}>
                {authUrl}
              </div>
              <div style={{ display: 'flex', gap: 14, fontSize: 11, color: 'var(--color-ink-soft)', marginTop: 6 }}>
                <button type="button" onClick={() => navigator.clipboard.writeText(authUrl)} className="font-sans" style={{ background: 'transparent', textDecoration: 'underline' }}>复制链接</button>
                <button type="button" onClick={() => window.open(authUrl, '_blank')} className="font-sans" style={{ background: 'transparent', textDecoration: 'underline' }}>重新打开</button>
              </div>
            </>
          ) : null}

          {flow.state.phase === 'manualCode' ? (
            <div style={{ marginTop: authUrl ? 12 : 0 }}>
              <div className="font-mono uppercase" style={{ fontSize: 9, color: 'var(--color-ink-faint)', letterSpacing: 1.2 }}>
                {flow.state.prompt.message ?? '手动粘贴回调码'}
              </div>
              <input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder={flow.state.prompt.placeholder ?? '跳回失败时使用'}
                // padding 左边不能是 0，否则空输入框看不到光标（说明在 settings/ui.tsx 的 inputStyle）。
                style={{ width: '100%', marginTop: 6, padding: '6px 0 6px 2px', fontFamily: 'monospace', fontSize: 11.5, background: 'transparent', border: 'none', borderBottom: '0.5px solid var(--color-ink-hair-soft)' }}
              />
              <button type="button" onClick={async () => { await flow.reply(code); setCode(''); }}
                className="font-sans" style={{ marginTop: 6, padding: '4px 12px', borderRadius: 999, fontSize: 11, border: '0.5px solid var(--color-ink-hair)' }}>
                提交
              </button>
            </div>
          ) : null}

          {/* 进度行要能读、能抄：device_code 就是从这条通道来的，用户得把里面的代码一个字符一个字符
              敲进浏览器。所以字号按输入框来（不是脚注大小），颜色用正文色，行首那个点不参与选中。 */}
          {progress.length ? (
            <div style={{ marginTop: 10 }}>
              {progress.map((m: string, i: number) => (
                <div key={i} className="font-mono"
                  style={{ display: 'flex', gap: 6, fontSize: 11.5, color: 'var(--color-ink)', marginTop: i ? 4 : 0 }}>
                  <span aria-hidden style={{ color: 'var(--color-ink-faint)', userSelect: 'none' }}>·</span>
                  <span style={{ wordBreak: 'break-word' }}>{m}</span>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {helper ? (
        <div className="font-serif italic" style={{ fontSize: 11, color: 'var(--color-ink-faint)', padding: '6px 0', marginBottom: 12 }}>
          {helper}
        </div>
      ) : null}

      <Section label="默认模型">
        <ProviderRowModelPicker
          providerId={providerId}
          value={configured?.defaultModel ?? null}
          disabled={!isLoggedIn}
          emptyLabel={isLoggedIn ? '无可用模型' : '先登录'}
          onChange={async (m) => {
            await window.kydog.invoke('llm.setDefault', { providerId, modelId: m });
            await refresh();
          }}
        />
      </Section>

      <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '16px 0 0' }}>
        <button type="button" onClick={async () => {
          if (!confirm('从 KyDog 移除该 provider？')) return;
          await window.kydog.invoke('llm.remove', { providerId });
          await refresh();
          closeDetail();
        }} className="font-sans" style={{ background: 'transparent', color: 'var(--color-accent, #a04040)', fontSize: 11 }}>
          移除
        </button>
      </div>
    </div>
  );
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: 24, padding: '14px 0', borderTop: '0.5px solid var(--color-ink-hair-soft)', borderBottom: '0.5px solid var(--color-ink-hair-soft)', alignItems: 'flex-start' }}>
      <div style={{ width: 180, flexShrink: 0 }}>
        <div className="font-sans" style={{ fontSize: 13, color: 'var(--color-ink)', fontWeight: 500 }}>{label}</div>
      </div>
      <div style={{ flex: 1 }}>{children}</div>
    </div>
  );
}
