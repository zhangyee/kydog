// src/renderer/settings/hooks/useOAuthLoginFlow.ts
import { useEffect, useRef, useState } from 'react';

export type OAuthFlowState =
  | { phase: 'idle' }
  | { phase: 'authPrompt'; url: string; instructions?: string; progress: string[] }
  | { phase: 'manualCode'; url: string; instructions?: string; prompt: { message: string; placeholder?: string }; progress: string[] }
  | { phase: 'finishing'; progress: string[] }
  | { phase: 'error'; error: string }
  | { phase: 'success' };

export function useOAuthLoginFlow(providerId: string) {
  const [state, setState] = useState<OAuthFlowState>({ phase: 'idle' });
  const lastUrl = useRef<string>('');

  useEffect(() => {
    const offs: Array<() => void> = [];
    offs.push(window.kydog.on('oauth.auth', (p) => {
      if (p.providerId !== providerId) return;
      lastUrl.current = p.url;
      setState({ phase: 'authPrompt', url: p.url, instructions: p.instructions, progress: [] });
    }));
    offs.push(window.kydog.on('oauth.progress', (p) => {
      if (p.providerId !== providerId) return;
      setState((s) => 'progress' in s ? { ...s, progress: [...s.progress, p.message] } : s);
    }));
    offs.push(window.kydog.on('oauth.prompt', (p) => {
      if (p.providerId !== providerId) return;
      setState((s) => ({
        phase: 'manualCode',
        url: 'url' in s ? s.url : lastUrl.current,
        instructions: 'instructions' in s ? s.instructions : undefined,
        prompt: p.prompt,
        progress: 'progress' in s ? s.progress : [],
      }));
    }));
    offs.push(window.kydog.on('oauth.success', (p) => {
      if (p.providerId !== providerId) return;
      setState({ phase: 'success' });
    }));
    offs.push(window.kydog.on('oauth.error', (p) => {
      if (p.providerId !== providerId) return;
      setState({ phase: 'error', error: p.error });
    }));
    return () => offs.forEach((off) => off());
  }, [providerId]);

  const start = async () => {
    setState({ phase: 'finishing', progress: [] });
    try { await window.kydog.invoke('llm.login', { providerId }); }
    catch (err) { setState({ phase: 'error', error: (err as Error).message }); }
  };
  const cancel = async () => {
    await window.kydog.invoke('llm.loginCancel', { providerId });
    setState({ phase: 'idle' });
  };
  const reply = async (value: string) => {
    await window.kydog.invoke('llm.loginPromptReply', { providerId, value });
    setState((s) => 'progress' in s ? { ...s, phase: 'finishing' as const, progress: s.progress } : { phase: 'finishing', progress: [] });
  };
  const reset = () => setState({ phase: 'idle' });

  return { state, start, cancel, reply, reset };
}
