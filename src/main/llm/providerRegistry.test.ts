import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as paths from '../persist/paths';
import { ensureSettingsFile } from '../persist/settingsFile';
import { SettingsService } from '../settings/settingsService';
import { logger } from '../log';
import {
  ProviderRegistry, buildModelRuntimeOptions,
  setCatalogRefreshedHook, initProviderRegistry, getProviderRegistry, _resetProviderRegistryForTest,
} from './providerRegistry';

/** 让已 attach 的 .catch / unhandledRejection 有机会跑完。 */
const flush = () => new Promise<void>((r) => setImmediate(r));

describe('ProviderRegistry', () => {
  let dir: string;
  let svc: SettingsService;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'kydog-reg-'));
    vi.spyOn(paths, 'ROOT', 'get').mockReturnValue(dir);
    vi.spyOn(paths, 'SETTINGS_FILE', 'get').mockReturnValue(path.join(dir, 'kydog.json'));
    vi.spyOn(paths, 'LOCK_PATH', 'get').mockReturnValue(path.join(dir, '.kydog.json.lock'));
    ensureSettingsFile();
    svc = new SettingsService();
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });

  it('build: 空 settings → registry 可用', async () => {
    const reg = await ProviderRegistry.build(svc);
    expect(reg.modelRuntime).toBeDefined();
  });

  it('build: customProviders 注册到 modelRuntime', async () => {
    await svc.update({ llm: {
      ...(await svc.get()).llm,
      customProviders: [{
        id: 'ollama-x', displayName: 'Ollama', baseUrl: 'http://localhost:11434/v1',
        api: 'openai-completions', apiKey: 'ollama',
        models: [{ id: 'llama3.1:8b' }],
      }],
    } });
    const reg = await ProviderRegistry.build(svc);
    const found = reg.modelRuntime.getModel('ollama-x', 'llama3.1:8b');
    expect(found).toBeDefined();
  });

  it('refreshAfterProviderChange: 重建 modelRuntime', async () => {
    const reg = await ProviderRegistry.build(svc);
    const before = reg.modelRuntime;
    await svc.update({ llm: {
      ...(await svc.get()).llm,
      customProviders: [{
        id: 'new-cp', displayName: 'X', baseUrl: 'http://x', api: 'openai-completions',
        apiKey: 'k', models: [{ id: 'm' }],
      }],
    } });
    const fakeAgent = { invalidateSessionsForProviders: vi.fn().mockResolvedValue(undefined) };
    await reg.refreshAfterProviderChange(svc, fakeAgent as any, ['new-cp']);
    expect(reg.modelRuntime).not.toBe(before);
    expect(fakeAgent.invalidateSessionsForProviders).toHaveBeenCalledWith(['new-cp']);
    expect(reg.modelRuntime.getModel('new-cp', 'm')).toBeDefined();
  });

  // 守 f96afc7 的成果：不传 modelsPath 时 pi 默认写 ~/.pi/agent/models-store.json，
  // 等于把刚拆掉的耦合重建出来。选项抽成纯函数才能确定性地断言，不依赖真实 home。
  it('modelsPath 落在 <ROOT>/agent 下，不碰 ~/.pi', () => {
    const opts = buildModelRuntimeOptions(svc);
    expect(opts.modelsPath).toBe(path.join(dir, 'agent', 'models.json'));
    expect(opts.modelsPath.split(path.sep)).not.toContain('.pi');
  });

  // 后台刷新用的就是 `refresh()` 这个调用形状，而不是 `refresh({ allowNetwork: true })`。
  // ModelRuntime.refresh 里是 `options.allowNetwork ?? modelNetworkEnabled`
  // （model-runtime.js:369，modelNetworkEnabled = PI_OFFLINE 未设），显式传 true 会把
  // PI_OFFLINE 盖掉、单测真去联网。两段都 await，不靠等；后半段同时证明这条链路是通的
  // —— 线上（PI_OFFLINE 未设）后台那次 refresh() 确实会去拉远程目录，没被这次改动改哑。
  // 凭据是必需的：没凭据 pi-ai 在 models.js:87-89 就 return 了，走不到网络分支。
  it('refresh() 的联网与否交给 PI_OFFLINE，显式 allowNetwork 会盖掉它', async () => {
    await svc.update({ llm: {
      ...(await svc.get()).llm,
      auth: { anthropic: { type: 'api_key', key: 'sk-test-not-real' } },
    } });
    const reg = await ProviderRegistry.build(svc);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }),
    );

    await reg.modelRuntime.refresh();
    expect(fetchSpy).not.toHaveBeenCalled();

    await reg.modelRuntime.refresh({ allowNetwork: true });
    expect(fetchSpy.mock.calls.map((c) => String(c[0])))
      .toContainEqual(expect.stringContaining('/api/models/providers/'));
  });

  // ── 启动不能卡在网络上 ────────────────────────────────────────────────
  // 上游契约（model-runtime.js:74-80）：create() 只在 allowModelNetwork === true 时
  // 才 await 一次带 15s abort 预算的目录拉取。initProviderRegistry 排在
  // installDispatcher / createWindow 之前，所以那次 await 直接等于白屏。
  // 下面的假 runtime 把这条契约原样照抄，网络设成黑洞（永不 settle）。
  describe('目录刷新不阻塞 build（假 runtime 复刻上游 create() 契约）', () => {
    let createOpts: { allowModelNetwork?: boolean } | undefined;

    function mockPi(rt: Record<string, unknown>): void {
      createOpts = undefined;
      vi.doMock('@earendil-works/pi-coding-agent', () => ({
        ModelRuntime: {
          create: async (opts: { allowModelNetwork?: boolean }) => {
            createOpts = opts;
            if (opts?.allowModelNetwork === true) await new Promise(() => {}); // 黑洞网络
            return rt;
          },
        },
      }));
    }

    function fakeRuntime(refresh = vi.fn().mockResolvedValue({ aborted: false, errors: new Map() })) {
      return { registerProvider: vi.fn(), refresh };
    }

    beforeEach(async () => {
      await svc.update({ llm: {
        ...(await svc.get()).llm,
        customProviders: [{
          id: 'cp', displayName: 'CP', baseUrl: 'http://x', api: 'openai-completions',
          apiKey: 'k', models: [{ id: 'm' }],
        }],
      } });
    });
    afterEach(() => {
      vi.doUnmock('@earendil-works/pi-coding-agent');
      setCatalogRefreshedHook(undefined);
      _resetProviderRegistryForTest();
    });

    it('网络黑洞时 build 仍然立刻返回', async () => {
      mockPi(fakeRuntime());
      const outcome = await Promise.race([
        ProviderRegistry.build(svc).then(() => 'returned'),
        new Promise<string>((r) => { setTimeout(() => r('被网络挂住了'), 1_000).unref?.(); }),
      ]);
      expect(outcome).toBe('returned');
      expect(createOpts?.allowModelNetwork).not.toBe(true);
    });

    // 刷新由 initProviderRegistry 在 _instance 落位之后起，不在 build() 里 ——
    // 见 startCatalogRefresh() 的注释：钩子回调要走 getProviderRegistry()。
    it('刷新照旧发生，且排在 provider 注册之后（否则看不到自定义 provider）', async () => {
      const rt = fakeRuntime();
      mockPi(rt);
      await initProviderRegistry(svc);
      expect(rt.refresh).toHaveBeenCalledTimes(1);
      // 不带参数 —— 上一条测试证明了这正是让 PI_OFFLINE 继续生效的调用形状。
      expect(rt.refresh).toHaveBeenCalledWith();
      expect(rt.registerProvider).toHaveBeenCalledWith('cp', expect.anything());
      expect(rt.registerProvider.mock.invocationCallOrder[0])
        .toBeLessThan(rt.refresh.mock.invocationCallOrder[0]);
    });

    // 这个钩子是渲染层唯一能知道「后台目录拉完了」的途径：create() 拿到的是内置静态清单，
    // 远端目录几秒后才落地，而 llm.* 全是请求-响应，没人推就只能等用户下一次动作。
    it('后台刷新落地后触发目录通知钩子', async () => {
      mockPi(fakeRuntime());
      const hook = vi.fn();
      setCatalogRefreshedHook(hook);
      await initProviderRegistry(svc);
      await flush();
      expect(hook).toHaveBeenCalledTimes(1);
    });

    // 这条守的是本次改动的理由本身：refresh 立刻 resolve 时钩子也不能早于 _instance 落位，
    // 否则钩子里的 getProviderRegistry() 会抛，广播静默丢掉——而 fakeRuntime 的 refresh
    // 正是「立刻 resolve」，真实的那个要读文件，靠它慢就是在赌时序。
    it('钩子触发时 registry 已经可达（不靠 refresh 比 build 慢）', async () => {
      mockPi(fakeRuntime());
      let reachable: boolean | undefined;
      setCatalogRefreshedHook(() => {
        try { reachable = !!getProviderRegistry(); } catch { reachable = false; }
      });
      await initProviderRegistry(svc);
      await flush();
      expect(reachable).toBe(true);
    });

    it('刷新失败不触发钩子——目录没变，广播出去只是让渲染层白读一次同样的清单', async () => {
      vi.spyOn(logger, 'warn').mockImplementation(() => {});
      mockPi(fakeRuntime(vi.fn().mockRejectedValue(new Error('boom'))));
      const hook = vi.fn();
      setCatalogRefreshedHook(hook);
      await initProviderRegistry(svc);
      await flush();
      await flush();
      expect(hook).not.toHaveBeenCalled();
    });

    it('刷新失败只落一条 warn，不冒未处理拒绝', async () => {
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      const unhandled = vi.fn();
      process.on('unhandledRejection', unhandled);
      try {
        mockPi(fakeRuntime(vi.fn().mockRejectedValue(new Error('boom'))));
        await expect(initProviderRegistry(svc)).resolves.toBeDefined();
        await flush();
        await flush();
      } finally {
        process.off('unhandledRejection', unhandled);
      }
      expect(unhandled).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith('llm', expect.stringContaining('refresh'), expect.anything());
    });
  });
});
