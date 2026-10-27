/* Pure quota calculations shared by the browser and deterministic Node tests. */
(function (root) {
'use strict';
const HOUR=3600000,STALE=3*HOUR,SAME_RESET=60000;
const key=s=>JSON.stringify([s.account,s.provider,s.limit]);
const sameCycle=(a,b)=>b.remaining<=a.remaining+0.01&&!(Math.abs(b.reset-a.reset)>SAME_RESET);
// Observations in time order, plus an assumed full quota at the start of each observed cycle.
function timeline(samples) {
 const points=[];
 for(const s of [...samples].sort((a,b)=>Date.parse(a.at)-Date.parse(b.at))) {
  const p={at:Date.parse(s.at),remaining:s.remaining,reset:Date.parse(s.reset)},previous=points.at(-1);
  const start=p.reset-(s.windowHours||0)*HOUR;
  if(s.windowHours>0&&Number.isFinite(start)&&start<p.at&&(!previous||(!sameCycle(previous,p)&&start>previous.at)))points.push({at:start,remaining:100,reset:p.reset,assumed:true});
  points.push(p);
 }
 return points;
}
// Consumption between consecutive points of the same cycle. Refills are never negative consumption.
function intervals(samples) {
 const points=timeline(samples),result=[];
 for(let i=1;i<points.length;i++) {
  const a=points[i-1],b=points[i];
  if(b.at>a.at&&sameCycle(a,b))result.push({from:a.at,to:b.at,drop:Math.max(0,a.remaining-b.remaining)});
 }
 return result;
}
// Pace is the average consumption over the lookback, across reset cycles. It is averaged over at
// least a full day (or the whole lookback when shorter), so a busy session early in a cycle is not
// projected around the clock: usage so far counts as that day's usage.
function outlook(samples,now=Date.now(),lookbackHours=168) {
 const sorted=[...samples].sort((a,b)=>Date.parse(a.at)-Date.parse(b.at));
 if(!sorted.length)return null;
 const latest=sorted.at(-1),latestTime=Date.parse(latest.at),reset=Date.parse(latest.reset);
 const cutoff=now-lookbackHours*HOUR;
 let consumed=0,observed=0;
 for(const i of intervals(sorted)) {
  const from=Math.max(i.from,cutoff);
  if(i.to<=from)continue;
  consumed+=i.drop*(i.to-from)/(i.to-i.from);observed+=i.to-from;
 }
 const stale=now-latestTime>STALE;
 const rate=observed>=HOUR?consumed/(Math.max(observed,Math.min(lookbackHours,24)*HOUR)/HOUR):null;
 const validReset=Number.isFinite(reset)&&reset>now;
 const hoursToReset=validReset?(reset-now)/HOUR:null;
 const projected=rate===null||hoursToReset===null?null:latest.remaining-rate*hoursToReset;
 let status='Learning pace';
 if(stale)status='Stale data';
 else if(latest.remaining<=0&&validReset)status='Exhausted';
 else if(!validReset)status='Reset unknown';
 else if(rate!==null)status=projected<0?'Runs out before reset':projected<10?'Close to limit':'On pace';
 return {...latest,rate,projected,hoursToReset,observedHours:observed/HOUR,stale,status,exhaustion:rate>0?now+latest.remaining/rate*HOUR:null};
}
function forecast(sample,rate,end,now=Date.now()) {
 if(rate===null||!Number.isFinite(rate)||rate<0)return [];
 let remaining=sample.remaining,reset=Date.parse(sample.reset),last=now;
 const points=[{at:now,remaining}];
 if(!Number.isFinite(reset)||reset<=now)return points;
 function drain(until){
  const exhausted=rate>0?last+remaining/rate*HOUR:Infinity;
  if(remaining>0&&exhausted<until)points.push({at:exhausted,remaining:0});
  remaining=Math.max(0,remaining-rate*(until-last)/HOUR);
  points.push({at:until,remaining});last=until;
 }
 while(reset<=end) {
  drain(reset);
  points.push({at:reset,remaining:100});remaining=100;
  if(!(sample.windowHours>0))return points;
  reset+=sample.windowHours*HOUR;
 }
 drain(end);
 return points;
}

// Price-weighted proxy tokens per 1% of a limit, from checks whose usage counters are comparable.
// Requires a few percent of observed drop so integer percentages do not dominate.
function capacity(samples) {
 const sorted=[...samples].filter(s=>s.epoch&&Number.isFinite(s.usage)).sort((a,b)=>Date.parse(a.at)-Date.parse(b.at));
 let units=0,drop=0;
 for(let i=1;i<sorted.length;i++) {
  const a=sorted[i-1],b=sorted[i];
  if(a.epoch!==b.epoch||b.usage<a.usage||!sameCycle({remaining:a.remaining,reset:Date.parse(a.reset)},{remaining:b.remaining,reset:Date.parse(b.reset)}))continue;
  units+=b.usage-a.usage;drop+=Math.max(0,a.remaining-b.remaining);
 }
 return drop>=5&&units>0?{units:units/drop,drop}:null;
}
// Rough relative plan sizes within a provider, used until a subscription's size is measured.
const PLAN_SIZE={claude:{free:.2,pro:1,team:1.25,enterprise:1.25,max:5,max_5x:5,max_20x:20},codex:{free:.2,plus:1,team:1,business:1,enterprise:1,pro:6}};
// Sizes for limits sharing work. Measured sizes anchor plan estimates to the same scale.
function sizes(entries) {
 const prior=e=>PLAN_SIZE[e.provider]?.[e.plan]??null,measured=entries.filter(e=>e.measured);
 const scale=measured.length?measured.reduce((s,e)=>s+e.measured.units/(prior(e)??1),0)/measured.length:1;
 return entries.map(e=>e.measured?{capacity:e.measured.units,source:'measured'}:{capacity:(prior(e)??1)*scale,source:prior(e)?'plan':'assumed'});
}
// Forecast limits that share work, such as one provider's subscriptions behind the proxy.
// Each keeps its current work until it runs out; that work then moves to limits with quota left,
// in proportion to their size. A limit takes its own work back after its reset refills it.
function poolForecast(subs,now,end) {
 const state=subs.map(s=>({remaining:s.remaining,reset:Date.parse(s.reset),window:s.windowHours>0?s.windowHours*HOUR:0,
  capacity:s.capacity>0?s.capacity:1,work:Math.max(0,s.rate??0)*(s.capacity>0?s.capacity:1),points:[{at:now,remaining:s.remaining}]}));
 for(let t=now,guard=0;t<end&&guard<10000;guard++) {
  const active=state.filter(s=>s.remaining>0),size=active.reduce((a,s)=>a+s.capacity,0);
  const orphan=state.filter(s=>s.remaining<=0).reduce((a,s)=>a+s.work,0);
  let next=end;
  for(const s of state) {
   s.rate=s.remaining>0?(s.work+(size?orphan*s.capacity/size:0))/s.capacity:0;
   if(s.reset>t)next=Math.min(next,s.reset);
   if(s.rate>0)next=Math.min(next,t+s.remaining/s.rate*HOUR);
  }
  for(const s of state) {
   const left=s.remaining-s.rate*(next-t)/HOUR;
   s.remaining=left<1e-9?0:left;s.points.push({at:next,remaining:s.remaining});
   if(s.reset<=next){s.remaining=100;s.points.push({at:next,remaining:100});s.reset=s.window?s.reset+s.window:Infinity;}
  }
  t=next;
 }
 return state.map(s=>s.points);
}
// Account-wide weekly limit, excluding model-specific weekly limits.
// Codex reports the weekly window as primary when a plan has no 5-hour window.
function accountWeekly(s) {
 if(!(s.windowHours>=144&&s.windowHours<=192))return false;
 if(s.provider==='claude')return s.limit==='seven_day';
 if(s.provider==='codex')return s.limit.startsWith('rate_limit/');
 return true;
}
// Account-wide 5-hour window, excluding model-specific windows.
function accountShort(s) {
 if(!(s.windowHours>0&&s.windowHours<24))return false;
 if(s.provider==='claude')return s.limit==='five_hour';
 if(s.provider==='codex')return s.limit.startsWith('rate_limit/');
 return true;
}
// Value of a piecewise-linear series at t. side<0 takes the value before a jump at t.
function valueAt(points,t,side=1) {
 if(!points.length)return 0;
 if(t<=points[0].at)return side<0||t<points[0].at?points[0].remaining:points.findLast(p=>p.at===t).remaining;
 if(t>=points.at(-1).at)return side<0&&t===points.at(-1).at?points.find(p=>p.at===t).remaining:points.at(-1).remaining;
 const i=points.findIndex(p=>p.at>=t);
 if(points[i].at===t)return side<0?points[i].remaining:points.findLast(p=>p.at===t).remaining;
 const a=points[i-1],b=points[i];
 return a.remaining+(b.remaining-a.remaining)*(t-a.at)/(b.at-a.at);
}
// Sum per-limit forecasts into one pooled line, keeping refills as vertical jumps.
// Every point lists its per-limit values in parts, in the order of the input lists.
function sumForecast(lists,start,end) {
 const times=[...new Set([start,end,...lists.flatMap(l=>l.map(p=>p.at))])].filter(t=>t>=start&&t<=end).sort((a,b)=>a-b);
 const points=[];
 for(const t of times) {
  const before=lists.map(l=>valueAt(l,t,-1)),after=lists.map(l=>valueAt(l,t,1));
  const left=before.reduce((s,v)=>s+v,0),right=after.reduce((s,v)=>s+v,0);
  points.push({at:t,remaining:left,parts:before});
  if(Math.abs(right-left)>1e-9)points.push({at:t,remaining:right,parts:after});
 }
 return points;
}
// Pooled remaining quota on a time grid. Values between checks are interpolated within a cycle;
// a point is a gap until every selected limit has known history.
function sumHistory(seriesList,start,end,step) {
 const all=seriesList.map(timeline),index=all.map(()=>0),points=[];
 for(let t=start;;t=Math.min(end,t+step)) {
  let total=0,known=all.length>0;
  const parts=all.map((s,k)=>{
   while(index[k]+1<s.length&&s[index[k]+1].at<=t)index[k]++;
   const a=s[index[k]];if(!a||a.at>t){known=false;return null;}
   const b=s[index[k]+1],v=b&&sameCycle(a,b)?a.remaining+(b.remaining-a.remaining)*(t-a.at)/(b.at-a.at):a.remaining;
   total+=v;return v;
  });
  points.push(known?{at:t,remaining:total,parts}:{at:t,remaining:null});
  if(t>=end)return points;
 }
}
// Pooled consumption in % points per hour, averaged over a trailing window. Resets are excluded.
function drain(seriesList,start,end,step,window=HOUR) {
 const lists=seriesList.map(intervals),lo=lists.map(()=>0),points=[];
 for(let t=start;;t=Math.min(end,t+step)) {
  let total=0,measured=false;
  const parts=lists.map((list,k)=>{
   while(lo[k]<list.length&&list[lo[k]].to<=t-window)lo[k]++;
   let consumed=0,observed=0;
   for(let i=lo[k];i<list.length&&list[i].from<t;i++) {
    const overlap=Math.min(t,list[i].to)-Math.max(t-window,list[i].from);
    if(overlap>0){consumed+=list[i].drop*overlap/(list[i].to-list[i].from);observed+=overlap;}
   }
   if(!(observed>=window/4))return null;
   const rate=consumed/(observed/HOUR);total+=rate;measured=true;return rate;
  });
  points.push(measured?{at:t,remaining:total,parts}:{at:t,remaining:null});
  if(t>=end)return points;
 }
}

const api={key,timeline,outlook,forecast,capacity,sizes,poolForecast,accountWeekly,accountShort,valueAt,sumForecast,sumHistory,drain};
if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.QuotaMath=api;
})(typeof globalThis!=='undefined'?globalThis:this);
