/** Offline product-wiring/resource-pressure DERIVATIONS of the deidentified
 * search-top-initial/read-thread-0/1 corpus. These are not new capture evidence.
 * Ordinary bodies exist only in these HTTP responses, never in page markup. */
import search from '../../../src/test-support/fixtures/x-network/search-top-initial.json';
import read from '../../../src/test-support/fixtures/x-network/read-thread-0.json';
import next from '../../../src/test-support/fixtures/x-network/read-thread-1.json';
export const WIRE_ROOT = 'NETWORK_ROOT_094a';
export const WIRE_PLAIN = 'NETWORK_PLAIN_205b';
export const LARGE_BODY = 'CANONICAL_FULL_START_' + '完整证据🙂'.repeat(90000) + '_CANONICAL_FULL_END';
const searchEntries = search.body.data.search_by_raw_query.search_timeline.timeline.instructions[0].entries!;
const readEntries = read.body.data.threaded_conversation_with_injections_v2.instructions.find(i=>i.type==='TimelineAddEntries')!.entries!;
const nextEntries = next.body.data.threaded_conversation_with_injections_v2.instructions[0].entries!;
const tweet = (id:string, handle:string, text:string, reply=false) => {
  const node = structuredClone(readEntries[0].content.itemContent!.tweet_results!.result);
  node.rest_id=id;node.legacy.id_str=id;node.legacy.full_text=text;
  node.legacy.conversation_id_str='321';
  node.core.user_results.result.core={screen_name:handle,name:handle};
  if(reply) (node.legacy as typeof node.legacy & {in_reply_to_status_id_str:string}).in_reply_to_status_id_str='321';
  return node;
};
export function xWireResponse(url:URL):string|null {
  if(!url.pathname.includes('/i/api/graphql/'))return null;
  const vars=JSON.parse(url.searchParams.get('variables')!);
  if(url.pathname.endsWith('/SearchTimeline')) {
    const posts = vars.rawQuery === 'pressure'
      ? [['321','reader',WIRE_ROOT], ['701','pressure',LARGE_BODY], ...Array.from({length:998},(_,i)=>[String(702+i),'pressure','RESOURCE_PRESSURE_'+(702+i)])]
      : [['321','reader',WIRE_ROOT],['700','plain',WIRE_PLAIN]];
    const entries=posts.map(([id,handle,text])=>{
      const entry=structuredClone(searchEntries[0]);
      const node=entry.content.itemContent!.tweet_results!.result!;
      node.rest_id=id;node.legacy!.id_str=id;node.legacy!.full_text=text;node.core!.user_results.result.core={screen_name:handle,name:handle};
      return entry;
    });
    return JSON.stringify({data:{search_by_raw_query:{search_timeline:{timeline:{instructions:[{type:'TimelineAddEntries',entries:[...entries,structuredClone(searchEntries.find(e=>e.content.cursorType==='Bottom')!)]}]}}}}});
  }
  const cursor=Number(String(vars.cursor??'0').split('-').at(-1)), handle=url.searchParams.get('handle')??'reader';
  const root=structuredClone(readEntries[0]);root.content.itemContent!.tweet_results!.result=tweet('321',handle,WIRE_ROOT);
  const reply=structuredClone(nextEntries[0]);
  const id=String(801+cursor);
  Object.assign(reply.content.items![0].item.itemContent.tweet_results.result, tweet(id,'reply'+id,'NETWORK_REPLY_'+id,true));
  // Recorded Bottom cursor structure, values are controlled fixture chain tokens.
  const bottom=structuredClone(readEntries.find(e=>e.content.cursorType==='Bottom')!);
  bottom.content.value='closure-'+(cursor+1);
  return JSON.stringify({data:{threaded_conversation_with_injections_v2:{instructions:[{type:'TimelineAddEntries',entries:[...(cursor?[]:[root]),...(handle==='progress'&&!cursor?[]:[reply]),bottom]}]}}});
}
export function xWireScript(handle='reader'):string {
  return `let wireCursor=0;const wireHandle=${JSON.stringify(handle)};const wireFetch=()=>fetch('/i/api/graphql/offline/TweetDetail?handle='+wireHandle+'&variables='+encodeURIComponent(JSON.stringify({focalTweetId:'321',rankingMode:'Relevance',...(wireCursor?{cursor:'closure-'+wireCursor}:{})}))).then(r=>r.json()).then(()=>{wireCursor++;});window.wireReady=wireFetch();`;
}
export function xSearchWireScript(url:URL):string {
  return `window.wireReady=fetch('/i/api/graphql/offline/SearchTimeline?variables='+encodeURIComponent(JSON.stringify(${JSON.stringify({rawQuery:url.searchParams.get('q'),product:url.searchParams.get('f')==='live'?'Latest':'Top',count:20})}))).then(r=>r.json());`;
}
