(() => {
  'use strict';
  const $ = id => document.getElementById(id), fmt = n => Number(n || 0).toLocaleString(), compact = n => new Intl.NumberFormat(undefined, {notation:'compact',maximumFractionDigits:1}).format(n || 0);
  const HOUR = 3600000, SVG = 'http://www.w3.org/2000/svg';
  // Provider colors match the quota outlook so the same provider reads the same everywhere in the console.
  const known = {claude:'#d97757',codex:'#6f93e8',gemini:'#4fb3bb',antigravity:'#a77bea',kimi:'#c9a227',xai:'#8f94c8',devin:'#4fae8c',meta:'#5b8def'};
  const palette = ['#4fae8c','#d670a0','#c9a227','#a77bea','#4fb3bb','#8f94c8'];
  function color(name) { const key=Object.keys(known).find(k=>name.toLowerCase().includes(k)); if(key) return known[key]; let h=0; for(const c of name) h=(h*31+c.charCodeAt(0))>>>0; return palette[h%palette.length]; }
  const TOKEN_KINDS = [['Uncached input','uncached','#6f93e8'],['Cache read','cache_read','#4fb3bb'],['Cache write','cache_write','#a77bea'],['Output','output','#4fae8c'],['Reasoning','reasoning','#d97757'],['Unclassified','unclassified','#d670a0']];
  const embedded=window.parent!==window;
  const sessionHost=embedded?window.parent:window.opener;
  if(embedded){document.documentElement.classList.add('embedded');$('connect').hidden=true;}
  let authorization='', data=null, providerTotals=null, busy=false, pending=false, provider='', chart=null, showAllRecent=false;
  function node(tag,text,cls) { const e=document.createElement(tag); if(text!=null)e.textContent=text; if(cls)e.className=cls; return e; }
  function swatch(c) { const s=node('i',null,'swatch'); s.style.background=c; return s; }
  function legend(parent,label,c) { const el=node('span'); el.append(swatch(c),document.createTextNode(label)); parent.append(el); }
  function chip(name) { const el=node('span',null,'chip'); el.append(swatch(color(name)),document.createTextNode(name)); return el; }
  function selected(id) { return $(id).querySelector('[aria-pressed=true]').dataset.value; }
  function segmented(id,onChange) { $(id).addEventListener('click',e=>{const b=e.target.closest('button');if(!b||b.getAttribute('aria-pressed')==='true')return;for(const x of $(id).children)x.setAttribute('aria-pressed',String(x===b));onChange();}); }
  function params(withProvider=true) { const p=new URLSearchParams(), hours=+selected('period'); if(hours)p.set('from',new Date(Date.now()-hours*HOUR).toISOString()); if(withProvider&&provider)p.set('provider',provider); if($('model').value)p.set('model',$('model').value); return p; }
  async function request(p) { const r=await fetch('/v8/management/observability/usage/insights?'+p,{headers:{Authorization:authorization},cache:'no-store'}); if(!r.ok)throw new Error(r.status===401||r.status===403?'Management authentication failed.':`History request failed (${r.status}).`); return r.json(); }
  function showError(message) { $('banner').textContent=message; $('banner').hidden=!message; }
  async function load() {
    if(!authorization)return; if(busy){pending=true;return;} busy=true; $('refresh').disabled=true; $('refresh').classList.add('spin');
    try {
      // Provider tabs always count every provider, so fetch the unfiltered view alongside a provider-filtered one.
      const [view,all]=await Promise.all([request(params()),provider?request(params(false)):null]);
      data=view; providerTotals=all||view; render(); $('connect').hidden=true;
    } catch(e) { showError(e.message); $('connect').hidden=embedded; }
    finally { busy=false; $('refresh').disabled=false; $('refresh').classList.remove('spin'); if(pending){pending=false;load();} }
  }
  function sum(groups,key) { const m=new Map(); for(const g of groups) m.set(g.provider,(m.get(g.provider)||0)+g[key]); return m; }
  function renderTabs() {
    const counts=sum(providerTotals.groups,'attempts'), total=[...counts.values()].reduce((a,b)=>a+b,0), tabs=$('provider-tabs');
    if(provider&&!counts.has(provider))counts.set(provider,0);
    tabs.replaceChildren();
    for(const [name,count] of [['',total],...[...counts].sort((a,b)=>b[1]-a[1])]) {
      const tab=node('button',null,'tab'); tab.type='button'; tab.setAttribute('role','tab'); tab.setAttribute('aria-selected',String(name===provider));
      if(name)tab.append(swatch(color(name)));
      tab.append(node('span',name||'All'),node('span',compact(count),'count'));
      tab.onclick=()=>{if(provider===name)return;provider=name;load();};
      tabs.append(tab);
    }
  }
  function renderMeta(d) {
    const t=d.totals, meta=$('meta'), parts=[[`${fmt(t.attempts)} attempts`],[`${compact(t.total)} tokens`,'muted']];
    if(t.failed)parts.push([`${fmt(t.failed)} failed`,'bad']);
    parts.push([d.oldest?`since ${new Date(d.oldest).toLocaleDateString(undefined,{day:'numeric',month:'short'})}`:'no history yet','muted']);
    meta.replaceChildren();
    parts.forEach(([text,cls],i)=>{if(i)meta.append(node('span','·','dot'));meta.append(node('span',text,cls));});
    const warnings=[!d.capture_enabled?'Capture is disabled in configuration.':'',d.persistence_error?'Persistence failed: '+d.persistence_error:'',d.skipped_records?`${d.skipped_records} damaged journal records were skipped.`:''].filter(Boolean);
    showError(warnings.join(' '));
  }
  function card(label,value,sub,title) { const el=node('div',null,'card'),v=node('div',value,'value'); el.append(node('div',label,'label'),v); if(title)v.title=title; if(sub)el.append(sub); return el; }
  function subline(...parts) { const el=node('div',null,'sub'); parts.forEach(([text,cls],i)=>{if(i)el.append(document.createTextNode(' · '));el.append(cls?node('span',text,cls):document.createTextNode(text));}); return el; }
  function renderCards(d,models) {
    const t=d.totals, input=t.uncached+t.cache_read+t.cache_write, top=models[0], rank=selected('rank'), share=n=>Math.round(100*n/Math.max(1,rank==='attempts'?t.attempts:t.total))+'%';
    const failed=t.failed?[`${fmt(t.failed)} failed`,'bad']:['no failures','ok'];
    const unknown=t.no_reported_tokens?[`${fmt(t.no_reported_tokens)} unreported`]:[`${fmt(t.cache_hits)} cache hits`];
    const cards=[card('Execution attempts',fmt(t.attempts),subline([`${fmt(t.attempts-t.failed)} succeeded`],failed)),
      card('Reported tokens',compact(t.total),subline([`${compact(input)} in`],[`${compact(t.output+t.reasoning)} out`]),fmt(t.total)+' tokens'),
      card('Cache reuse',input?(100*t.cache_read/input).toFixed(1)+'%':'—',subline([`${compact(t.cache_read)} cache-read tokens`]),fmt(t.cache_read)+' cache-read tokens'),
      card('Output tokens',compact(t.output+t.reasoning),subline([`${compact(t.reasoning)} reasoning`],unknown),fmt(t.output+t.reasoning)+' output tokens')];
    if(top){const c=card('Top model',top.name,subline([`${share(top.total)} of ${rank==='attempts'?'attempts':'tokens'}`]),top.name);c.querySelector('.value').classList.add('name');cards.push(c);}
    $('cards').replaceChildren(...cards);
  }
  function renderModels(models,providers) {
    const rank=selected('rank'), max=Math.max(1,...models.map(m=>m.total));
    $('legend').replaceChildren(); providers.forEach(p=>legend($('legend'),p,color(p))); $('legend').hidden=providers.length<2;
    $('models-hint').textContent=`Top requested models by ${rank==='attempts'?'execution attempts':'reported tokens'}, split by the provider that served them.`;
    $('models').replaceChildren();
    for(const m of models.slice(0,10)) {
      const row=node('div',null,'row'),label=node('div',null,'row-label'),bar=node('div',null,'bar'),name=node('span',m.name);
      name.title=m.name; label.append(name,node('b',rank==='attempts'?fmt(m.total):compact(m.total)));
      for(const [p,v] of [...m.p].sort((a,b)=>b[1]-a[1])){const seg=node('div',null,'segment');seg.style.width=100*v/max+'%';seg.style.background=color(p);seg.title=`${p}: ${fmt(v)}`;bar.append(seg);}
      row.append(label,bar); $('models').append(row);
    }
    if(!models.length)$('models').append(node('div','No attempts in this period. Send traffic through this instance to begin.','empty'));
  }
  function renderTokens(t) {
    $('token-bar').replaceChildren(); $('token-legend').replaceChildren();
    for(const [label,key,c] of TOKEN_KINDS) {
      if(key==='unclassified'&&!t[key])continue;
      const pct=t.total?100*t[key]/t.total:0, item=node('div');
      item.append(swatch(c),node('span',label),node('strong',compact(t[key])),node('small',`${fmt(t[key])} · ${pct<0.1&&t[key]?'<0.1':pct.toFixed(1)}%`));
      $('token-legend').append(item);
      if(t[key]){const seg=node('div',null,'segment');seg.style.width=pct+'%';seg.style.background=c;seg.title=`${label}: ${fmt(t[key])}`;$('token-bar').append(seg);}
    }
  }
  function renderTables(d) {
    const rank=selected('rank');
    $('routing').replaceChildren();
    for(const g of [...d.groups].sort((a,b)=>b[rank]-a[rank])) {
      const row=node('tr'), same=v=>v===g.requested;
      row.append(node('td',g.requested),node('td',g.routed,same(g.routed)?'dim':null),node('td',g.reported||'Unknown',!g.reported||same(g.reported)?'dim':null));
      const p=node('td'); p.append(chip(g.provider)); row.append(p);
      for(const [v,key] of [[g.attempts],[g.failed,'failed'],[g.uncached],[g.cache_read],[g.cache_write],[g.output],[g.reasoning],[g.unclassified],[g.total]])row.append(node('td',fmt(v),'num'+(!v?' dim':'')+(key==='failed'&&v?' bad':'')));
      $('routing').append(row);
    }
    if(!d.groups.length){const row=node('tr'),cell=node('td','No attempts in this period.','empty');cell.colSpan=13;row.append(cell);$('routing').append(row);}
    $('recent').replaceChildren();
    for(const e of showAllRecent?d.recent:d.recent.slice(0,20)) {
      const row=node('tr'), at=new Date(e.at), started=node('td',at.toLocaleString(undefined,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit'}),'mono muted'), p=node('td'), s=node('td'), status=e.failed?['Failed','fail']:e.tokens.quality==='complete'?['OK','ok']:['Usage uncertain','warn'];
      started.title=at.toLocaleString(); p.append(chip(e.provider)); s.append(node('span',status[0],'pill '+status[1]));
      const tokens=e.tokens.total_tokens, trace=node('td',e.trace?'…'+e.trace.slice(-8):'—','mono dim'); trace.title=`Trace ${e.trace||'unknown'} · execution ${e.id}`;
      row.append(started,node('td',e.requested),p,node('td',e.account||'unknown','mono dim'),s,node('td',tokens?fmt(tokens):'—','num'+(tokens?'':' dim')),node('td',tokens?fmt(e.tokens.input.cache_read_tokens):'—','num dim'),node('td',e.latency_ms>=1000?(e.latency_ms/1000).toFixed(1)+' s':fmt(e.latency_ms)+' ms','num'),trace);
      $('recent').append(row);
    }
    if(!d.recent.length){const row=node('tr'),cell=node('td','No attempts in this period.','empty');cell.colSpan=9;row.append(cell);$('recent').append(row);}
    $('recent-more').hidden=d.recent.length<=20; $('recent-more').textContent=showAllRecent?'Show fewer':`Show all ${d.recent.length}`;
  }
  function options(values) { const el=$('model'), previous=el.value; for(const v of values.sort())if(![...el.options].some(o=>o.value===v))el.add(new Option(v,v)); el.value=previous; }
  function render() {
    const d=data, rank=selected('rank');
    options([...new Set(providerTotals.groups.map(g=>g.requested))]);
    renderTabs(); renderMeta(d);
    const providers=[...sum(d.groups,'attempts')].sort((a,b)=>b[1]-a[1]).map(([p])=>p), models=new Map();
    for(const g of d.groups){if(!models.has(g.requested))models.set(g.requested,new Map());const m=models.get(g.requested);m.set(g.provider,(m.get(g.provider)||0)+g[rank]);}
    const sorted=[...models].map(([name,p])=>({name,p,total:[...p.values()].reduce((a,b)=>a+b,0)})).sort((a,b)=>b.total-a.total);
    renderCards(d,sorted); renderModels(sorted,providers); renderTokens(d.totals); renderTables(d);
    chart=buildTimeline(d,providers,rank); drawTimeline();
  }
  // Bin hourly buckets over the selected period so the chart always spans the full range, not just active hours.
  function buildTimeline(d,providers,rank) {
    const hours=+selected('period'), now=Date.now(), end=Math.ceil(now/HOUR)*HOUR;
    let start=hours?end-hours*HOUR:Math.min(end-24*HOUR,...d.timeline.map(b=>+new Date(b.at)));
    const span=(end-start)/HOUR, step=[1,2,3,6,12,24,48,168].find(s=>span/s<=48)||Math.ceil(span/48);
    start=end-Math.ceil(span/step)*step*HOUR;
    const bins=Array.from({length:Math.round((end-start)/(step*HOUR))},(_,i)=>({at:start+i*step*HOUR,values:new Map(),total:0}));
    for(const b of d.timeline){const i=Math.floor((+new Date(b.at)-start)/(step*HOUR));if(i<0||i>=bins.length)continue;bins[i].values.set(b.provider,(bins[i].values.get(b.provider)||0)+b[rank]);bins[i].total+=b[rank];}
    $('timeline-title').textContent=(rank==='attempts'?'Execution attempts':'Reported tokens')+' over time';
    $('timeline-hint').textContent=`${step===1?'Hourly':step%24===0?(step===24?'Daily':step/24+'-day'):step+'-hour'} buckets in local time.`;
    return {bins,providers,rank,step};
  }
  function label(at,step) { const d=new Date(at); return step>=24?d.toLocaleDateString(undefined,{day:'numeric',month:'short'}):d.toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'}); }
  function niceMax(v) { const p=10**Math.floor(Math.log10(Math.max(1,v))), n=v/p; return (n<=1?1:n<=2?2:n<=5?5:10)*p; }
  function drawTimeline() {
    const svg=$('timeline'); svg.replaceChildren(); if(!chart)return;
    const w=Math.max(260,svg.clientWidth), h=220, left=40, bottom=24, top=8, plotW=w-left, plotH=h-top-bottom, {bins,providers,step}=chart;
    const max=niceMax(Math.max(1,...bins.map(b=>b.total))), slot=plotW/bins.length, gap=Math.min(4,slot*.25);
    svg.setAttribute('viewBox',`0 0 ${w} ${h}`);
    const el=(tag,attrs,text)=>{const e=document.createElementNS(SVG,tag);for(const [k,v] of Object.entries(attrs))e.setAttribute(k,v);if(text!=null)e.textContent=text;svg.append(e);return e;};
    for(const f of [0,.5,1]){const y=top+plotH*(1-f);el('line',{x1:left,x2:w,y1:y,y2:y,class:f?'grid-line':'base'});el('text',{x:left-8,y:y+4,'text-anchor':'end'},compact(max*f));}
    const hover=el('rect',{x:0,y:top,width:slot,height:plotH,class:'hover',opacity:0});
    bins.forEach((b,i)=>{let y=top+plotH;for(const p of providers){const v=b.values.get(p)||0;if(!v)continue;const bh=Math.max(1,plotH*v/max);el('rect',{x:left+i*slot+gap/2,y:y-bh,width:Math.max(1,slot-gap),height:bh,fill:color(p),rx:Math.min(2,slot/4)});y-=bh;}});
    const ticks=Math.min(bins.length,Math.max(2,Math.floor(plotW/110)));
    for(let k=0;k<ticks;k++){const i=Math.round(k*(bins.length-1)/(ticks-1)),x=left+i*slot+slot/2;el('text',{x,y:h-6,'text-anchor':k===0?'start':k===ticks-1?'end':'middle'},label(bins[i].at,step));}
    chart.hit=(clientX)=>{const r=svg.getBoundingClientRect(),i=Math.floor((clientX-r.left-left)/slot);return i>=0&&i<bins.length?i:-1;};
    chart.hover=hover; chart.slot=slot; chart.left=left;
  }
  function showTooltip(e) {
    if(!chart?.hit)return; const i=chart.hit(e.clientX), tip=$('tooltip');
    if(i<0){tip.classList.remove('visible');chart.hover.setAttribute('opacity',0);return;}
    const b=chart.bins[i], unit=chart.rank==='attempts'?'attempts':'tokens', from=new Date(b.at), to=new Date(b.at+chart.step*HOUR);
    chart.hover.setAttribute('x',chart.left+i*chart.slot); chart.hover.setAttribute('opacity',1);
    const head=node('b',`${chart.rank==='attempts'?fmt(b.total):compact(b.total)} ${unit}`), when=node('span',`${from.toLocaleString(undefined,{weekday:'short',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})} – ${to.toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'})}`), list=node('ul');
    for(const [p,v] of [...b.values].sort((x,y)=>y[1]-x[1])){const li=node('li');li.append(swatch(color(p)),node('span',p),node('em',fmt(v)));list.append(li);}
    tip.replaceChildren(head,when); if(list.children.length)tip.append(list);
    const plot=$('plot').getBoundingClientRect(), x=chart.left+i*chart.slot+chart.slot/2, half=tip.offsetWidth/2;
    tip.style.left=Math.min(plot.width-half,Math.max(half,x))+'px'; tip.style.top='16px'; tip.style.transform='translate(-50%,-100%)'; tip.classList.add('visible');
  }
  $('timeline').addEventListener('pointermove',showTooltip);
  $('timeline').addEventListener('pointerleave',()=>{$('tooltip').classList.remove('visible');chart?.hover?.setAttribute('opacity',0);});
  new ResizeObserver(()=>drawTimeline()).observe($('plot'));
  $('connect').addEventListener('submit',e=>{e.preventDefault();authorization='Bearer '+$('key').value.trim();$('key').value='';load();});
  segmented('period',load); segmented('rank',()=>data&&render()); $('model').addEventListener('change',load); $('refresh').onclick=load;
  $('recent-more').onclick=()=>{showAllRecent=!showAllRecent;if(data)renderTables(data);};
  $('export').onclick=async()=>{if(!authorization)return;try{const p=params();p.set('export','1');const events=await request(p),url=URL.createObjectURL(new Blob([JSON.stringify(events,null,2)],{type:'application/json'})),a=node('a');a.href=url;a.download='usage-insights.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}catch(e){showError(e.message);}};
  window.addEventListener('message',e=>{if(e.origin!==location.origin||e.source!==sessionHost||e.data?.type!=='usage-insights-session')return;const nextAuthorization=e.data.authorization||'',changed=authorization!==nextAuthorization;authorization=nextAuthorization;for(const [k,v]of Object.entries(e.data.vars||{}))if(k.startsWith('--')&&typeof v==='string')document.documentElement.style.setProperty(k,v);if(e.data.theme)document.documentElement.style.colorScheme=e.data.theme;if(authorization&&(changed||!data))load();});
  if(sessionHost)sessionHost.postMessage({type:'usage-insights-ready'},location.origin);
  if(embedded)new ResizeObserver(()=>window.parent.postMessage({type:'usage-insights-height',height:document.body.scrollHeight},location.origin)).observe(document.body);
  setInterval(()=>{if(!document.hidden)load();},15000);
})();
