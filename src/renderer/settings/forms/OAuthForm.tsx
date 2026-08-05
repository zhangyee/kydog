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

      {flow.state.phase === 'select' && (
        <div style={{ paddingTop: 10, marginTop: -10, marginBottom: 16 }}>
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
          {flow.state.progress.length ? (
            <div className="font-mono" style={{ fontSize: 10, color: 'var(--color-ink-soft)', marginTop: 10 }}>
              {flow.state.progress.map((m: string, i: number) => <div key={i}>· {m}</div>)}
            </div>
          ) : null}
        </div>
      )}

      {(flow.state.phase === 'authPrompt' || flow.state.phase === 'manualCode') && (
        <div style={{ paddingTop: 10, marginTop: -10, marginBottom: 16 }}>
          <div className="font-serif italic" style={{ fontSize: 11, color: 'var(--color-ink-faint)' }}>
            浏览器已打开授权页 — 完成后回到这里
          </div>
          <div className="font-mono" style={{ fontSize: 10, color: 'var(--color-ink)', background: 'var(--color-paper-deep)', padding: '6px 8px', wordBreak: 'break-all', marginTop: 6 }}>
            {(flow.state as { url: string }).url}
          </div>
          <div style={{ display: 'flex', gap: 14, fontSize: 11, color: 'var(--color-ink-soft)', marginTop: 6 }}>
            <button type="button" onClick={() => navigator.clipboard.writeText((flow.state as { url: string }).url)} className="font-sans" style={{ background: 'transparent', textDecoration: 'underline' }}>复制链接</button>
            <button type="button" onClick={() => window.open((flow.state as { url: string }).url, '_blank')} className="font-sans" style={{ background: 'transparent', textDecoration: 'underline' }}>重新打开</button>
          </div>

          {flow.state.phase === 'manualCode' ? (
            <div style={{ marginTop: 12 }}>
              <div className="font-mono uppercase" style={{ fontSize: 9, color: 'var(--color-ink-faint)', letterSpacing: 1.2 }}>
                {flow.state.prompt.message ?? '手动粘贴回调码'}
              </div>
              <input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder={flow.state.prompt.placeholder ?? '跳回失败时使用'}
                style={{ width: '100%', marginTop: 6, padding: '6px 0', fontFamily: 'monospace', fontSize: 11.5, background: 'transparent', border: 'none', borderBottom: '0.5px solid var(--color-ink-hair-soft)' }}
              />
              <button type="button" onClick={async () => { await flow.reply(code); setCode(''); }}
                className="font-sans" style={{ marginTop: 6, padding: '4px 12px', borderRadius: 999, fontSize: 11, border: '0.5px solid var(--color-ink-hair)' }}>
                提交
              </button>
            </div>
          ) : null}

          {'progress' in flow.state && flow.state.progress.length ? (
            <div className="font-mono" style={{ fontSize: 10, color: 'var(--color-ink-soft)', marginTop: 10 }}>
              {flow.state.progress.map((m: string, i: number) => <div key={i}>· {m}</div>)}
            </div>
          ) : null}
        </div>
      )}

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
