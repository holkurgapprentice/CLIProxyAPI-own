/* Fork-owned management quota outlook. No credential persistence. */
'use strict';
const Q=QuotaMath,$=id=>document.getElementById(id),HOUR=3600000,DAY=24*HOUR;
// The chart window spans two weeks and opens three days before now; forecast stats look two weeks ahead.
const SPAN=14*DAY,LEAD=3*DAY,HORIZON=14*DAY,STEP_DAYS=7,MAX_OFFSET=14;
const colors={claude:'#d97757',codex:'#6f93e8',gemini:'#4fb3bb',antigravity:'#a77bea',kimi:'#c9a227',xai:'#8f94c8',devin:'#4fae8c',meta:'#5b8def'};
const ORDER=['claude','codex','antigravity','gemini','kimi','xai','devin','meta'];
const palette=['#4fae8c','#d670a0','#c9a227','#a77bea'];
const color=p=>colors[p]||palette[[...p].reduce((a,c)=>a+c.charCodeAt(0),0)%palette.length];
const brand=window.UsageInsightsIcons||{icons:{},labels:{},aliases:{},tiled:[]};
const family=p=>{const k=String(p||'').trim().toLowerCase().replace(/_/g,'-');return brand.aliases[k]||k;};
const providerLabel=p=>brand.labels[family(p)]||(p?p.charAt(0).toUpperCase()+p.slice(1):'');
const reduced=matchMedia('(prefers-reduced-motion: reduce)');
// Multipliers applied to the measured burn for each future usage choice.
const FUTURE={same:1,half:.5,double:2,none:0};
let secret='',history=[],accounts=[],tokens=null,tokenError='',timer=null,busy=false,usageRun=0,mode='remaining',generation=0,consoleProvider=null,view=null;
let burnHours=3,offset=0,theme='light',accountsKey='';
const excluded=new Set(),cardNodes=new Map();
const fmt=n=>n===null||!Number.isFinite(n)?'—':n.toFixed(1);
const round=n=>Math.round(n).toLocaleString();
const pct=n=>round(n)+'%';
const compact=n=>new Intl.NumberFormat(undefined,{notation:'compact',maximumFractionDigits:1}).format(n||0);
const plural=(n,word)=>n+' '+word+(n===1?'':'s');
const title=s=>s.replaceAll('_',' ').replace(/\b\w/g,c=>c.toUpperCase());
function when(t){
 if(!Number.isFinite(t))return 'Unknown';
 const soon=t-Date.now()<6*DAY;
 return new Date(t).toLocaleString(undefined,soon?{weekday:'short',hour:'numeric',minute:'2-digit'}:{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});
}
const day=t=>new Date(t).toLocaleDateString(undefined,{month:'short',day:'numeric'});
function duration(ms){
 const m=Math.max(1,Math.round(ms/60000)),d=Math.floor(m/1440),h=Math.floor(m%1440/60);
 return d?d+'d '+h+'h':h?h+'h '+m%60+'m':m+'m';
}
function element(tag,text,cls){const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;}
function svgNode(tag,attrs={},text){const n=document.createElementNS('http://www.w3.org/2000/svg',tag);for(const [k,v]of Object.entries(attrs))n.setAttribute(k,String(v));if(text!==undefined)n.textContent=text;return n;}
// Provider emblems copied from the console, shared with the model usage page.
function icon(name){
 const key=family(name),src=brand.icons[key],wrap=element('span',undefined,'icon');
 if(src){const img=element('img');img.alt='';img.src=typeof src==='string'?src:src[theme]||src.light;wrap.append(img);if(brand.tiled.includes(key))wrap.style.background=theme==='dark'?'#ffffff':'#000000';}
 else{wrap.style.background=color(name);wrap.append(element('b',providerLabel(name).slice(0,1).toUpperCase()));}
 return wrap;
}
async function api(path,data){
 const response=await fetch('/v8/management/'+path,{method:data?'POST':'GET',headers:{Authorization:'Bearer '+secret,'Content-Type':'application/json'},body:data?JSON.stringify(data):undefined,cache:'no-store'});
 if(!response.ok)throw new Error(response.status===401||response.status===403?'Management authentication failed':'Management request failed, HTTP '+response.status);
 return response.json();
}
const providerOf=a=>a.provider||a.type;
const provider=()=>consoleProvider??$('provider').value;
// A credential note set in the auth file editor names the subscription everywhere.
const noteOf=id=>{const note=accounts.find(a=>a.auth_index===id)?.note;return typeof note==='string'?note.trim():'';};
function accountLabel(id){const a=accounts.find(a=>a.auth_index===id);if(!a)return 'Removed subscription';if(noteOf(id))return noteOf(id);const base=providerLabel(providerOf(a))+' subscription '+(accounts.indexOf(a)+1);const label=a.label||a.email||a.name;return $('labels').checked&&label?base+' · '+label:base;}
function filterOptions(){
 const p=$('provider').value;
 $('provider').replaceChildren(new Option('All providers','all'));
 for(const name of [...new Set(accounts.map(providerOf))])$('provider').add(new Option(providerLabel(name),name));
 if([...$('provider').options].some(o=>o.value===p))$('provider').value=p;
}
// Chart window: whole days, moved in week steps. History-only views end with today instead of showing an empty future.
function range(now){const d=new Date(now-(mode==='remaining'?LEAD:SPAN-DAY));d.setHours(0,0,0,0);const start=d.getTime()+offset*DAY;return {start,end:start+SPAN};}
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
  busy=false;render(first);
 }catch(error){if(run===generation){$('errors').textContent=error.message;busy=false;render(false);}}
 finally{busy=false;$('refresh').disabled=false;}
}
// Raw provider-reported tokens for the chart window, never model or price weighted. Split per provider in the browser.
async function loadTokens(){
 if(!secret)return;
 const now=Date.now(),{start,end}=range(now),run=++usageRun;
 tokenError='';tokens=null;
 if(start>=now){tokens={timeline:[]};if(mode==='tokens'&&view)renderCards(false);return;}
 const params=new URLSearchParams({from:new Date(start).toISOString()});
 if(end<now)params.set('to',new Date(end).toISOString());
 if(mode==='tokens'&&view)renderCards(false);
 try{
  const saved=await api('observability/usage/insights?'+params);
  if(run!==usageRun)return;
  tokens=saved;
 }catch(error){if(run===usageRun)tokenError=error.message;}
 if(run===usageRun&&mode==='tokens'&&view)renderCards(false);
}
// Limit series of the selection, grouped by provider. One kind of limit at a time; mixing windows would make totals meaningless.
function groups(){
 const result=new Map(),short=$('limit').value==='short',long=short?null:new Set(Q.accountLong(history));
 const known=new Set(accounts.map(a=>a.auth_index)),p=provider();
 for(const s of history){
  if(!known.has(s.account)||excluded.has(s.account))continue;
  if(p!=='all'&&s.provider!==p)continue;
  if(short?!Q.accountShort(s):!long.has(s))continue;
  const id=Q.key(s);if(!result.has(id))result.set(id,[]);result.get(id).push(s);
 }
 const byProvider=new Map();
 for(const series of result.values()){const name=series[0].provider;if(!byProvider.has(name))byProvider.set(name,[]);byProvider.get(name).push(series);}
 return byProvider;
}
const rank=p=>{const i=ORDER.indexOf(p);return i<0?ORDER.length:i;};
const risky=r=>!r.stale&&(r.status==='Runs out before reset'||r.status==='Exhausted');
// One provider's pool: the proxy spreads that provider's work across its subscriptions.
function pool(name,series,now,until){
 const rows=series.map(s=>Q.outlook(s,now,168)),plans=series.map(s=>s.findLast(x=>x.plan)?.plan);
 const sized=Q.sizes(rows.map((r,i)=>({provider:name,plan:plans[i],measured:Q.capacity(series[i])})));
 // Sizes are relative to the median subscription and rounded, so the pool reads as e.g. 100% + 250%.
 const caps=sized.map(s=>s.capacity),sorted=[...caps].sort((a,b)=>a-b),base=sorted[Math.floor((sorted.length-1)/2)]||1;
 const weights=caps.map(c=>Math.max(.1,Math.round(c/base*10)/10)),future=$('future').value;
 rows.forEach((r,i)=>{
  r.weight=weights[i];r.source=sized[i].source;r.plan=plans[i];
  r.burn=r.stale?null:Q.burn(series[i],burnHours);
  const current=r.burn??r.rate;
  r.future=future==='average'?r.rate:future==='none'?0:current===null?null:current*FUTURE[future];
 });
 // Stale limits and limits without a known reset stay flat.
 const forecasts=rows.map(r=>[{at:now,remaining:r.remaining}]),members=rows.map((r,i)=>i).filter(i=>!rows[i].stale&&rows[i].hoursToReset!==null);
 if(members.length){
  const lists=Q.poolForecast(members.map(i=>({...rows[i],rate:rows[i].future,capacity:caps[i]})),now,until);
  members.forEach((i,k)=>{
   const r=rows[i];forecasts[i]=lists[k];
   if(r.future===null||r.status==='Exhausted')return;
   r.projected=Q.valueAt(lists[k],Date.parse(r.reset),-1);
   r.status=r.projected<=0?'Runs out before reset':r.projected<10?'Close to limit':'On pace';
  });
 }
 const horizon=now+HORIZON,pooled=Q.sumForecast(forecasts,now,horizon,weights);
 let first=null;
 for(const i of members){const at=Q.emptyAt(forecasts[i],now);if(at!==null&&at<=horizon&&(!first||at<first.at))first={at,account:rows[i].account};}
 const upcoming=members.map(i=>({at:Date.parse(rows[i].reset),i})).filter(u=>u.at>now).sort((a,b)=>a.at-b.at);
 let next=null;
 if(upcoming.length){
  const group=upcoming.filter(u=>u.at-upcoming[0].at<60000);
  next={at:upcoming[0].at,gain:group.reduce((s,u)=>s+(100-Q.valueAt(forecasts[u.i],u.at,-1))*weights[u.i],0)};
 }
 const burned=rows.some(r=>r.burn!==null);
 return {name,series,rows,weights,forecasts,horizon,first,next,
  remaining:rows.reduce((s,r,i)=>s+r.remaining*weights[i],0),capacity:100*weights.reduce((a,b)=>a+b,0),
  burn:burned?rows.reduce((s,r,i)=>s+(r.burn??0)*weights[i],0):null,poolEmpty:Q.emptyAt(pooled,now)};
}
function render(animate){
 const now=Date.now(),{start,end}=range(now),byProvider=groups();
 const names=[...byProvider.keys()].sort((a,b)=>rank(a)-rank(b)||a.localeCompare(b));
 view={now,start,end,cards:names.map(n=>pool(n,byProvider.get(n),now,Math.max(end,now+HORIZON)))};
 $('rangeLabel').textContent=day(start)+' to '+day(end-1);
 $('rangeLabel').classList.toggle('moved',offset!==0);$('rangeLabel').title=offset?'Back to now':'';
 $('prev').disabled=offset<=-MAX_OFFSET;$('next').disabled=offset>=MAX_OFFSET;
 accountList();table();renderCards(animate);
}
// Accounts with quota history for the current provider; unchecked ones are left out of every pool.
function accountList(){
 const p=provider(),ids=[...new Set(history.filter(s=>p==='all'||s.provider===p).map(s=>s.account))].filter(id=>accounts.some(a=>a.auth_index===id));
 ids.sort((a,b)=>rank(providerOf(accounts.find(x=>x.auth_index===a)))-rank(providerOf(accounts.find(x=>x.auth_index===b))));
 const counted=ids.filter(id=>!excluded.has(id)).length;
 $('accountsToggle').textContent=ids.length&&counted<ids.length?'Accounts '+counted+'/'+ids.length:'Accounts';
 const key=JSON.stringify(ids.map(id=>[id,accountLabel(id),excluded.has(id)]));
 if(key===accountsKey)return;
 accountsKey=key;
 const list=$('accountList');list.replaceChildren();
 for(const id of ids){
  const label=element('label',undefined,'check'),box=element('input'),dot=element('i');
  box.type='checkbox';box.checked=!excluded.has(id);dot.style.background=color(providerOf(accounts.find(a=>a.auth_index===id)));
  box.onchange=()=>{if(box.checked)excluded.delete(id);else excluded.add(id);render(true);};
  label.append(box,dot,document.createTextNode(accountLabel(id)));list.append(label);
 }
}
function countTo(el,value,write,kind,animate){
 const from=Number(el.dataset.value),same=el.dataset.kind===kind;el.dataset.value=value;el.dataset.kind=kind;
 if(reduced.matches||!animate&&!same||from===value||!Number.isFinite(value)){el.textContent=write(value);return;}
 const start=performance.now(),origin=same&&Number.isFinite(from)?from:0;
 const step=t=>{if(Number(el.dataset.value)!==value)return;const k=Math.min(1,(t-start)/800);el.textContent=write(origin+(value-origin)*(1-Math.pow(1-k,4)));if(k<1)requestAnimationFrame(step);};
 requestAnimationFrame(step);
}
function cardNode(name){
 let c=cardNodes.get(name);if(c)return c;
 const root=element('article',undefined,'card');root.style.setProperty('--accent',color(name));
 const head=element('header',undefined,'card-head'),count=element('span','','muted');
 head.append(icon(name),element('b',providerLabel(name)),count);
 const sum=element('div',undefined,'card-sum'),headline=element('div',undefined,'headline'),big=element('span','—','big'),of=element('span','','of'),sizes=element('span','','sizes'),alert=element('span','','alert hidden'),stats=element('dl',undefined,'stats');
 headline.setAttribute('aria-live','polite');headline.append(big,of,sizes,alert);sum.append(headline,stats);
 const plot=element('div',undefined,'plot'),svg=svgNode('svg',{class:'chart',tabindex:0,role:'img'}),pill=element('div',undefined,'pill'),empty=element('div','','empty hidden');
 pill.setAttribute('aria-hidden','true');plot.append(svg,pill,empty);
 const legend=element('div',undefined,'legend');
 root.append(head,sum,plot,legend);
 c={root,count,big,of,sizes,alert,stats,plot,svg,pill,empty,legend,width:0};cardNodes.set(name,c);
 return c;
}
function clearCards(){for(const c of cardNodes.values())c.root.remove();cardNodes.clear();}
function renderCards(animate){
 if(!view)return;
 const box=$('cards'),keep=new Set(view.cards.map(c=>c.name));
 for(const [name,c]of cardNodes)if(!keep.has(name)){c.root.remove();cardNodes.delete(name);}
 view.cards.forEach((card,k)=>{
  card.dom=cardNode(card.name);
  if(box.children[k]!==card.dom.root)box.insertBefore(card.dom.root,box.children[k]||null);
  card.spec=chartSpec(card);summary(card,animate);draw(card,animate);
 });
 const empty=$('cardsEmpty');empty.classList.toggle('hidden',view.cards.length>0);
 empty.textContent=busy||!history.length?'Loading quota history…':'No quota history for this selection. Try another limit kind or include more accounts. Unsupported subscriptions are never counted as safe.';
}
function summary(card,animate){
 const c=card.dom,rows=card.rows,spec=card.spec,now=view.now;
 c.count.textContent=plural(new Set(rows.map(r=>r.account)).size,'account');
 c.alert.classList.add('hidden');c.sizes.textContent='';
 const stat=(label,value,note)=>{const d=element('div'),dd=element('dd',value);if(note)dd.append(' ',element('small',note));d.append(element('dt',label),dd);return d;};
 if(mode==='remaining'){
  countTo(c.big,card.remaining,pct,'remaining',animate);c.of.textContent='of '+pct(card.capacity);
  c.sizes.textContent=[...new Set(rows.filter(r=>r.weight!==1).map(r=>(r.plan?title(r.plan):accountLabel(r.account))+' = '+r.weight+'x'))].join(' · ');
  const atRisk=rows.filter(risky).length;
  if(atRisk){c.alert.textContent=plural(atRisk,'limit')+' '+(atRisk===1?'runs':'run')+' out before reset';c.alert.classList.remove('hidden');}
  const by='by '+day(card.horizon),soon=t=>t-now<60000;
  c.stats.replaceChildren(
   stat('Pool empty',card.poolEmpty===null?'Not '+by:soon(card.poolEmpty)?'Now':when(card.poolEmpty)),
   card.first?stat('First empty',accountLabel(card.first.account),soon(card.first.at)?'now':'in '+duration(card.first.at-now)):stat('First empty','None '+by),
   stat('Next reset',card.next?'+'+pct(card.next.gain):'Unknown',card.next?when(card.next.at):''),
   stat('Burn, last '+burnHours+'h',card.burn===null?'Learning':fmt(card.burn)+'%/h'));
  return;
 }
 if(mode==='drain'){
  countTo(c.big,card.burn??NaN,v=>Number.isFinite(v)?fmt(v)+'%/h':'—','drain',animate);c.of.textContent='burn, last '+burnHours+'h';
  c.stats.replaceChildren(stat('Peak in range',spec.peak===null?'—':fmt(spec.peak)+'%/h'),stat('Average in range',spec.average===null?'—':fmt(spec.average)+'%/h'),
   stat('Measured limits',rows.filter(r=>r.burn!==null).length+' of '+rows.length));
  return;
 }
 countTo(c.big,tokens?spec.total:NaN,v=>Number.isFinite(v)?compact(v):'—','tokens',animate);c.of.textContent='tokens in range';
 c.stats.replaceChildren(stat('Execution attempts',tokens?round(spec.attempts):'—'),stat('Without token counts',tokens?round(spec.missing):'—'),
  stat('Busiest '+spec.step/HOUR+'h',tokens&&spec.peak?compact(spec.peak):'—'));
}
function table(){
 const body=$('rows');body.replaceChildren();
 const rows=view.cards.flatMap(c=>c.rows);
 for(const r of rows){
  const tr=element('tr'),who=element('td'),wrap=element('div',undefined,'who'),dot=element('i');
  dot.style.background=color(r.provider);
  const name=element('span',accountLabel(r.account));name.append(document.createElement('br'),element('small',r.limit.replaceAll('_',' ')+(r.plan?' · '+r.plan.replaceAll('_',' '):'')));
  wrap.append(dot,name);who.append(wrap);
  const status=element('td'),badge=element('span',r.status,'badge'+(r.status==='On pace'?' safe':risky(r)?' risk':''));status.append(badge);
  const size=element('td',r.weight+'×','num');size.append(element('small',' '+r.source));
  tr.append(who,element('td',fmt(r.remaining)+'%','num'),size,element('td',r.burn===null?'—':fmt(r.burn)+'%','num'),element('td',r.future===null?'—':fmt(r.future)+'%','num'),
   element('td',r.stale||r.projected===null?'—':fmt(Math.max(0,r.projected))+'%','num'),element('td',when(Date.parse(r.reset))),status);
  body.append(tr);
 }
 if(!rows.length){const tr=element('tr'),td=element('td','No observations for this selection. Try another limit kind. Unsupported subscriptions are listed above and are never counted as safe.','muted');td.colSpan=8;tr.append(td);body.append(tr);}
}
// Rounded axis maximum with four equal steps.
function niceMax(peak){
 const raw=Math.max(peak,1)*1.1/4,mag=10**Math.floor(Math.log10(raw)),step=[1,2,2.5,5,10].map(m=>m*mag).find(s=>s>=raw);
 return step*4;
}
function segments(points){
 const out=[];let current=[];
 for(const p of points){if(p.remaining===null){if(current.length)out.push(current);current=[];}else current.push(p);}
 if(current.length)out.push(current);
 return out;
}
const quarters=max=>[0,.25,.5,.75,1].map(f=>f*max);
function chartSpec(card){
 const {now,start,end}=view,{series,rows,weights,forecasts}=card,past=Math.min(now,end),step=Math.max(60000,(end-start)/300);
 const weigh=parts=>parts.reduce((s,v,k)=>s+v*weights[k],0);
 if(mode==='remaining'){
  const observed=start<now?Q.sumHistory(series,start,past,step,weights):[],from=Math.max(now,start);
  const projected=end>now?Q.sumForecast(forecasts,from,end,weights):[];
  // The forecast only bends at resets and depletions, so add evenly spaced hover stops on whole hours.
  const every=Math.max(1,Math.round((end-start)/HOUR/80)),stop=new Date(from),stops=[];
  stop.setHours(Math.ceil((stop.getHours()+1)/every)*every,0,0,0);
  if(end>now)for(let t=stop.getTime();t<end;t+=every*HOUR){const parts=forecasts.map(l=>Q.valueAt(l,t));stops.push({at:t,remaining:weigh(parts),parts});}
  // Hover the later value at refills so the pill shows the refilled total.
  const known=observed.filter(p=>p.remaining!==null&&p.at<now);
  const ahead=[...projected,...stops.filter(s=>!projected.some(p=>p.at===s.at))].sort((a,b)=>a.at-b.at);
  const hover=[...known,...ahead.map(p=>({...p,projected:true}))].filter((p,i,list)=>list[i+1]?.at!==p.at);
  const learning=rows.filter(r=>!r.stale&&r.future===null).length;
  return {max:card.capacity,ticks:[0,.5,1].map(f=>f*card.capacity),axis:pct,lines:[{points:observed},{points:projected,projected:true}],
   refills:[...Q.refills(observed),...Q.refills(projected)],hover,nowValue:card.remaining,
   legend:[['solid','Recorded'],['dash','Projected']],note:learning?plural(learning,'limit')+' still learning pace':'',
   value:p=>pct(p.remaining)+' left',part:v=>v===null?'—':pct(v),
   empty:known.length||projected.length?'':'No quota history in this period.'};
 }
 if(mode==='drain'){
  const points=start<now?Q.drain(series,start,past,step,burnHours*HOUR,weights):[],measured=points.filter(p=>p.remaining!==null);
  const peak=measured.length?Math.max(...measured.map(p=>p.remaining)):null,max=niceMax(peak??0);
  return {max,ticks:quarters(max),axis:v=>Number(v.toFixed(2))+'%',lines:[{points}],refills:[],hover:measured,peak,
   average:measured.length?measured.reduce((s,p)=>s+p.remaining,0)/measured.length:null,
   legend:[['solid',burnHours+'-hour average']],note:'% per hour · resets excluded · estimated between hourly checks',
   value:p=>fmt(p.remaining)+'%/h',part:v=>v===null?'—':fmt(v)+'%/h',
   empty:start>=now?'Drain is measured from history. Move the range back to see it.':measured.length?'':'Not enough continuous history to measure drain yet.'};
 }
 const bucket=Math.max(HOUR,Math.round((end-start)/HOUR/120)*HOUR),count=start<past?Math.ceil((past-start)/bucket):0;
 const points=Array.from({length:count},(_,i)=>({at:start+i*bucket,remaining:0}));
 let total=0,attempts=0,missing=0;
 for(const b of tokens?.timeline||[]){
  const at=Date.parse(b.at);
  if(family(b.provider)!==card.name||!(at>=start&&at<past))continue;
  points[Math.floor((at-start)/bucket)].remaining+=b.total||0;total+=b.total||0;attempts+=b.attempts||0;missing+=b.no_reported_tokens||0;
 }
 const peak=Math.max(0,...points.map(p=>p.remaining)),max=niceMax(peak);
 return {max,ticks:quarters(max),axis:compact,lines:[{points}],refills:[],hover:points,total,attempts,missing,peak,step:bucket,
  legend:[['solid','Tokens per '+bucket/HOUR+' hours']],note:'All accounts · reported input, cached input and output',
  value:p=>round(p.remaining)+' tokens',part:v=>round(v),
  empty:start>=now?'Token usage is recorded history. Move the range back to see it.':tokens?(total?'':'No reported tokens for this provider in this period.'):tokenError||'Loading token history…'};
}
function draw(card,animate){
 const c=card.dom,svg=c.svg,spec=card.spec,{now,start,end}=view;
 const W=Math.max(280,Math.round(c.plot.clientWidth)),H=260,L=46,R=12,T=30,B=26;c.width=W;
 const x=t=>L+(t-start)/(end-start)*(W-L-R),y=v=>T+(1-Math.min(spec.max,Math.max(0,v))/spec.max)*(H-T-B),base=y(0);
 svg.setAttribute('viewBox',`0 0 ${W} ${H}`);
 svg.setAttribute('aria-label',providerLabel(card.name)+' '+(mode==='remaining'?'pooled remaining quota':mode==='drain'?'pooled drain rate':'token usage'));
 svg.classList.remove('hovering');c.pill.classList.remove('visible');svg.replaceChildren();
 const id=card.name.replace(/[^a-z0-9]/gi,''),defs=svgNode('defs');
 for(const [kind,top]of [['observed',.32],['projected',.14]]){
  const gradient=svgNode('linearGradient',{id:`fill-${id}-${kind}`,gradientUnits:'userSpaceOnUse',x1:0,y1:T,x2:0,y2:base});
  gradient.append(svgNode('stop',{offset:0,class:'stop','stop-opacity':top}),svgNode('stop',{offset:1,class:'stop','stop-opacity':0}));
  defs.append(gradient);
 }
 const clip=svgNode('clipPath',{id:'reveal-'+id}),reveal=svgNode('rect',{x:0,y:0,width:animate&&!reduced.matches?0:W,height:H});
 clip.append(reveal);defs.append(clip);svg.append(defs);
 const axes=svgNode('g',{class:animate?'fade':''});
 spec.ticks.forEach((v,i)=>axes.append(svgNode('line',{x1:L,x2:W-R,y1:y(v),y2:y(v),class:i?'grid':'base','stroke-dasharray':i?'2 4':'none'}),svgNode('text',{x:L-10,y:y(v)+4,'text-anchor':'end'},spec.axis(v))));
 // Day labels centred on each day, thinned on narrow charts.
 const days=[],d=new Date(start);d.setHours(0,0,0,0);
 for(;d.getTime()<end;d.setDate(d.getDate()+1))if(d.getTime()>=start)days.push(d.getTime());
 const every=Math.max(1,Math.ceil(days.length*58/(W-L-R)));
 days.forEach((t,i)=>{if(i%every)return;const dt=new Date(t);axes.append(svgNode('text',{x:x(t+DAY/2),y:H-6,'text-anchor':'middle'},dt.toLocaleDateString(undefined,{weekday:'short'})+' '+dt.getDate()));});
 svg.append(axes);
 const data=svgNode('g',{'clip-path':`url(#reveal-${id})`});
 for(const line of spec.lines)for(const segment of segments(line.points)){
  const path=segment.map((p,i)=>(i?'L':'M')+x(p.at).toFixed(1)+' '+y(p.remaining).toFixed(1)).join(' ');
  data.append(svgNode('path',{d:path+` L${x(segment.at(-1).at).toFixed(1)} ${base} L${x(segment[0].at).toFixed(1)} ${base} Z`,fill:`url(#fill-${id}-${line.projected?'projected':'observed'})`}));
  data.append(svgNode('path',{d:path,class:'line'+(line.projected?' projected':'')}));
 }
 // Label each refill with the quota it adds; skip labels that would overlap.
 let lastLabel=-Infinity;
 for(const r of spec.refills){
  const rx=x(r.at);
  if(rx<L||rx>W-R||rx-lastLabel<34)continue;
  lastLabel=rx;data.append(svgNode('text',{x:rx,y:Math.max(T-6,y(r.remaining)-7),'text-anchor':'middle',class:'refill'},'+'+pct(r.gain)));
 }
 svg.append(data);
 if(now>start&&now<end){
  const nx=x(now);
  svg.append(svgNode('line',{x1:nx,x2:nx,y1:T-12,y2:base,class:'now'}),svgNode('text',{x:nx,y:T-16,'text-anchor':'middle',class:'now-label'},'Now'));
  if(spec.nowValue!==undefined)svg.append(svgNode('circle',{cx:nx,cy:y(spec.nowValue),r:3.5,class:'now-dot'}));
 }
 const cross=svgNode('line',{y1:T,y2:base,class:'cross'}),focus=svgNode('circle',{r:4,class:'focus'});
 svg.append(cross,focus);
 if(animate&&!reduced.matches){
  const begin=performance.now(),length=1000;
  const grow=t=>{if(!reveal.isConnected)return;const k=Math.max(0,Math.min(1,(t-begin)/length));reveal.setAttribute('width',W*(1-Math.pow(1-k,3)));if(k<1)requestAnimationFrame(grow);};
  requestAnimationFrame(grow);
 }
 c.legend.replaceChildren(element('span',mode==='tokens'?'Provider':'Pool','muted'));
 for(const [kind,label]of spec.legend){const item=element('span');item.append(element('i',undefined,kind==='dash'?'dash':''),document.createTextNode(label));c.legend.append(item);}
 if(spec.note)c.legend.append(element('span',spec.note,'note'));
 c.empty.textContent=spec.empty;c.empty.classList.toggle('hidden',!spec.empty);
 // Crosshair and pill follow the nearest point; arrow keys step through points.
 let index=-1;
 const show=i=>{
  const p=spec.hover[i];if(!p)return;index=i;
  const px=x(p.at),py=y(p.remaining),scale=svg.getBoundingClientRect().width/W||1;
  cross.setAttribute('x1',px);cross.setAttribute('x2',px);focus.setAttribute('cx',px);focus.setAttribute('cy',py);svg.classList.add('hovering');
  const time=new Date(p.at).toLocaleString(undefined,{weekday:'short',day:'numeric',hour:'numeric',minute:'2-digit'});
  const head=element('div');head.append(time+' · ',element('b',spec.value(p)),p.projected?' · projected':'');
  c.pill.replaceChildren(head);
  // Break the pooled value down per subscription, unscaled, in table order.
  if(p.parts&&card.rows.length>1){
   const list=element('ul');
   card.rows.forEach((r,k)=>{const item=element('li');item.append(element('i'),element('span',accountLabel(r.account)+(r.weight!==1?' · '+r.weight+'x':'')),element('em',spec.part(p.parts[k])));list.append(item);});
   c.pill.append(list);
  }
  // Keep the pill on the side away from the pointer.
  c.pill.classList.toggle('left',px*scale>c.plot.clientWidth*.55);c.pill.classList.add('visible');
 };
 const hide=()=>{index=-1;svg.classList.remove('hovering');c.pill.classList.remove('visible');};
 svg.onpointermove=e=>{
  if(!spec.hover.length)return;
  const r=svg.getBoundingClientRect(),t=start+((e.clientX-r.left)*W/r.width-L)/(W-L-R)*(end-start);
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
function setMode(next,focus){
 mode=next;
 for(const [tabId,value]of [['remainingTab','remaining'],['drainTab','drain'],['tokensTab','tokens']]){const tab=$(tabId);tab.setAttribute('aria-selected',value===mode);tab.tabIndex=value===mode?0:-1;}
 $('burnGroup').classList.toggle('hidden',mode==='tokens');$('futureGroup').classList.toggle('hidden',mode!=='remaining');
 if(focus)$(mode+'Tab').focus();
 if(view)render(true);
 if(mode==='tokens')loadTokens();
}
function move(days){offset=Math.max(-MAX_OFFSET,Math.min(MAX_OFFSET,days));render(true);loadTokens();}
function toggle(button,panel,open){button.setAttribute('aria-expanded',open);panel.classList.toggle('closed',!open);}
const embedded=window.parent!==window&&new URLSearchParams(location.search).get('embedded')==='1';
async function connect(key){if(!key||key===secret)return;generation++;secret=key;$('login').classList.add('hidden');$('dashboard').classList.remove('hidden');$('logout').classList.toggle('hidden',embedded);render(true);clearInterval(timer);await Promise.all([refresh(false),loadTokens()]);timer=setInterval(()=>{refresh(false);loadTokens();},5*60000);}
function disconnect(){generation++;usageRun++;secret='';clearInterval(timer);history=[];accounts=[];tokens=null;tokenError='';view=null;accountsKey='';clearCards();$('dashboard').classList.add('hidden');$('logout').classList.add('hidden');$('login').classList.toggle('hidden',embedded);$('errors').textContent='';$('rows').replaceChildren();$('accountList').replaceChildren();}
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
  // Emblems differ per theme, so rebuild the cards when it changes.
  if(theme!==root.dataset.theme){theme=root.dataset.theme;if(view){clearCards();renderCards(false);}}
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
}else{
 theme=matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';
}
new ResizeObserver(()=>{if(view&&view.cards.some(card=>card.dom&&Math.round(card.dom.plot.clientWidth)!==card.dom.width))for(const card of view.cards)if(card.dom)draw(card,false);}).observe($('cards'));
$('refresh').onclick=()=>{refresh(true);loadTokens();};
$('labels').onchange=()=>render(false);
$('provider').onchange=()=>render(true);
$('limit').onchange=()=>render(true);
$('future').onchange=()=>render(true);
for(const button of $('burn').querySelectorAll('button'))button.onclick=()=>{
 burnHours=Number(button.dataset.hours);
 for(const other of $('burn').querySelectorAll('button'))other.setAttribute('aria-pressed',other===button);
 render(true);
};
$('prev').onclick=()=>move(offset-STEP_DAYS);$('next').onclick=()=>move(offset+STEP_DAYS);$('rangeLabel').onclick=()=>{if(offset)move(0);};
$('remainingTab').onclick=()=>setMode('remaining');$('drainTab').onclick=()=>setMode('drain');$('tokensTab').onclick=()=>setMode('tokens');
for(const tabId of ['remainingTab','drainTab','tokensTab'])$(tabId).onkeydown=e=>{if(e.key==='ArrowLeft'||e.key==='ArrowRight'){e.preventDefault();const modes=['remaining','drain','tokens'],step=e.key==='ArrowLeft'?-1:1;setMode(modes[(modes.indexOf(mode)+step+modes.length)%modes.length],true);}};
$('accountsToggle').onclick=()=>toggle($('accountsToggle'),$('accountsPanel'),$('accountsToggle').getAttribute('aria-expanded')!=='true');
