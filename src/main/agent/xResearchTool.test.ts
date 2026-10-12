import { KydogError } from '../../shared/errors';
import { describe, expect, it } from 'vitest';
import { fixture, post, readHtml, searchHtml, searchInput } from '../../test-support/xResearchFixture';
import { createXResearchTool } from './xResearchTool';
describe('production X SDK factory',()=>{
  it('uses actual sequential SDK signature, validation and bounded v2 details',async()=>{
    const f=fixture([searchHtml(post())]);
    const tool=createXResearchTool({browser:f.context.browser,threadId:'thread',sources:f.context.sources,currentRunId:()=> 'actual-run'});
    expect(tool).toMatchObject({name:'x_research',executionMode:'sequential'});
    const result=await tool.execute('actual-call',searchInput,undefined,undefined,{} as never);
    expect(result.details).toMatchObject({schemaVersion:2,runId:'actual-run',callId:'actual-call',browserTabId:'research-tab'});
    expect(JSON.parse((result.content[0] as any).text)).toEqual(result.details);
    await expect(tool.execute('bad',{...searchInput,read:{} } as never,undefined,undefined,{} as never)).rejects.toThrow('exactly one');
    expect(f.open).toHaveBeenCalledTimes(1);
  });
  it('rejects metadata alone over exact envelope budget before browser I/O',async()=>{
    const f=fixture([searchHtml(post())]);
    const tool=createXResearchTool({browser:f.context.browser,threadId:'thread',sources:f.context.sources,currentRunId:()=> 'run'});
    expect((await tool.execute('small',searchInput,undefined,undefined,{} as never)).details?.schemaVersion).toBe(2);
    const huge={search:{...searchInput.search,objective:'汉'.repeat(400000)}};
    await expect(tool.execute('oversize',huge,undefined,undefined,{} as never)).rejects.toThrow('request metadata exceeds 1 MiB');
    expect(f.open).toHaveBeenCalledTimes(1);
  });
  it('retains actual tab across omitted searches, clears only after proven destruction for next call',async()=>{
    const f=fixture([searchHtml(post())]);const tool=createXResearchTool({browser:f.context.browser,threadId:'thread',sources:f.context.sources,currentRunId:()=> 'run'});
    await tool.execute('first',searchInput,undefined,undefined,{} as never);await tool.execute('reuse',searchInput,undefined,undefined,{} as never);
    expect(f.open.mock.calls[1][1]).toBe('research-tab');
    f.open.mockRejectedValueOnce(new KydogError('browser.target_unusable','access failed'));
    await tool.execute('access',searchInput,undefined,undefined,{} as never);await tool.execute('stillbound',searchInput,undefined,undefined,{} as never);expect(f.open.mock.calls[3][1]).toBe('research-tab');
    f.open.mockRejectedValueOnce(new KydogError('browser.no_tab','closed'));
    const gone=await tool.execute('closed',searchInput,undefined,undefined,{} as never);expect(gone.details?.status).toBe('failed');expect(f.open).toHaveBeenCalledTimes(5);
    await tool.execute('next',searchInput,undefined,undefined,{} as never);expect(f.open.mock.calls[5][1]).toBeUndefined();
    f.open.mockRejectedValueOnce(new KydogError('browser.not_dispatchable','renderer unavailable'));
    await tool.execute('unavailable',searchInput,undefined,undefined,{} as never);await tool.execute('sameafterunavailable',searchInput,undefined,undefined,{} as never);expect(f.open.mock.calls[7][1]).toBe('research-tab');
    f.open.mockRejectedValueOnce(new KydogError('browser.no_tab','unknown explicit tab'));
    await tool.execute('unknownexplicit',{...searchInput,tabId:'missing-tab'},undefined,undefined,{} as never);await tool.execute('afterunknown',searchInput,undefined,undefined,{} as never);expect(f.open.mock.calls[9][1]).toBe('research-tab');
    await tool.execute('explicit',{...searchInput,tabId:'provided-tab'},undefined,undefined,{} as never);expect(f.open.mock.calls[10][1]).toBe('provided-tab');
  });
  it('admits six queries and all20 modest targets under exact required-state sizing',async()=>{
    const rendered=[searchHtml(post())],f=fixture(rendered);const tool=createXResearchTool({browser:f.context.browser,threadId:'thread',sources:f.context.sources,currentRunId:()=> 'run'});
    const six={search:{...searchInput.search,queries:Array.from({length:6},(_,i)=>({...searchInput.search.queries[0],id:String(i)}))}};
    expect((await tool.execute('six',six,undefined,undefined,{} as never)).details?.operation).toBe('search');
    rendered[0]=readHtml(post());
    const twenty={tabId:'research-tab',read:{objective:'ordinary targets',targets:Array.from({length:20},()=>({url:'https://x.com/alice/status/123'})),includeArticle:false,includeReplies:false}};
    const result=await tool.execute('twenty',twenty,undefined,undefined,{} as never);expect(result.details?.operation).toBe('read');expect(result.details?.status).toBe('observed');expect(f.open).toHaveBeenCalledTimes(26);
  });
  it('checks the actual generated search URL rather than a different space encoding',async()=>{
    const f=fixture([searchHtml(post())]);const tool=createXResearchTool({browser:f.context.browser,threadId:'thread',sources:f.context.sources,currentRunId:()=> 'run'});
    expect((await tool.execute('normal',searchInput,undefined,undefined,{} as never)).details?.status).toBe('partial');
    const query='a'+' '.repeat(4095);const input={search:{...searchInput.search,queries:[{...searchInput.search.queries[0],query}]}};
    const result=await tool.execute('boundary',input,undefined,undefined,{} as never);expect(result.details?.status).toBe('partial');expect(new URL(f.open.mock.calls[1][0]).searchParams.get('q')).toBe(query);
    expect(f.open.mock.calls[1][0].length).toBeLessThan(8192);
    for(const query of ['a'.repeat(4100),'汉'.repeat(4096)]) {
      await expect(tool.execute('too-large',{search:{...searchInput.search,queries:[{...searchInput.search.queries[0],query}]}},undefined,undefined,{} as never)).rejects.toThrow('shorten or split');
      expect(f.open).toHaveBeenCalledTimes(2);
    }
  });
});
