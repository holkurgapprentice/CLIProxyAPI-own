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
  function openUsage(event) {
    event.preventDefault();
    event.stopPropagation();
    child=window.open('/usage-insights/','cliproxy-model-usage');
  }
  function mount() {
    const quotaLink=document.querySelector('a[href="#/quota"], a[href="#/quota/"]');
    if(quotaLink && !document.getElementById('usage-insights-nav')) {
      const link=quotaLink.cloneNode(true);
      link.id='usage-insights-nav';
      link.href='/usage-insights/';
      link.classList.remove('active');
      link.removeAttribute('aria-current');
      link.setAttribute('aria-label','Model usage');
      link.title='Model usage';
      link.innerHTML='<span class="nav-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M4 20V10m8 10V4m8 16v-7"/></svg></span><span class="nav-text"><span class="nav-label">Model usage</span></span>';
      link.onclick=openUsage;
      quotaLink.after(link);
    }
    const section=document.getElementById('usage-insights-quota-entry');
    const main=document.querySelector('main.main-content');
    if(!/^#\/quota\/?(?:\?|$)/.test(location.hash) || !main) { section?.remove(); return; }
    if(section) return;
    const entry=document.createElement('section');
    entry.id='usage-insights-quota-entry';
    entry.setAttribute('aria-label','Model usage');
    entry.style.cssText='display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;padding:16px 20px;margin:16px 0;border:1px solid var(--border-color,#ddd);border-radius:12px;background:var(--bg-secondary,transparent);color:var(--text-primary,inherit);';
    const text=document.createElement('div'), heading=document.createElement('strong'), description=document.createElement('div');
    heading.textContent='Model usage';
    description.textContent='See which models and providers serve your requests, with execution counts, cache reads and reported tokens.';
    description.style.cssText='margin-top:4px;color:var(--text-secondary,inherit);font-size:13px;';
    text.append(heading,description);
    const link=document.createElement('a');
    link.href='/usage-insights/';
    link.textContent='Open model usage';
    link.style.cssText='padding:8px 12px;border:1px solid var(--border-color,#ddd);border-radius:8px;color:var(--primary-color,inherit);text-decoration:none;white-space:nowrap;';
    link.onclick=openUsage;
    entry.append(text,link);
    const tabs=main.querySelector('[class*="QuotaPage-module__tabsRow"]');
    if(tabs) tabs.after(entry); else main.prepend(entry);
  }
  window.addEventListener('message',e=>{if(e.origin!==location.origin||e.source!==child||e.data?.type!=='usage-insights-ready')return;const vars={},style=getComputedStyle(document.documentElement);for(const name of ['--bg-primary','--bg-secondary','--text-primary','--text-secondary','--border-color','--primary-color']){const v=style.getPropertyValue(name).trim();if(v)vars[name]=v;}child.postMessage({type:'usage-insights-session',authorization,vars,theme:document.documentElement.getAttribute('data-theme')==='dark'?'dark':'light'},location.origin);});
  window.addEventListener('hashchange',()=>{if(/^#\/login/.test(location.hash)){authorization='';if(child&&!child.closed)child.postMessage({type:'usage-insights-session',authorization:''},location.origin);}});
  window.addEventListener('hashchange',mount);
  new MutationObserver(mount).observe(document.documentElement,{childList:true,subtree:true});mount();
})();
