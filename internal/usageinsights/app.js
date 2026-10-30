(() => {
  'use strict';
  const $ = id => document.getElementById(id), fmt = n => Number(n || 0).toLocaleString(), compact = n => new Intl.NumberFormat(undefined, {notation:'compact',maximumFractionDigits:1}).format(n || 0);
  const palette = ['#80b5ff','#e9a777','#9dd5ac','#c8a1ee','#e7ca74','#72ced0','#ee91b5'];
  const known = {codex:'#80b5ff',claude:'#e9a777',gemini:'#9dd5ac',antigravity:'#c8a1ee',kimi:'#e7ca74'};
  function color(name) { let h=0; for(const c of name) h=(h*31+c.charCodeAt(0))>>>0; return known[name] || palette[h%palette.length]; }
  let authorization='', data=null, busy=false, pending=false;
  function node(tag,text,cls) { const e=document.createElement(tag); if(text!=null)e.textContent=text; if(cls)e.className=cls; return e; }
  function legend(parent,label,c) { const el=node('span'), dot=node('i',null,'dot'); dot.style.background=c; el.append(dot,document.createTextNode(label));parent.append(el); }
  function params() { const p=new URLSearchParams(); const hours=+$('period').value;if(hours)p.set('from',new Date(Date.now()-hours*3600000).toISOString());if($('provider').value)p.set('provider',$('provider').value);if($('model').value)p.set('model',$('model').value);return p; }
  async function request(p) { const r=await fetch('/v8/management/observability/usage/insights?'+p,{headers:{Authorization:authorization},cache:'no-store'});if(!r.ok)throw new Error(r.status===401||r.status===403?'Management authentication failed.':`History request failed (${r.status}).`);return r.json(); }
  async function load() {
    if(!authorization)return;if(busy){pending=true;return;}busy=true;
    try { data=await request(params()); render(data); $('connect').hidden=true; }
    catch(e){$('status').textContent=e.message;$('status').className='error';$('connect').hidden=false;}
    finally{busy=false;if(pending){pending=false;load();}}
  }
  function options(id,values) { const el=$(id),previous=el.value;for(const v of values.sort())if(![...el.options].some(o=>o.value===v))el.add(new Option(v,v));el.value=previous; }
  function render(d) {
    options('provider',[...new Set(d.groups.map(g=>g.provider))]);options('model',[...new Set(d.groups.map(g=>g.requested))]);
    const t=d.totals, success=t.attempts-t.failed;
    $('status').className=d.persistence_error||d.skipped_records?'error':'';
    $('status').textContent=[`Updated ${new Date().toLocaleTimeString()}`,`${fmt(d.retained)} attempts retained`,d.oldest?`oldest ${new Date(d.oldest).toLocaleString()}`:'',!d.capture_enabled?'Capture disabled in configuration':'',d.persistence_error?'Persistence failed: '+d.persistence_error:'',d.skipped_records?`${d.skipped_records} damaged journal records skipped`:'',t.uncertain?`${t.uncertain} attempts have uncertain accounting`:'',t.no_reported_tokens?`${t.no_reported_tokens} attempts have no reported tokens; consumption may be unknown`:''].filter(Boolean).join(' · ');
    $('cards').replaceChildren();
    for(const [label,value] of [['Execution attempts',fmt(t.attempts)],['Reported tokens',fmt(t.total)],['Successful attempts',fmt(success)],['Failed attempts',fmt(t.failed)],['Cache-read tokens',fmt(t.cache_read)],['Input cache reuse',t.uncached+t.cache_read+t.cache_write?((100*t.cache_read/(t.uncached+t.cache_read+t.cache_write)).toFixed(1)+'%'):'Unknown']]) {const el=node('div',null,'card');el.append(node('span',label),node('strong',value));$('cards').append(el);}
    const providers=[...new Set(d.groups.map(g=>g.provider))].sort();$('legend').replaceChildren();providers.forEach(p=>legend($('legend'),p,color(p)));
    const rank=$('rank').value, models=new Map();for(const g of d.groups){if(!models.has(g.requested))models.set(g.requested,new Map());const m=models.get(g.requested);m.set(g.provider,(m.get(g.provider)||0)+g[rank]);}
    const sorted=[...models].map(([name,p])=>({name,p,total:[...p.values()].reduce((a,b)=>a+b,0)})).sort((a,b)=>b.total-a.total);const max=Math.max(1,...sorted.map(m=>m.total));$('models').replaceChildren();$('models').className='';
    for(const m of sorted.slice(0,12)){const row=node('div',null,'row'),label=node('div',null,'row-label'),bar=node('div',null,'bar');label.append(node('span',m.name),node('span',compact(m.total)));for(const [p,v] of m.p){const seg=node('div',null,'segment');seg.style.width=100*v/max+'%';seg.style.background=color(p);seg.title=`${p}: ${fmt(v)}`;bar.append(seg);}row.append(label,bar);$('models').append(row);}
    if(!sorted.length)$('models').append(node('div','No attempts in this period. Send traffic through this instance to begin.','empty'));
    $('routing').replaceChildren();for(const g of [...d.groups].sort((a,b)=>b[rank]-a[rank])){const row=node('tr');for(const [i,v] of [g.requested,g.routed,g.reported||'Unknown',g.provider,fmt(g.attempts),fmt(g.failed),fmt(g.uncached),fmt(g.cache_read),fmt(g.cache_write),fmt(g.output),fmt(g.reasoning),fmt(g.unclassified),fmt(g.total)].entries())row.append(node('td',v,i>=4?'num':null));$('routing').append(row);}
    $('token-bar').replaceChildren();$('token-legend').replaceChildren();for(const [label,key,c] of [['Uncached input','uncached','#80b5ff'],['Cache read','cache_read','#72ced0'],['Cache write','cache_write','#c8a1ee'],['Output','output','#9dd5ac'],['Reasoning','reasoning','#e9a777'],['Unclassified','unclassified','#ee91b5']]){legend($('token-legend'),`${label} ${fmt(t[key])}`,c);const seg=node('div',null,'segment');seg.style.width=(t.total?100*t[key]/t.total:0)+'%';seg.style.background=c;seg.title=`${label}: ${fmt(t[key])}`;$('token-bar').append(seg);}
    $('timeline-title').textContent=(rank==='attempts'?'Execution attempts':'Reported tokens')+' over time';timeline(d.timeline,providers,rank);
    $('recent').replaceChildren();for(const e of d.recent){const row=node('tr');for(const [i,v] of [new Date(e.at).toLocaleString(),e.requested,`${e.provider} / ${e.account||'unknown'}`,e.failed?'Failed':e.tokens.quality==='complete'?'Success':'Success · uncertain usage',e.tokens.total_tokens?fmt(e.tokens.total_tokens):'Not reported / zero',e.tokens.total_tokens?fmt(e.tokens.input.cache_read_tokens):'Unknown',`${fmt(e.latency_ms)} ms`,`${e.trace||'unknown'} / ${e.id}`].entries())row.append(node('td',v,i>=4&&i<=6?'num':null));$('recent').append(row);}
  }
  function timeline(buckets,providers,rank){const svg=$('timeline');svg.replaceChildren();$('timeline-labels').replaceChildren();if(!buckets.length)return;const hours=new Map();for(const b of buckets){const at=+new Date(b.at);if(!hours.has(at))hours.set(at,new Map());hours.get(at).set(b.provider,b[rank]);}const times=[...hours.keys()].sort((a,b)=>a-b),start=times[0],end=times.at(-1),count=(end-start)/3600000+1;
    // Merge long retained histories into at most 96 equally spaced display buckets.
    const step=Math.max(1,Math.ceil(count/96)), bins=new Map();for(const [at,ps] of hours){const key=Math.floor((at-start)/3600000/step);if(!bins.has(key))bins.set(key,new Map());for(const [p,n]of ps)bins.get(key).set(p,(bins.get(key).get(p)||0)+n);}
    const n=Math.ceil(count/step),max=Math.max(1,...[...bins.values()].map(ps=>[...ps.values()].reduce((a,b)=>a+b,0)));svg.setAttribute('viewBox','0 0 800 180');for(const [i,ps]of bins){let y=165;for(const p of providers){const value=ps.get(p)||0,h=150*value/max;const rect=document.createElementNS('http://www.w3.org/2000/svg','rect');for(const [k,v]of Object.entries({x:i*800/n+1,y:y-h,width:Math.max(1,800/n-2),height:h,fill:color(p)}))rect.setAttribute(k,v);const title=document.createElementNS(svg.namespaceURI,'title');title.textContent=`${new Date(start+i*step*3600000).toLocaleString()} · ${p}: ${fmt(value)} ${rank==='attempts'?'attempts':'reported tokens'}`;rect.append(title);svg.append(rect);y-=h;}}$('timeline-labels').append(node('span',new Date(start).toLocaleString()),node('span',`${step}h buckets · peak ${compact(max)}`),node('span',new Date(end).toLocaleString()));}
  $('connect').addEventListener('submit',e=>{e.preventDefault();authorization='Bearer '+$('key').value.trim();$('key').value='';load();});
  for(const id of ['period','provider','model'])$(id).addEventListener('change',load);$('rank').addEventListener('change',()=>data&&render(data));$('refresh').onclick=load;
  $('export').onclick=async()=>{if(!authorization)return;try{const p=params();p.set('export','1');const events=await request(p),url=URL.createObjectURL(new Blob([JSON.stringify(events,null,2)],{type:'application/json'})),a=node('a');a.href=url;a.download='usage-insights.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}catch(e){$('status').textContent=e.message;$('status').className='error';}};
  window.addEventListener('message',e=>{if(e.origin!==location.origin||e.source!==window.opener||e.data?.type!=='usage-insights-session')return;authorization=e.data.authorization||'';for(const [k,v]of Object.entries(e.data.vars||{}))if(k.startsWith('--')&&typeof v==='string')document.documentElement.style.setProperty(k,v);if(e.data.theme)document.documentElement.style.colorScheme=e.data.theme;load();});
  if(window.opener)window.opener.postMessage({type:'usage-insights-ready'},location.origin);
  setInterval(()=>{if(!document.hidden)load();},15000);
})();
