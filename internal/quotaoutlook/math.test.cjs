const test=require('node:test');
const assert=require('node:assert/strict');
const Q=require('./math.js');
const now=Date.parse('2026-10-26T12:00:00Z'),H=3600000;
const close=(a,b)=>assert.ok(Math.abs(a-b)<1e-9,a+' != '+b);
// windowHours 0 disables the assumed full quota at cycle start, isolating observed intervals.
const sample=(hours,remaining,reset=now+24*H,windowHours=0)=>({account:'a',provider:'claude',limit:'seven_day',remaining,reset:new Date(reset).toISOString(),windowHours,at:new Date(now+hours*H).toISOString()});
test('calculates sustained burn and exhaustion before reset',()=>{
 const r=Q.outlook([sample(-1,70),sample(-.75,55),sample(-.5,40),sample(-.25,25),sample(0,10)],now,1);
 close(r.rate,60);assert.equal(r.status,'Runs out before reset');assert.equal(r.exhaustion,now+H/6);
});
test('flat observed quota is a measured zero, not unknown',()=>{
 const r=Q.outlook([sample(-1,75),sample(0,75)],now,1);
 assert.equal(r.rate,0);assert.equal(r.status,'On pace');assert.equal(r.projected,75);
});
test('one sample, stale samples and unknown resets never report safe',()=>{
 assert.equal(Q.outlook([sample(0,80)],now).rate,null);
 assert.equal(Q.outlook([sample(-4,80)],now).status,'Stale data');
 const a=sample(-1,80),b=sample(0,80);a.reset=b.reset=null;
 assert.equal(Q.outlook([a,b],now).status,'Reset unknown');
});
test('assumes a full quota at the start of the current cycle',()=>{
 const points=Q.timeline([sample(0,80,now+24*H,168)]);
 assert.deepEqual(points.map(p=>[p.at,p.remaining]),[[now-144*H,100],[now,80]]);
 close(Q.outlook([sample(0,80,now+24*H,168)],now).rate,20/144);
});
test('averages pace across cycles and excludes refills',()=>{
 // Previous cycle reset two hours ago; the current one started then at 100%.
 const samples=[sample(-6,60,now-2*H,24),sample(-3,45,now-2*H,24),sample(0,90,now+22*H,24)];
 const points=Q.timeline(samples);
 assert.deepEqual(points.map(p=>p.remaining),[100,60,45,100,90]);
 // 25% over five observed hours, averaged over the six-hour lookback.
 close(Q.outlook(samples,now,6).rate,25/6);
});
test('clips observation intervals to the selected lookback',()=>{
 close(Q.outlook([sample(-2,100),sample(-1,90),sample(0,70)],now,1).rate,20);
});
test('forecasts full refills without negative remaining quota',()=>{
 const r=sample(0,10,now+H,24);
 const points=Q.forecast(r,20,now+26*H,now);
 assert.deepEqual(points.slice(1,4),[{at:now+H/2,remaining:0},{at:now+H,remaining:0},{at:now+H,remaining:100}]);
 assert.ok(points.every(p=>p.remaining>=0&&p.remaining<=100));
 assert.equal(points.filter(p=>p.remaining===100).length,2);
});
test('keeps account/model identities separate',()=>{
 assert.notEqual(Q.key(sample(0,50)),Q.key({...sample(0,50),account:'b'}));
 assert.notEqual(Q.key(sample(0,50)),Q.key({...sample(0,50),limit:'seven_day_opus'}));
});
test('reset timestamp formatting and sub-minute rounding do not erase measured pace',()=>{
 const a=sample(-1,80),b=sample(0,79);
 a.reset=a.reset.replace('.000Z','Z');
 b.reset=new Date(Date.parse(b.reset)+500).toISOString();
 close(Q.outlook([a,b],now,1).rate,1);
});
test('pooled forecast sums limits and keeps refills as jumps',()=>{
 const a=[{at:now,remaining:50},{at:now+H,remaining:40},{at:now+H,remaining:100},{at:now+2*H,remaining:90}];
 const b=[{at:now,remaining:20},{at:now+2*H,remaining:0}];
 assert.equal(Q.valueAt(a,now+H,-1),40);assert.equal(Q.valueAt(a,now+H,1),100);assert.equal(Q.valueAt(a,now+H/2),45);
 const pooled=Q.sumForecast([a,b],now,now+2*H);
 assert.deepEqual(pooled.map(({at,remaining})=>({at,remaining})),[{at:now,remaining:70},{at:now+H,remaining:50},{at:now+H,remaining:110},{at:now+2*H,remaining:90}]);
 // Each point keeps the per-limit split behind its total.
 assert.deepEqual(pooled.map(p=>p.parts),[[50,20],[40,10],[100,10],[90,0]]);
});
test('pooled history interpolates hourly checks and waits until every limit is known',()=>{
 const a=[sample(-3,90),sample(-1,80),sample(0,70)],b=[sample(-2,50),sample(0,40)];
 const pooled=Q.sumHistory([a,b],now-3*H,now,H);
 assert.deepEqual(pooled.map(p=>p.remaining),[null,135,125,110]);
 assert.deepEqual(pooled.map(p=>p.parts),[undefined,[85,50],[80,45],[70,40]]);
});
test('pooled history starts each limit full at its cycle start',()=>{
 const points=Q.sumHistory([[sample(0,80,now+24*H,168)]],now-168*H,now,24*H);
 assert.equal(points[0].remaining,null);assert.equal(points[1].remaining,100);
 close(points.find(p=>p.at===now-72*H).remaining,90);assert.equal(points.at(-1).remaining,80);
});
test('pooled drain averages each limit over the trailing window and skips resets',()=>{
 const a=[],b=[];
 for(let m=0;m<=60;m+=5){a.push(sample(-1+m/60,80-m/6));b.push(sample(-1+m/60,60-m/12));}
 const [point]=Q.drain([a,b],now,now,H/12);
 close(point.remaining,15);close(point.parts[0],10);close(point.parts[1],5);
 assert.equal(Q.drain([[sample(-1/12,5,now-H),sample(0,100)]],now,now,H/12)[0].remaining,null);
});
test('account weekly limit accepts Codex weekly windows reported as primary',()=>{
 const limit=(provider,name,windowHours)=>({provider,limit:name,windowHours});
 assert.ok(Q.accountWeekly(limit('codex','rate_limit/secondary_window',168)));
 assert.ok(Q.accountWeekly(limit('codex','rate_limit/primary_window',168)));
 assert.ok(!Q.accountWeekly(limit('codex','rate_limit/primary_window',5)));
 assert.ok(!Q.accountWeekly(limit('codex','code_review_rate_limit/primary_window',168)));
 assert.ok(Q.accountWeekly(limit('claude','seven_day',168)));
 assert.ok(!Q.accountWeekly(limit('claude','seven_day_opus',168)));
});
test('measures subscription size from proxy usage per percent dropped',()=>{
 const at=(h,remaining,usage,epoch='e')=>({...sample(h,remaining),usage,epoch});
 close(Q.capacity([at(-3,90,0),at(-2,85,500),at(-1,80,1000),at(0,78,1200)]).units,100);
 // Server restarts reset counters, so intervals across epochs are skipped.
 assert.equal(Q.capacity([at(-1,90,5000,'a'),at(0,80,10,'b')]),null);
 assert.equal(Q.capacity([at(-1,90,0),at(0,88,400)]),null);
});
test('plan sizes are scaled to measured subscriptions',()=>{
 const got=Q.sizes([{provider:'codex',plan:'plus',measured:{units:200}},{provider:'codex',plan:'pro'},{provider:'codex',plan:'mystery'}]);
 assert.deepEqual(got,[{capacity:200,source:'measured'},{capacity:1200,source:'plan'},{capacity:200,source:'assumed'}]);
});
test('pooled forecast moves work to remaining subscriptions by size and back after reset',()=>{
 const plus={remaining:10,rate:5,capacity:1,reset:new Date(now+4*H).toISOString(),windowHours:168};
 const pro={remaining:100,rate:0,capacity:5,reset:new Date(now+100*H).toISOString(),windowHours:168};
 const [a,b]=Q.poolForecast([plus,pro],now,now+12*H);
 assert.equal(Q.valueAt(a,now+2*H),0);
 close(Q.valueAt(b,now+2*H),100);close(Q.valueAt(b,now+4*H),98);
 assert.equal(Q.valueAt(a,now+4*H,1),100);
 close(Q.valueAt(b,now+12*H),98);close(Q.valueAt(a,now+12*H),60);
});
test('a busy first day is averaged over the whole day, not projected around the clock',()=>{
 // 22% used in the five hours since the weekly reset, as seen on a real Codex Plus account.
 const samples=[sample(-4,82,now+163*H,168),sample(0,78,now+163*H,168)];
 close(Q.outlook(samples,now,168).rate,22/24);
 // With more than a day of history the true average, including idle hours, is used.
 close(Q.outlook([sample(0,50,now+120*H,168)],now,168).rate,50/48);
});
test('account 5-hour window excludes weekly and model-specific limits',()=>{
 const limit=(provider,name,windowHours)=>({provider,limit:name,windowHours});
 assert.ok(Q.accountShort(limit('codex','rate_limit/primary_window',5)));
 assert.ok(!Q.accountShort(limit('codex','rate_limit/primary_window',168)));
 assert.ok(!Q.accountShort(limit('codex','model/special/primary_window',5)));
 assert.ok(Q.accountShort(limit('claude','five_hour',5)));
 assert.ok(!Q.accountShort(limit('claude','seven_day',168)));
});
test('monthly limits count only for subscriptions without a weekly one',()=>{
 const limit=(account,provider,name,windowHours)=>({account,provider,limit:name,windowHours});
 const kimi=[limit('k','kimi','limit/5h',5),limit('k','kimi','monthly',720)];
 const both=[limit('m','kimi','weekly',168),limit('m','kimi','monthly',720)];
 const claude=[limit('c','claude','seven_day',168),limit('c','claude','five_hour',5)];
 assert.deepEqual(Q.accountLong([...kimi,...both,...claude]).map(s=>s.account+' '+s.limit),['k monthly','m weekly','c seven_day']);
});
