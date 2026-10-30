/* Fork-owned management quota outlook. No credential persistence. */
'use strict';
const Q=QuotaMath,$=id=>document.getElementById(id),HOUR=3600000,DAY=24*HOUR;
const colors={claude:'#d97757',codex:'#6f93e8',gemini:'#4fb3bb',antigravity:'#a77bea',kimi:'#c9a227',xai:'#8f94c8',devin:'#4fae8c',meta:'#5b8def'};
const palette=['#4fae8c','#d670a0','#c9a227','#a77bea'];
const color=p=>colors[p]||palette[[...p].reduce((a,c)=>a+c.charCodeAt(0),0)%palette.length];
const reduced=matchMedia('(prefers-reduced-motion: reduce)');
let secret='',history=[],accounts=[],timer=null,busy=false,mode='remaining',generation=0,consoleProvider=null,view=null,drawnWidth=0;
const fmt=n=>n===null||!Number.isFinite(n)?'—':n.toFixed(1);
const round=n=>Math.round(n).toLocaleString();
const plural=(n,word)=>n+' '+word+(n===1?'':'s');
function resetLabel(t){
 if(!Number.isFinite(t))return 'Unknown';
 const soon=t-Date.now()<6*DAY;
 return new Date(t).toLocaleString(undefined,soon?{weekday:'short',hour:'numeric',minute:'2-digit'}:{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});
}
function element(tag,text,cls){const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;}
function svgNode(tag,attrs={},text){const n=document.createElementNS('http://www.w3.org/2000/svg',tag);for(const [k,v]of Object.entries(attrs))n.setAttribute(k,String(v));if(text!==undefined)n.textContent=text;return n;}
async function api(path,data){
 const response=await fetch('/v8/management/'+path,{method:data?'POST':'GET',headers:{Authorization:'Bearer '+secret,'Content-Type':'application/json'},body:data?JSON.stringify(data):undefined,cache:'no-store'});
 if(!response.ok)throw new Error(response.status===401||response.status===403?'Management authentication failed':'Management request failed, HTTP '+response.status);
 return response.json();
}
const providerOf=a=>a.provider||a.type;
const provider=()=>consoleProvider??$('provider').value;
const visible=()=>accounts.filter(a=>provider()==='all'||providerOf(a)===provider());
// A credential note set in the auth file editor names the subscription everywhere.
const noteOf=id=>{const note=accounts.find(a=>a.auth_index===id)?.note;return typeof note==='string'?note.trim():'';};
function accountLabel(id){const a=accounts.find(a=>a.auth_index===id);if(!a)return 'Removed subscription';if(noteOf(id))return noteOf(id);const base=providerOf(a)+' subscription '+(accounts.indexOf(a)+1);const label=a.label||a.email||a.name;return $('labels').checked&&label?base+' · '+label:base;}
function filterOptions(){
 const p=$('provider').value,a=$('account').value;
 $('provider').replaceChildren(new Option('All providers','all'));
 for(const name of [...new Set(accounts.map(providerOf))])$('provider').add(new Option(name,name));
 if([...$('provider').options].some(o=>o.value===p))$('provider').value=p;
 $('account').replaceChildren(new Option('All subscriptions','all'));
 for(const account of visible())$('account').add(new Option(accountLabel(account.auth_index),account.auth_index));
 if([...$('account').options].some(o=>o.value===a))$('account').value=a;
}
// History comes from the server, which checks quotas hourly and records quota refreshes made in the console.
async function refresh(collect){
 if(busy||!secret)return;busy=true;$('refresh').disabled=true;if(collect)$('status').textContent='Checking quotas…';
 const run=generation;
 try{
  const listed=await api('credentials');if(run!==generation)return;
  accounts=(listed.files||[]).filter(a=>!a.disabled&&a.auth_index);filterOptions();
  const first=!history.length,saved=await api(collect?'quota/history/collect':'quota/history',collect?{}:undefined);
  if(run!==generation)return;
  history=saved.samples||[];
  if(collect)$('errors').textContent=(saved.failed||[]).map(id=>accountLabel(id)+': quota unavailable. Earlier history stays visible.').join('\n');
  const latest=Math.max(0,...history.map(s=>Date.parse(s.at)));
  $('status').textContent=(latest?'Last quota check '+new Date(latest).toLocaleString(undefined,{weekday:'short',hour:'numeric',minute:'2-digit'})+'. ':'No quota checks yet. ')+'The server checks every hour and also records quota refreshes made in this console.';
  render(first);
 }catch(error){if(run===generation){$('errors').textContent=error.message;render(false);}}
 finally{busy=false;$('refresh').disabled=false;}
}
function groups(){
 const result=new Map(),short=$('limit').value==='short';
 // One kind of limit at a time; mixing windows would make totals and shared work meaningless.
 const long=short?null:new Set(Q.accountLong(history));
 for(const s of history){
  if(!accounts.some(a=>a.auth_index===s.account))continue;
  if(provider()!=='all'&&s.provider!==provider())continue;
  if($('account').value!=='all'&&s.account!==$('account').value)continue;
  if(short?!Q.accountShort(s):!long.has(s))continue;
  const id=Q.key(s);if(!result.has(id))result.set(id,[]);result.get(id).push(s);
 }
 return [...result.values()];
}
const risky=r=>!r.stale&&(r.status==='Runs out before reset'||r.status==='Exhausted');
function render(animate){
 const now=Date.now(),series=groups(),rows=series.map(s=>Q.outlook(s,now,Number($('lookback').value)));
 const p=provider();
 document.documentElement.style.setProperty('--accent',p==='all'?'var(--text-primary)':color(p));
 // Stale limits and limits without a known reset are drawn flat.
 const forecasts=rows.map(r=>[{at:now,remaining:r.remaining}]),pools=new Map();
 rows.forEach((r,i)=>{
  r.size=null;
  if(r.stale||r.hoursToReset===null)return;
  // The proxy spreads one provider's work across its subscriptions; only one limit kind is selected.
  const kind=r.provider;
  if(!pools.has(kind))pools.set(kind,[]);
  pools.get(kind).push(i);
 });
 for(const members of pools.values()){
  const sized=Q.sizes(members.map(i=>({provider:rows[i].provider,plan:series[i].findLast(s=>s.plan)?.plan,measured:Q.capacity(series[i])})));
  const lists=Q.poolForecast(members.map((i,k)=>({...rows[i],capacity:sized[k].capacity})),now,now+15*DAY);
  const smallest=Math.min(...sized.map(s=>s.capacity)),paced=members.some(i=>rows[i].rate!==null);
  members.forEach((i,k)=>{
   const r=rows[i];forecasts[i]=lists[k];r.size={relative:sized[k].capacity/smallest,source:sized[k].source,plan:series[i].findLast(s=>s.plan)?.plan};
   if(!paced||r.status==='Exhausted')return;
   r.projected=Q.valueAt(lists[k],Date.parse(r.reset),-1);
   r.status=r.projected<=0?'Runs out before reset':r.projected<10?'Close to limit':'On pace';
  });
 }
 view={series,rows,forecasts,now};
 summary(rows);table(rows);draw(animate);
}
function countTo(el,value,suffix){
 const from=Number(el.dataset.value);el.dataset.value=value;
 const write=v=>{el.textContent=round(v)+suffix;};
 if(reduced.matches||from===value){write(value);return;}
 const start=performance.now(),origin=Number.isFinite(from)?from:0;
 const step=t=>{if(Number(el.dataset.value)!==value)return;const k=Math.min(1,(t-start)/800);write(origin+(value-origin)*(1-Math.pow(1-k,4)));if(k<1)requestAnimationFrame(step);};
 requestAnimationFrame(step);
}
function summary(rows){
 const total=$('total');
 if(!rows.length){delete total.dataset.value;total.textContent='—';$('capacity').textContent=busy||!history.length?'Loading quota history':'No quota history for this selection';$('pace').textContent='';$('risk').classList.add('hidden');return;}
 countTo(total,rows.reduce((s,r)=>s+r.remaining,0),'%');
 $('capacity').textContent='/ '+round(rows.length*100)+'% remaining';
 const rated=rows.filter(r=>!r.stale&&r.rate!==null);
 $('pace').textContent=rated.length?'~'+round(24*rated.reduce((s,r)=>s+r.rate,0))+'% per day':'Learning pace';
 const atRisk=rows.filter(risky).length;
 $('risk').textContent=plural(atRisk,'limit')+' '+(atRisk===1?'runs':'run')+' out before reset';
 $('risk').classList.toggle('hidden',!atRisk);
}
function table(rows){
 const body=$('rows');body.replaceChildren();
 for(const r of rows){
  const tr=element('tr'),who=element('td'),wrap=element('div',undefined,'who'),dot=element('i');
  dot.style.background=color(r.provider);
  const name=element('span',accountLabel(r.account));name.append(document.createElement('br'),element('small',r.limit.replaceAll('_',' ')+(r.size?.plan?' · '+r.size.plan.replaceAll('_',' '):'')));
  wrap.append(dot,name);who.append(wrap);
  const status=element('td'),badge=element('span',r.status,'badge'+(r.status==='On pace'?' safe':risky(r)?' risk':''));status.append(badge);
  const size=element('td',r.size?(r.size.relative<10?r.size.relative.toFixed(1):Math.round(r.size.relative))+'×':'—','num');
  if(r.size)size.append(element('small',' '+r.size.source));
  tr.append(who,element('td',fmt(r.remaining)+'%','num'),size,element('td',r.rate===null?'—':fmt(24*r.rate)+'%','num'),element('td',r.stale||r.projected===null?'—':fmt(Math.max(0,r.projected))+'%','num'),element('td',resetLabel(Date.parse(r.reset))),status);
  body.append(tr);
 }
 if(!rows.length){const tr=element('tr'),td=element('td','No observations for this selection. Try another limit filter. Unsupported subscriptions are listed above and are never counted as safe.','muted');td.colSpan=7;tr.append(td);body.append(tr);}
}
// Rounded axis maximum with four equal steps.
function niceMax(peak){
 const raw=Math.max(peak,1)*1.1/4,mag=10**Math.floor(Math.log10(raw)),step=[1,2,2.5,5,10].map(m=>m*mag).find(s=>s>=raw);
 return step*4;
}
function timeTicks(start,end){
 if(end-start<2*DAY)return [0,1,2,3,4].map(i=>({at:start+(end-start)*i/4,label:new Date(start+(end-start)*i/4).toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'})}));
 const every=Math.max(1,Math.ceil((end-start)/DAY/5)),d=new Date(start),ticks=[];
 d.setHours(24,0,0,0);
 for(;d.getTime()<=end;d.setDate(d.getDate()+every))ticks.push({at:d.getTime(),label:d.toLocaleDateString(undefined,{month:'short',day:'numeric'})});
 return ticks;
}
function segments(points){
 const out=[];let current=[];
 for(const p of points){if(p.remaining===null){if(current.length)out.push(current);current=[];}else current.push(p);}
 if(current.length)out.push(current);
 return out;
}
function chartSpec(){
 const {series,rows,forecasts,now}=view;
 if(mode==='remaining'){
  const horizon=Number($('horizon').value)*DAY,start=now-horizon,end=now+horizon;
  const observed=Q.sumHistory(series,start,now,Math.max(60000,(now-start)/150)),projected=Q.sumForecast(forecasts,now,end);
  const known=observed.filter(p=>p.remaining!==null&&p.at<now);
  // The forecast line only bends at resets and depletions, so add evenly spaced hover stops on whole hours.
  const every=Math.max(1,Math.round((end-start)/HOUR/60)),stop=new Date(now);stop.setHours(Math.ceil((stop.getHours()+1)/every)*every,0,0,0);
  const stops=[];
  for(let t=stop.getTime();t<end;t+=every*HOUR){const parts=forecasts.map(l=>Q.valueAt(l,t));stops.push({at:t,remaining:parts.reduce((a,v)=>a+v,0),parts});}
  // Hover the later value at refills so the tooltip shows the refilled total.
  const ahead=[...projected,...stops.filter(s=>!projected.some(p=>p.at===s.at))].sort((a,b)=>a.at-b.at);
  const hover=[...known,...ahead.map(p=>({...p,projected:p.at>now}))].filter((p,i,list)=>list[i+1]?.at!==p.at);
  const legend=[['swatch','Remaining'],['dash','Projected']];
  return {start,end,now,max:Math.max(100,rows.length*100),lines:[{points:observed},{points:projected,projected:true}],hover,legend,
   value:p=>round(p.remaining)+'% remaining',part:v=>round(v)+'%',empty:rows.length?'':busy||!history.length?'Loading quota history…':'No quota history for this selection yet.'};
 }
 const span=Number($('span').value)*HOUR,start=now-span,step=Math.max(60000,span/180),window=Math.max(HOUR,Math.round(step/HOUR)*HOUR);
 const points=Q.drain(series,start,now,step,window),measured=points.filter(p=>p.remaining!==null);
 const peak=Math.max(0,...measured.map(p=>p.remaining));
 return {start,end:now,max:niceMax(peak),peak,lines:[{points}],hover:measured,legend:[['swatch','% per hour'],['note',(window/HOUR)+'-hour average']],
  value:p=>fmt(p.remaining)+'% per hour',part:v=>v===null?'—':fmt(v)+'%/h',empty:measured.length?'':rows.length?'Not enough continuous history to measure drain yet.':busy||!history.length?'Loading quota history…':'No quota history for this selection yet.'};
}
function draw(animate){
 if(!view)return;
 const svg=$('chart'),plot=$('plot'),tooltip=$('tooltip'),spec=chartSpec();
 const W=Math.max(280,Math.round(plot.clientWidth)),H=240,L=46,R=12,T=22,B=26;drawnWidth=W;
 const x=t=>L+(t-spec.start)/(spec.end-spec.start)*(W-L-R),y=v=>T+(1-Math.min(spec.max,Math.max(0,v))/spec.max)*(H-T-B),base=y(0);
 svg.setAttribute('viewBox',`0 0 ${W} ${H}`);svg.classList.remove('hovering');tooltip.classList.remove('visible');svg.replaceChildren();
 const defs=svgNode('defs');
 for(const [id,top]of [['fill-observed',.42],['fill-projected',.2]]){
  const gradient=svgNode('linearGradient',{id,gradientUnits:'userSpaceOnUse',x1:0,y1:T,x2:0,y2:base});
  gradient.append(svgNode('stop',{offset:0,class:'stop','stop-opacity':top}),svgNode('stop',{offset:1,class:'stop','stop-opacity':0}));
  defs.append(gradient);
 }
 const clip=svgNode('clipPath',{id:'reveal'}),reveal=svgNode('rect',{x:0,y:0,width:animate&&!reduced.matches?0:W,height:H});
 clip.append(reveal);defs.append(clip);svg.append(defs);
 const axes=svgNode('g',{class:animate?'fade':''});
 for(let i=0;i<=4;i++){
  const v=spec.max*i/4;
  axes.append(svgNode('line',{x1:L,x2:W-R,y1:y(v),y2:y(v),class:i?'grid':'base','stroke-dasharray':i?'2 4':'none'}),svgNode('text',{x:L-10,y:y(v)+4,'text-anchor':'end'},(mode==='remaining'?round(v)+'%':Number(v.toFixed(2)))));
 }
 for(const tick of timeTicks(spec.start,spec.end)){const tx=x(tick.at);axes.append(svgNode('text',{x:Math.min(W-R-24,Math.max(L+24,tx)),y:H-6,'text-anchor':'middle'},tick.label));}
 svg.append(axes);
 const data=svgNode('g',{'clip-path':'url(#reveal)'});
 for(const line of spec.lines)for(const segment of segments(line.points)){
  const d=segment.map((p,i)=>(i?'L':'M')+x(p.at).toFixed(1)+' '+y(p.remaining).toFixed(1)).join(' ');
  data.append(svgNode('path',{d:d+` L${x(segment.at(-1).at).toFixed(1)} ${base} L${x(segment[0].at).toFixed(1)} ${base} Z`,fill:`url(#fill-${line.projected?'projected':'observed'})`}));
  data.append(svgNode('path',{d,class:'line'+(line.projected?' projected':'')}));
 }
 svg.append(data);
 if(spec.now){const nx=x(spec.now);svg.append(svgNode('line',{x1:nx,x2:nx,y1:T-6,y2:base,class:'now'}),svgNode('text',{x:nx+6,y:T-4,class:'now-label'},'Now'));}
 const cross=svgNode('line',{y1:T,y2:base,class:'cross'}),focus=svgNode('circle',{r:4.5,class:'focus'});
 svg.append(cross,focus);
 if(animate&&!reduced.matches){
  const start=performance.now(),duration=spec.now?1100:900;
  const grow=t=>{if(!reveal.isConnected)return;const k=Math.max(0,Math.min(1,(t-start)/duration));reveal.setAttribute('width',W*(1-Math.pow(1-k,3)));if(k<1)requestAnimationFrame(grow);};
  requestAnimationFrame(grow);
 }
 const legend=$('legend');legend.replaceChildren();
 for(const [kind,label]of spec.legend){const item=element('span');if(kind==='note')item.className='note';else item.append(element('i',undefined,kind));item.append(document.createTextNode(label));legend.append(item);}
 $('empty').textContent=spec.empty;$('empty').classList.toggle('hidden',!spec.empty);
 footer(spec);
 // Crosshair and tooltip follow the nearest point; arrow keys step through points.
 let index=-1;
 const show=i=>{
  const p=spec.hover[i];if(!p)return;index=i;
  const px=x(p.at),py=y(p.remaining),scale=svg.getBoundingClientRect().width/W||1;
  cross.setAttribute('x1',px);cross.setAttribute('x2',px);focus.setAttribute('cx',px);focus.setAttribute('cy',py);svg.classList.add('hovering');
  const time=new Date(p.at).toLocaleString(undefined,{weekday:'short',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});
  tooltip.replaceChildren(element('b',spec.value(p)),element('span',time+(p.projected?' · projected':'')));
  // Break the pooled value down per subscription, in table order.
  if(p.parts&&view.rows.length>1){
   const list=element('ul');
   view.rows.forEach((r,k)=>{
    const item=element('li'),dot=element('i');dot.style.background=color(r.provider);
    item.append(dot,element('span',accountLabel(r.account)+(r.size?.plan&&!noteOf(r.account)?' · '+r.size.plan.replaceAll('_',' '):'')),element('em',spec.part(p.parts[k])));
    list.append(item);
   });
   tooltip.append(list);
  }
  tooltip.style.left=Math.min(W-110,Math.max(110,px))*scale+'px';tooltip.style.top=py*scale+'px';
  // Open below the point when there is no room above it.
  tooltip.classList.toggle('below',py*scale<tooltip.offsetHeight+14);tooltip.classList.add('visible');
 };
 const hide=()=>{index=-1;svg.classList.remove('hovering');tooltip.classList.remove('visible');};
 svg.onpointermove=e=>{
  if(!spec.hover.length)return;
  const r=svg.getBoundingClientRect(),t=spec.start+((e.clientX-r.left)*W/r.width-L)/(W-L-R)*(spec.end-spec.start);
  let best=0;spec.hover.forEach((p,i)=>{if(Math.abs(p.at-t)<Math.abs(spec.hover[best].at-t))best=i;});
  show(best);
 };
 svg.onpointerdown=svg.onpointermove;svg.onpointerleave=hide;svg.onblur=hide;
 svg.onkeydown=e=>{
  if(!spec.hover.length)return;
  if(e.key==='ArrowLeft'||e.key==='ArrowRight'){e.preventDefault();show(Math.max(0,Math.min(spec.hover.length-1,(index<0?spec.hover.length-1:index)+(e.key==='ArrowLeft'?-1:1))));}
  else if(e.key==='Escape')hide();
 };
}
function footer(spec){
 const foot=$('foot');foot.replaceChildren();
 if(mode==='drain'){
  if(spec.hover.length)foot.append(element('span','Peak '+fmt(spec.peak)+'% per hour','lead'));
  foot.append(element('span',($('account').value==='all'?'All accounts':'One subscription')+' · Resets excluded · Estimated between hourly checks','muted'));
  return;
 }
 const {rows,forecasts,now}=view;
 const upcoming=rows.map((r,i)=>({at:Date.parse(r.reset),i})).filter(r=>!rows[r.i].stale&&r.at>now).sort((a,b)=>a.at-b.at);
 if(upcoming.length){
  const next=upcoming.filter(r=>r.at-upcoming[0].at<60000);
  const refill=next.reduce((s,r)=>s+100-Q.valueAt(forecasts[r.i],r.at,-1),0);
  foot.append(element('span','Next reset +'+round(refill)+'% · '+resetLabel(upcoming[0].at),'lead'));
 } else if(rows.length)foot.append(element('span','No upcoming reset known','muted'));
 const learning=rows.filter(r=>!r.stale&&r.rate===null).length;
 if(learning)foot.append(element('span',' · '+plural(learning,'limit')+' still learning pace','muted'));
}
function setMode(next,focus){
 mode=next;
 for(const [id,value]of [['remainingTab','remaining'],['drainTab','drain']]){const tab=$(id);tab.setAttribute('aria-selected',value===mode);tab.tabIndex=value===mode?0:-1;}
 $('horizonRange').classList.toggle('hidden',mode!=='remaining');$('spanRange').classList.toggle('hidden',mode!=='drain');
 placeIndicator();if(focus)$(mode+'Tab').focus();
 draw(true);
}
function placeIndicator(){const tab=$(mode+'Tab'),bar=$('indicator');bar.style.width=tab.offsetWidth+'px';bar.style.transform=`translateX(${tab.offsetLeft}px)`;}
function toggle(button,panel,open){button.setAttribute('aria-expanded',open);panel.classList.toggle('closed',!open);}
const embedded=window.parent!==window&&new URLSearchParams(location.search).get('embedded')==='1';
async function connect(key){if(!key||key===secret)return;generation++;secret=key;$('login').classList.add('hidden');$('dashboard').classList.remove('hidden');$('logout').classList.toggle('hidden',embedded);placeIndicator();render(true);clearInterval(timer);await refresh(false);timer=setInterval(()=>refresh(false),5*60000);}
function disconnect(){generation++;secret='';clearInterval(timer);history=[];accounts=[];view=null;$('dashboard').classList.add('hidden');$('logout').classList.add('hidden');$('login').classList.toggle('hidden',embedded);$('errors').textContent='';$('rows').replaceChildren();$('chart').replaceChildren();}
function setProvider(value){
 const next=typeof value==='string'&&value?value.toLowerCase():null;
 $('providerControl').classList.toggle('hidden',next!==null);
 if(next===consoleProvider)return;
 consoleProvider=next;filterOptions();if(secret)render(true);
}
$('login').addEventListener('submit',e=>{e.preventDefault();const key=$('key').value.trim();$('key').value='';void connect(key);});
$('logout').onclick=disconnect;
if(embedded){
 document.documentElement.classList.add('embedded');$('login').classList.add('hidden');$('pageHead').classList.add('hidden');
 const waiting=element('p','Waiting for the management session…','muted');waiting.id='session-waiting';$('login').after(waiting);
 window.addEventListener('message',event=>{
  if(event.origin!==location.origin||event.source!==window.parent||event.data?.type!=='quota-outlook-session')return;
  const root=document.documentElement,dark=event.data.theme==='dark';
  // Adopt the console's live design tokens so every console theme is matched exactly.
  for(const [name,value]of Object.entries(event.data.vars||{}))if(/^--[a-z0-9-]+$/.test(name)&&name!=='--accent'&&typeof value==='string'&&value&&value.length<300)root.style.setProperty(name,value);
  root.dataset.theme=dark?'dark':'light';root.style.colorScheme=dark?'dark':'light';
  setProvider(event.data.provider);
  const auth=event.data.authorization;
  const key=typeof auth==='string'&&/^Bearer\s+/i.test(auth)?auth.replace(/^Bearer\s+/i,''):'';
  waiting.classList.toggle('hidden',Boolean(key));
  if(key)void connect(key);else disconnect();
 });
 const resize=()=>window.parent.postMessage({type:'quota-outlook-height',height:Math.ceil(document.querySelector('main').getBoundingClientRect().height)+2},location.origin);
 new ResizeObserver(resize).observe(document.querySelector('main'));
 // DOM changes also resize the section when the browser defers layout observers in background tabs.
 new MutationObserver(resize).observe(document.body,{childList:true,subtree:true,characterData:true});
 resize();
 window.parent.postMessage({type:'quota-outlook-ready'},location.origin);
 window.addEventListener('pagehide',()=>{generation++;secret='';clearInterval(timer);});
}
new ResizeObserver(()=>{placeIndicator();if(view&&Math.round($('plot').clientWidth)!==drawnWidth)draw(false);}).observe($('plot'));
$('refresh').onclick=()=>refresh(true);
$('labels').onchange=()=>{filterOptions();render(false);};
$('provider').onchange=()=>{filterOptions();render(true);};
for(const id of ['account','limit','lookback'])$(id).onchange=()=>render(true);
for(const id of ['horizon','span'])$(id).onchange=()=>draw(true);
$('remainingTab').onclick=()=>setMode('remaining');$('drainTab').onclick=()=>setMode('drain');
for(const id of ['remainingTab','drainTab'])$(id).onkeydown=e=>{if(e.key==='ArrowLeft'||e.key==='ArrowRight'){e.preventDefault();setMode(mode==='remaining'?'drain':'remaining',true);}};
$('collapse').onclick=()=>{const open=$('collapse').getAttribute('aria-expanded')!=='true';toggle($('collapse'),$('body'),open);$('collapse').title=open?'Collapse':'Expand';};
$('settingsToggle').onclick=()=>toggle($('settingsToggle'),$('settings'),$('settingsToggle').getAttribute('aria-expanded')!=='true');
