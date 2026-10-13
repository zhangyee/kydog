/** Offline DOM uses only the production collector's source-verified semantics.
 * No GraphQL oracle: unique bodies exist only in these rendered nodes. */
const author = (handle: string) => `<div data-testid="User-Name"><a href="/${handle}">@${handle}</a></div>`;
const post = (handle: string, id: string, body: string, extra = '') => `<article data-testid="tweet">${author(handle)}<a href="/${handle}/status/${id}"><time>today</time></a><div data-testid="tweetText">${body}</div>${extra}</article>`;
const card = `<div id="entry" role="link" tabindex="0">${author('writer')}<div data-testid="article-cover-image">PREVIEW_ONLY_6f91</div></div>`;
const articleDocument = `<article data-testid="tweet">${author('writer')}<article data-testid="twitterArticleReadView"><div role="group"><div><a role="link" href="/writer/status/654/analytics">views</a></div></div><div data-testid="twitter-article-title">Independent Article</div><div data-testid="twitterArticleRichTextView"><div data-testid="longformRichTextComponent" contenteditable="false"><div data-block="true">ARTICLE_BODY_DOM_a751</div><p data-block="true"><a href="https://example.org/observed-external">https://example.org/observed-external</a></p></div></div></article></article>`;
const quote = `<div role="link" tabindex="0">${author('quoted')}<a href="/quoted/status/456"><time>today</time></a><div data-testid="tweetText">QUOTE_DOM_c315</div></div>`;
const shell = (body: string, script = '') => `<!doctype html><meta charset="utf-8"><style>body{margin:24px;font:16px sans-serif}button{padding:12px}#entry{padding:16px;border:1px solid;cursor:pointer}</style>${body}<script>${script}</script>`;
const primary = (body: string) => `<main><div data-testid="primaryColumn">${body}</div></main>`;
export function xClosurePage(url: URL, loggedIn: boolean): string {
  if (url.hostname !== 'x.com') return shell('<h1>EXTERNAL_DOM_8b2e</h1>');
  if (!loggedIn) return shell('<div role="dialog"><input name="username_or_email" type="text" autocomplete="username webauthn"><input name="password" type="password"><button id="fixtureLogin">Confirm fixture login</button></div>', `fixtureLogin.onclick=async e=>{if(e.isTrusted){await fetch('/fixture-login',{method:'POST'});document.body.dataset.fixtureConfirmed='true'}};`);
  if (url.pathname === '/search') return shell(primary(`<div role="tab" aria-selected="true">${url.searchParams.get('f') === 'live' ? 'Latest' : 'Top'}</div>${post('reader', '321', 'ROOT_DOM_094a', card + quote)}${post('plain', '700', 'PLAIN_DOM_205b')}`));
  if (url.pathname === '/writer/status/654') return shell('<main>'+articleDocument+'</main>');
  if (url.pathname === '/quoted/status/456') return shell(primary(`<div aria-label="Timeline: Conversation">${post('quoted', '456', 'QUOTE_FULL_DOM_d428')}</div>`));
  return shell(primary(`<div aria-label="Timeline: Conversation">${post('reader', '321', 'ROOT_DOM_094a', '<button id="bodyMore" role="button" type="button" data-testid="tweet-text-show-more-link">Show more</button>' + card + quote)}${post('first', '801', 'REPLY_FIRST_DOM_e539')}<div data-testid="cellInnerDiv"><button id="replyMore" role="button" type="button">Show replies</button></div></div>`) + '<div style="height:1800px"></div>', `
const record=kind=>{const facts=JSON.parse(sessionStorage.getItem('nativeActions')||'[]');facts.push(kind);sessionStorage.setItem('nativeActions',JSON.stringify(facts));};
document.addEventListener('scroll',e=>{if(e.isTrusted&&e.target===document){record('scroll');requestAnimationFrame(()=>record('scroll-frame'));}});
document.addEventListener('click',e=>{if(!e.isTrusted)return;
if(e.target.closest('#bodyMore')){record('body');document.querySelector('[data-testid="tweetText"]').textContent='ROOT_FULL_DOM_f640';bodyMore.remove();}
if(e.target.closest('#entry')){record('article');history.pushState({},'', '/writer/status/654');document.querySelector('main').innerHTML='${articleDocument}';}
if(e.target.closest('#replyMore')){record('replies');replyMore.closest('[data-testid="cellInnerDiv"]').outerHTML='${post('second', '802', 'REPLY_EXPANDED_DOM_b862')}';}
});`);
}
