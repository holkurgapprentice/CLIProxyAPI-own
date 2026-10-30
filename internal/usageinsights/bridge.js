/* Add a fork-owned navigation entry without changing the downloaded console. */
(() => {
  'use strict';
  let authorization='', frame=null, lastSession='';
  const usageRoute = '#/quota?view=model-usage';
  const isUsage = () => /^#\/quota\/?\?/.test(location.hash) && new URLSearchParams(location.hash.split('?')[1]).get('view') === 'model-usage';
  let restoreInitialView=isUsage();
  document.addEventListener('click',event=>{if(event.target.closest?.('a'))restoreInitialView=false;},true);
  const originalFetch=window.fetch;
  function capture(url,headers){try{const u=new URL(url,location.href);if(u.origin!==location.origin||!/^\/v(?:0|8)\/management\//.test(u.pathname))return;const auth=new Headers(headers).get('Authorization');if(auth&&/^Bearer\s+\S+/i.test(auth)){authorization=auth;sendSession();}}catch{/* Ignore non-URL requests. */}}
  window.fetch=function(input,init){capture(input instanceof Request?input.url:input,init?.headers||(input instanceof Request?input.headers:undefined));return originalFetch.apply(this,arguments);};
  const open=XMLHttpRequest.prototype.open,set=XMLHttpRequest.prototype.setRequestHeader,urls=new WeakMap();
  XMLHttpRequest.prototype.open=function(method,url){urls.set(this,url);return open.apply(this,arguments);};
  XMLHttpRequest.prototype.setRequestHeader=function(name,value){if(name.toLowerCase()==='authorization')capture(urls.get(this),{Authorization:value});return set.apply(this,arguments);};
  function sendSession(force=false) {
    if(!frame?.contentWindow) return;
    const vars={}, style=getComputedStyle(document.documentElement);
    for(const name of ['--bg-primary','--bg-secondary','--bg-tertiary','--bg-hover','--text-primary','--text-secondary','--text-tertiary',
      '--text-quaternary','--border-color','--border-primary','--border-hover','--primary-color','--danger-color','--bg-error-light',
      '--warning-border','--success-badge-bg','--success-badge-text','--success-badge-border','--failure-badge-bg','--failure-badge-text',
      '--failure-badge-border','--floating-surface','--floating-shadow','--viz-success','--viz-failure','--ease-out-strong']) {
      const value=style.getPropertyValue(name).trim();
      if(value) vars[name]=value;
    }
    vars['--font']=getComputedStyle(document.body).fontFamily;
    const session={type:'usage-insights-session',authorization,vars,theme:document.documentElement.getAttribute('data-theme')==='dark'?'dark':'light'};
    const serialized=JSON.stringify(session);
    if(!force && serialized===lastSession) return;
    lastSession=serialized;
    frame.contentWindow.postMessage(session,location.origin);
  }
  function openUsage(event) {
    event.preventDefault();
    event.stopPropagation();
    location.hash=usageRoute;
  }
  function mount() {
    const quotaLink=document.querySelector('a[href="#/quota"], a[href="#/quota/"]');
    if(quotaLink && restoreInitialView && !isUsage() && !/^#\/login/.test(location.hash)) {
      restoreInitialView=false;
      location.replace(usageRoute);
      return;
    }
    if(quotaLink && !document.getElementById('usage-insights-nav')) {
      const link=quotaLink.cloneNode(true);
      link.id='usage-insights-nav';
      link.href=usageRoute;
      link.classList.remove('active');
      link.removeAttribute('aria-current');
      link.setAttribute('aria-label','Model usage');
      link.title='Model usage';
      link.innerHTML='<span class="nav-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M4 20V10m8 10V4m8 16v-7"/></svg></span><span class="nav-text"><span class="nav-label">Model usage</span></span>';
      link.onclick=openUsage;
      quotaLink.after(link);
    }
    const active=isUsage();
    const link=document.getElementById('usage-insights-nav');
    link?.classList.toggle('active',active);
    if(active) link?.setAttribute('aria-current','page'); else link?.removeAttribute('aria-current');
    const main=document.querySelector('main.main-content');
    if(!main) return;
    main.classList.toggle('usage-insights-view',active);
    document.body.classList.toggle('usage-insights-open',active);
    if(!active) {
      document.getElementById('usage-insights-page')?.remove();
      frame=null; lastSession='';
      return;
    }
    if(!document.getElementById('usage-insights-style')) {
      const style=document.createElement('style');
      style.id='usage-insights-style';
      style.textContent='main.usage-insights-view{position:relative}main.usage-insights-view>:not(#usage-insights-page){position:absolute!important;left:0;right:0;top:0;visibility:hidden!important;pointer-events:none!important}' +
        '.usage-insights-open a[href="#/quota"].active{background:transparent!important;box-shadow:none!important;border-color:transparent!important;color:var(--text-secondary,inherit)!important}';
      document.head.append(style);
    }
    if(!frame?.isConnected) {
      const section=document.createElement('section');
      section.id='usage-insights-page';
      section.setAttribute('aria-label','Model usage');
      frame=document.createElement('iframe');
      frame.title='Model usage';
      frame.src='/usage-insights/?embedded=1';
      frame.style.cssText='display:block;width:100%;min-height:700px;height:100vh;border:0;background:transparent;';
      frame.addEventListener('load',()=>sendSession(true));
      section.append(frame); main.append(section);
      lastSession='';
    }
    sendSession();
  }
  window.addEventListener('message',event=>{
    if(event.origin!==location.origin || event.source!==frame?.contentWindow) return;
    if(event.data?.type==='usage-insights-ready') sendSession(true);
    if(event.data?.type==='usage-insights-height' && Number.isFinite(event.data.height)) {
      const height=Math.max(700,Math.min(30000,event.data.height));
      if(frame.style.height!==height+'px') frame.style.height=height+'px';
    }
  });
  window.addEventListener('hashchange',()=>{
    if(/^#\/login/.test(location.hash)) { authorization=''; sendSession(true); }
    mount();
  });
  for(const method of ['pushState','replaceState']) {
    const original=history[method];
    history[method]=function(){const result=original.apply(this,arguments);mount();return result;};
  }
  new MutationObserver(mount).observe(document.documentElement,{childList:true,subtree:true,attributes:true,attributeFilter:['data-theme']});
  mount();
})();
