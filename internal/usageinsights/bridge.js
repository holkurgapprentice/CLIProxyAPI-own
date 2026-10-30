/* Add a fork-owned navigation entry without changing the downloaded console. */
(() => {
  'use strict';
  let authorization='', child=null;
  const originalFetch=window.fetch;
  function capture(url,headers){try{const u=new URL(url,location.href);if(u.origin!==location.origin||!/^\/v(?:0|8)\/management\//.test(u.pathname))return;const auth=new Headers(headers).get('Authorization');if(auth&&/^Bearer\s+\S+/i.test(auth))authorization=auth;}catch{/* Ignore non-URL requests. */}}
  window.fetch=function(input,init){capture(input instanceof Request?input.url:input,init?.headers||(input instanceof Request?input.headers:undefined));return originalFetch.apply(this,arguments);};
  const open=XMLHttpRequest.prototype.open,set=XMLHttpRequest.prototype.setRequestHeader,urls=new WeakMap();
  XMLHttpRequest.prototype.open=function(method,url){urls.set(this,url);return open.apply(this,arguments);};
  XMLHttpRequest.prototype.setRequestHeader=function(name,value){if(name.toLowerCase()==='authorization')capture(urls.get(this),{Authorization:value});return set.apply(this,arguments);};
  function mount(){if(document.getElementById('usage-insights-nav'))return;const nav=document.querySelector('aside nav, nav.sidebar-nav, [class*="sidebar"] nav, aside, nav');if(!nav)return;const a=document.createElement('a');a.id='usage-insights-nav';a.href='/usage-insights/';a.textContent='Model usage';a.style.cssText='display:block;padding:10px 16px;color:var(--text-secondary,inherit);font:inherit;text-decoration:none;';a.onclick=e=>{e.preventDefault();child=window.open('/usage-insights/','cliproxy-model-usage');};nav.append(a);}
  window.addEventListener('message',e=>{if(e.origin!==location.origin||e.source!==child||e.data?.type!=='usage-insights-ready')return;const vars={},style=getComputedStyle(document.documentElement);for(const name of ['--bg-primary','--bg-secondary','--text-primary','--text-secondary','--border-color','--primary-color']){const v=style.getPropertyValue(name).trim();if(v)vars[name]=v;}child.postMessage({type:'usage-insights-session',authorization,vars,theme:document.documentElement.getAttribute('data-theme')==='dark'?'dark':'light'},location.origin);});
  window.addEventListener('hashchange',()=>{if(/^#\/login/.test(location.hash)){authorization='';if(child&&!child.closed)child.postMessage({type:'usage-insights-session',authorization:''},location.origin);}});
  new MutationObserver(mount).observe(document.documentElement,{childList:true,subtree:true});mount();
})();
