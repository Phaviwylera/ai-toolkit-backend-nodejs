'use strict';
(() => {
  const $=id=>document.getElementById(id);
  const state={
    market:null,clob:null,rtds:null,clobPing:null,rtdsPing:null,
    spot:null,spotTs:0,twap:null,twapTs:0,openRef:null,openRefTs:0,openTrusted:false,
    bbo:{up:{bid:null,ask:null,bidSize:0,askSize:0},down:{bid:null,ask:null,bidSize:0,askSize:0}},
    spotSec:new Map(),twapHist:[],fallbackSigma1s:0.00008,
    lastSignalKey:'',lastSignalAt:0,tape:[],alerts:false,discovering:false
  };
  window.POLY_EDGE_STATE=state;

  const fmt=(n,d=2)=>Number.isFinite(Number(n))?Number(n).toLocaleString('en-US',{minimumFractionDigits:d,maximumFractionDigits:d}):'—';
  const pct=(p)=>Number.isFinite(p)?(p*100).toFixed(1)+'%':'—';
  const bps=(v)=>Number.isFinite(v)?(v>=0?'+':'')+v.toFixed(2)+' bps':'—';
  const nowMs=()=>Date.now();

  function normalCdf(x){
    const t=1/(1+0.2316419*Math.abs(x));
    const d=0.3989423*Math.exp(-x*x/2);
    let p=1-d*t*(0.3193815+t*(-0.3565638+t*(1.781478+t*(-1.821256+t*1.330274))));
    return x>=0?p:1-p;
  }

  function takerFeePerShare(price){return 0.07*price*(1-price)}
  function set(id,val,cls=''){const e=$(id);if(!e)return;e.textContent=val;if(cls)e.className=cls}
  function freshness(ts){return ts?Math.max(0,nowMs()-ts):1e9}

  async function discover(){
    if(state.discovering)return;
    state.discovering=true;
    try{
      const r=await fetch('/api/poly/current',{cache:'no-store'}),j=await r.json();
      if(!r.ok)throw new Error(j.detail||('HTTP '+r.status));
      const changed=!state.market||state.market.slug!==j.slug;
      state.market=j;
      set('question',j.question||'BTC Up or Down · 5m');
      set('marketState',j.acceptingOrders?'ACCEPTING ORDERS':'READ ONLY',j.acceptingOrders?'good':'warn');
      set('volume','$'+fmt(j.volume,0));set('liquidity','$'+fmt(j.liquidity,0));
      set('minOrder',j.minOrderSize?fmt(j.minOrderSize,2)+' shares':'—');
      if($('marketLink'))$('marketLink').href='https://polymarket.com/event/'+encodeURIComponent(j.slug);
      updateBboFromRest(j);
      if(changed){
        const previous={slug:state.previousMarketSlug||null,finalTwap:state.twap,finalTwapTs:state.twapTs};
        window.dispatchEvent(new CustomEvent('poly-edge-market-change',{detail:{previous,current:j,finalTwap:state.twap,previousOpenRef:state.openRef}}));
        state.previousMarketSlug=j.slug;
        state.openRef=null;state.openRefTs=0;state.openTrusted=false;state.lastSignalKey='';
        connectClob();
      }
    }catch(e){
      set('marketState','DISCOVERY ERROR','bad');
      set('edgeWhy','Market discovery error: '+e.message);
    }finally{state.discovering=false}
  }

  function updateBboFromRest(j){
    for(const side of ['up','down']){
      const src=j[side]||{};
      state.bbo[side].bid=src.bid?.price??state.bbo[side].bid;
      state.bbo[side].ask=src.ask?.price??state.bbo[side].ask;
      state.bbo[side].bidSize=src.bid?.size??state.bbo[side].bidSize;
      state.bbo[side].askSize=src.ask?.size??state.bbo[side].askSize;
    }
    renderBbo();
  }

  function renderBbo(){
    const u=state.bbo.up,d=state.bbo.down;
    set('upBbo',(u.bid==null?'—':fmt(u.bid,3))+' / '+(u.ask==null?'—':fmt(u.ask,3)));
    set('downBbo',(d.bid==null?'—':fmt(d.bid,3))+' / '+(d.ask==null?'—':fmt(d.ask,3)));
    set('upAsk',u.ask==null?'—':pct(u.ask));set('downAsk',d.ask==null?'—':pct(d.ask));
  }

  function connectClob(){
    if(state.clob){try{state.clob.close()}catch{}}
    clearInterval(state.clobPing);
    if(!state.market)return;
    const ws=new WebSocket('wss://ws-subscriptions-clob.polymarket.com/ws/market');
    state.clob=ws;set('clobGate','CONNECTING','warn');
    ws.onopen=()=>{
      ws.send(JSON.stringify({type:'market',assets_ids:[state.market.upToken,state.market.downToken],initial_dump:true,custom_feature_enabled:true}));
      state.clobPing=setInterval(()=>{if(ws.readyState===1)ws.send('PING')},10000);
      set('clobGate','LIVE','good');
    };
    ws.onmessage=(ev)=>{
      if(ev.data==='PONG')return;
      let data;try{data=JSON.parse(ev.data)}catch{return}
      const msgs=Array.isArray(data)?data:[data];
      for(const m of msgs)handleClob(m);
    };
    ws.onclose=()=>{set('clobGate','RECONNECTING','warn');clearInterval(state.clobPing);setTimeout(()=>{if(state.market)connectClob()},1200)};
    ws.onerror=()=>set('clobGate','ERROR','bad');
  }

  function handleClob(m){
    if(!m||!state.market)return;
    const sideFor=id=>String(id)===String(state.market.upToken)?'up':String(id)===String(state.market.downToken)?'down':null;
    if(m.event_type==='book'){
      const side=sideFor(m.asset_id);if(!side)return;
      const bids=(m.bids||[]).map(x=>[Number(x.price),Number(x.size)]).filter(x=>Number.isFinite(x[0]));
      const asks=(m.asks||[]).map(x=>[Number(x.price),Number(x.size)]).filter(x=>Number.isFinite(x[0]));
      if(bids.length){const p=Math.max(...bids.map(x=>x[0]));state.bbo[side].bid=p;state.bbo[side].bidSize=bids.filter(x=>x[0]===p).reduce((a,x)=>a+x[1],0)}
      if(asks.length){const p=Math.min(...asks.map(x=>x[0]));state.bbo[side].ask=p;state.bbo[side].askSize=asks.filter(x=>x[0]===p).reduce((a,x)=>a+x[1],0)}
    }else if(m.event_type==='price_change'){
      for(const pc of (m.price_changes||m.changes||[])){
        const side=sideFor(pc.asset_id);if(!side)continue;
        if(pc.best_bid!==undefined)state.bbo[side].bid=Number(pc.best_bid);
        if(pc.best_ask!==undefined)state.bbo[side].ask=Number(pc.best_ask);
      }
    }else if(m.event_type==='best_bid_ask'){
      const side=sideFor(m.asset_id);if(side){state.bbo[side].bid=Number(m.best_bid);state.bbo[side].ask=Number(m.best_ask)}
    }
    renderBbo();evaluate();
  }

  function connectRtds(){
    if(state.rtds){try{state.rtds.close()}catch{}}
    clearInterval(state.rtdsPing);
    const ws=new WebSocket('wss://ws-live-data.polymarket.com');
    state.rtds=ws;set('rtdsGate','CONNECTING','warn');
    ws.onopen=()=>{
      ws.send(JSON.stringify({action:'subscribe',subscriptions:[
        {topic:'crypto_prices',type:'update',filters:'btcusdt'},
        {topic:'crypto_prices_twap_sixty',type:'update',filters:JSON.stringify({symbol:'btc/usd'})}
      ]}));
      state.rtdsPing=setInterval(()=>{if(ws.readyState===1)ws.send('PING')},5000);
      set('rtdsGate','LIVE','good');
    };
    ws.onmessage=(ev)=>{
      if(ev.data==='PONG')return;
      let data;try{data=JSON.parse(ev.data)}catch{return}
      const msgs=Array.isArray(data)?data:[data];
      for(const m of msgs)handleRtds(m);
    };
    ws.onclose=()=>{set('rtdsGate','RECONNECTING','warn');clearInterval(state.rtdsPing);setTimeout(connectRtds,1200)};
    ws.onerror=()=>set('rtdsGate','ERROR','bad');
  }

  function handleRtds(m){
    if(!m||m.message)return;
    const topic=String(m.topic||'');
    const p=m.payload||m.data||{};
    const value=Number(p.value??p.full_accuracy_value??m.value);
    const ts=Number(p.timestamp??m.timestamp??Date.now());
    const tms=ts<1e12?ts*1000:ts;
    if(!Number.isFinite(value)||value<=0)return;
    if(topic==='crypto_prices'){
      state.spot=value;state.spotTs=tms;
      const sec=Math.floor(tms/1000);state.spotSec.set(sec,value);
      const cutoff=Math.floor(Date.now()/1000)-240;
      for(const k of state.spotSec.keys())if(k<cutoff)state.spotSec.delete(k);
    }else if(topic==='crypto_prices_twap_sixty'){
      state.twap=value;state.twapTs=tms;
      state.twapHist.push({t:tms,p:value});state.twapHist=state.twapHist.filter(x=>x.t>Date.now()-240000);
      maybeCaptureOpen(value,tms);
    }
    evaluate();draw();
  }

  function maybeCaptureOpen(value,tms){
    if(!state.market||state.openRef)return;
    const start=state.market.startTs*1000;
    const delta=Math.abs(tms-start);
    if(delta<=8000){
      state.openRef=value;state.openRefTs=tms;state.openTrusted=true;
    }else if(tms>start+8000 && tms<start+22000){
      state.openRef=value;state.openRefTs=tms;state.openTrusted=false;
    }
  }

  function secSeries(){
    return [...state.spotSec.entries()].sort((a,b)=>a[0]-b[0]).map(([t,p])=>({t:t*1000,p}));
  }

  function sigma1s(){
    const xs=secSeries().slice(-100);
    if(xs.length<8)return state.fallbackSigma1s;
    const rs=[];for(let i=1;i<xs.length;i++)if(xs[i-1].p>0&&xs[i].p>0)rs.push(Math.log(xs[i].p/xs[i-1].p));
    if(rs.length<5)return state.fallbackSigma1s;
    const mean=rs.reduce((a,b)=>a+b,0)/rs.length;
    return Math.sqrt(rs.reduce((a,r)=>a+(r-mean)*(r-mean),0)/rs.length)||state.fallbackSigma1s;
  }

  function avgSpot(fromMs,toMs){
    const xs=secSeries().filter(x=>x.t>=fromMs&&x.t<=toMs);
    if(!xs.length)return null;return xs.reduce((a,x)=>a+x.p,0)/xs.length;
  }

  function momentumPerSecond(){
    const xs=secSeries().slice(-7);
    if(xs.length<4)return 0;
    const dt=Math.max(1,(xs[xs.length-1].t-xs[0].t)/1000);
    return Math.max(-0.0002,Math.min(0.0002,Math.log(xs[xs.length-1].p/xs[0].p)/dt));
  }

  function model(){
    if(!state.market||!state.spot||!state.twap||!state.openRef)return null;
    const now=Date.now(),end=state.market.endTs*1000,remaining=Math.max(0,(end-now)/1000);
    const finalStart=end-60000;
    const knownStart=Math.max(finalStart,now-60000);
    const known=avgSpot(finalStart,now);
    const knownSecs=Math.max(0,Math.min(60,(now-finalStart)/1000));
    const futureSecs=Math.max(0,Math.min(60,remaining));
    const drift=momentumPerSecond();
    const futureMean=state.spot*Math.exp(drift*futureSecs*0.20);
    let projectedSpotAvg;
    if(remaining<=60){
      projectedSpotAvg=((known??state.spot)*knownSecs+futureMean*futureSecs)/Math.max(1,knownSecs+futureSecs);
    }else{
      projectedSpotAvg=futureMean;
    }
    const currentSpot60=avgSpot(now-60000,now);
    const basis=(currentSpot60&&state.twap)?state.twap-currentSpot60:0;
    const projected=projectedSpotAvg+basis;
    const sig=sigma1s();
    const T=Math.max(1,Math.min(60,remaining));
    const futureAvgStd=Math.max(0.00001,sig*Math.pow(T,1.5)/(Math.sqrt(3)*60));
    const oracleFloor=0.00005;
    const totalStd=Math.sqrt(futureAvgStd*futureAvgStd+oracleFloor*oracleFloor);
    const margin=(projected-state.openRef)/state.openRef;
    const z=Math.max(-7,Math.min(7,margin/totalStd));
    const fairUp=Math.max(.01,Math.min(.99,normalCdf(z)));
    return {remaining,projected,sigma:sig,margin,z,fairUp,fairDown:1-fairUp,basis,drift};
  }

  function evaluate(){
    if(!state.market){set('feedStatus','DISCOVERING','warn');return}
    const m=model(),u=state.bbo.up,d=state.bbo.down;
    const left=Math.max(0,state.market.endTs-Math.floor(Date.now()/1000));
    set('timeLeft',String(Math.floor(left/60)).padStart(2,'0')+':'+String(left%60).padStart(2,'0'));
    if(state.spot)set('spotPrice','$'+fmt(state.spot,2));
    if(state.twap)set('twapPrice','$'+fmt(state.twap,2));
    set('openRef',state.openRef?'$'+fmt(state.openRef,2):'WAIT NEXT OPEN');
    set('captureState',state.openTrusted?'TRUSTED':state.openRef?'PROXY':'WAIT',state.openTrusted?'good':state.openRef?'warn':'bad');
    const lat=Math.max(freshness(state.spotTs),freshness(state.twapTs));
    set('latency',Math.round(lat)+' ms',lat<2500?'good':lat<6000?'warn':'bad');

    if(!m){
      set('feedStatus','SYNCING REFERENCES','warn');set('refState','WAITING','warn');
      set('decision','NO TRADE · capture the opening reference first','warn');return;
    }

    set('feedStatus','LIVE','good');set('refState',state.openTrusted?'RESOLUTION-ALIGNED':'UNTRUSTED OPEN',state.openTrusted?'good':'warn');
    set('projectedTwap','$'+fmt(m.projected,2));set('modelDistance',bps(m.margin*10000),m.margin>=0?'good':'bad');
    set('leadBps',bps((state.spot/state.twap-1)*10000));
    set('sigma',(m.sigma*10000).toFixed(3)+' bp/√s');

    const candidates=[];
    if(Number.isFinite(u.ask)){const fee=takerFeePerShare(u.ask),raw=m.fairUp-u.ask,net=raw-fee-0.005;candidates.push({side:'UP',ask:u.ask,fair:m.fairUp,fee,raw,net,size:u.askSize})}
    if(Number.isFinite(d.ask)){const fee=takerFeePerShare(d.ask),raw=m.fairDown-d.ask,net=raw-fee-0.005;candidates.push({side:'DOWN',ask:d.ask,fair:m.fairDown,fee,raw,net,size:d.askSize})}
    candidates.sort((a,b)=>b.net-a.net);
    const best=candidates[0];
    set('fairUp',pct(m.fairUp));set('fairDown',pct(m.fairDown));
    if(!best){set('decision','NO TRADE · order book unavailable','warn');return}

    const confidence=Math.max(0,Math.min(100,
      (state.openTrusted?35:5)+(lat<2500?20:5)+(m.remaining<=60?20:5)+Math.min(20,state.spotSec.size/4)+Math.min(5,Math.abs(m.z)*2)
    ));
    set('confidence',confidence.toFixed(0)+'%');
    set('feePerShare','$'+best.fee.toFixed(4));
    set('rawEdge',(best.raw>=0?'+':'')+(best.raw*100).toFixed(2)+'¢');
    set('netEdge',(best.net>=0?'+':'')+(best.net*100).toFixed(2)+'¢',best.net>0?'good':'bad');
    set('bestEdge',(best.net>=0?'+':'')+(best.net*100).toFixed(2)+'¢ / share',best.net>0?'good':'bad');
    set('bestSide',best.side+' @ '+(best.ask*100).toFixed(1)+'¢');
    if($('edgeBar'))$('edgeBar').style.width=Math.max(0,Math.min(100,best.net*1200))+'%';

    const minShares=Number(state.market.minOrderSize)||0;
    const minCost=minShares?minShares*best.ask:0;
    const fresh=lat<2500;
    const liquid=best.size<=0||best.size>=Math.max(1,minShares);
    const priceOk=best.ask>=0.03&&best.ask<=0.97;
    const timeOk=m.remaining<=55&&m.remaining>=5;
    const opportunity=state.openTrusted&&fresh&&liquid&&priceOk&&timeOk&&confidence>=70&&best.fair>=0.72&&best.net>=0.02;
    state.latestModel=m;state.latestBest=best;state.latestConfidence=confidence;state.latestOpportunity=opportunity;

    set('modelState',opportunity?'MARKET MISTAKE':'NO QUALIFYING GAP',opportunity?'good':'warn');
    if(opportunity){
      set('edgeState','OPPORTUNITY','good');
      set('decision','OPPORTUNITY · '+best.side+' appears underpriced by '+(best.net*100).toFixed(2)+'¢/share after fee + safety margin','good');
      set('edgeWhy','Fast BTC/TWAP model implies '+pct(best.fair)+' vs executable ask '+pct(best.ask)+'. Minimum order costs about $'+minCost.toFixed(2)+'.');
      signal(best,m,confidence);
    }else{
      set('edgeState','NO TRADE','warn');
      let why=!state.openTrusted?'opening reference not trusted':!fresh?'reference feed stale':!timeOk?'outside final 55-second execution window':best.fair<.72?'model probability not decisive':best.net<.02?'fee-adjusted edge too small':!liquid?'insufficient best-ask liquidity':'risk gate';
      set('decision','NO TRADE · '+why,'warn');
      set('edgeWhy','Best side '+best.side+' has '+(best.net*100).toFixed(2)+'¢/share net model edge after taker fee and 0.5¢ safety margin.');
    }
  }

  function signal(best,m,confidence){
    const key=(state.market?.slug||'')+'|'+best.side;
    if(key===state.lastSignalKey&&Date.now()-state.lastSignalAt<5000)return;
    state.lastSignalKey=key;state.lastSignalAt=Date.now();
    state.tape.unshift({t:new Date(),side:best.side,ask:best.ask,fair:best.fair,net:best.net,state:'OPPORTUNITY'});
    state.tape=state.tape.slice(0,30);renderTape();
    window.dispatchEvent(new CustomEvent('poly-edge-opportunity',{detail:{best,m,confidence,market:state.market,openRef:state.openRef,openTrusted:state.openTrusted}}));
    if(state.alerts&&'Notification'in window&&Notification.permission==='granted'){
      try{new Notification('POLY/EDGE · '+best.side,{body:'Net model edge '+(best.net*100).toFixed(2)+'¢/share · fair '+pct(best.fair)+' · '+Math.round(m.remaining)+'s left',tag:'poly-edge-'+key})}catch{}
    }
  }

  function renderTape(){
    const body=$('tapeBody');if(!body)return;body.replaceChildren();
    if(!state.tape.length){const e=document.createElement('div');e.className='empty';e.textContent='No trade-quality signal yet.';body.append(e);return}
    for(const x of state.tape){
      const r=document.createElement('div');r.className='tapeRow';
      const vals=[x.t.toLocaleTimeString(),x.side,(x.ask*100).toFixed(1)+'¢',pct(x.fair),(x.net*100).toFixed(2)+'¢',x.state];
      vals.forEach((v,i)=>{const e=document.createElement(i===5?'b':'span');e.textContent=v;if(i===4||i===5)e.className='good';r.append(e)});body.append(r);
    }
  }

  function draw(){
    const c=$('chart');if(!c)return;const r=c.getBoundingClientRect(),dpr=Math.max(1,Math.min(2,devicePixelRatio||1));
    c.width=Math.max(320,Math.floor(r.width*dpr));c.height=Math.floor(250*dpr);const x=c.getContext('2d');x.setTransform(dpr,0,0,dpr,0,0);
    const w=r.width,h=250;x.clearRect(0,0,w,h);x.strokeStyle='#21172c';x.lineWidth=1;for(let i=1;i<5;i++){x.beginPath();x.moveTo(0,i*h/5);x.lineTo(w,i*h/5);x.stroke()}
    const spot=secSeries().filter(a=>a.t>Date.now()-120000),tw=state.twapHist.filter(a=>a.t>Date.now()-120000);
    const all=[...spot,...tw];if(state.openRef)all.push({p:state.openRef});if(all.length<2)return;
    const lo=Math.min(...all.map(a=>a.p)),hi=Math.max(...all.map(a=>a.p)),pad=Math.max(1,(hi-lo)*.15),min=lo-pad,max=hi+pad;
    const t0=Date.now()-120000,t1=Date.now(),px=t=>Math.max(0,Math.min(w,(t-t0)/(t1-t0)*w)),py=p=>h-((p-min)/(max-min))*h;
    function line(data,color){if(data.length<2)return;x.strokeStyle=color;x.lineWidth=1.4;x.beginPath();data.forEach((a,i)=>{i?x.lineTo(px(a.t),py(a.p)):x.moveTo(px(a.t),py(a.p))});x.stroke()}
    line(spot,'#78dfff');line(tw,'#ff4fd8');
    if(state.openRef){x.strokeStyle='#ffc857';x.setLineDash([5,5]);x.beginPath();x.moveTo(0,py(state.openRef));x.lineTo(w,py(state.openRef));x.stroke();x.setLineDash([])}
  }

  async function seedHistory(){
    try{
      const r=await fetch('/api/poly/btc-history',{cache:'no-store'}),j=await r.json();
      if(r.ok&&Number(j.oneMinuteRmsPct)>0)state.fallbackSigma1s=(Number(j.oneMinuteRmsPct)/100)/Math.sqrt(60);
    }catch{}
  }

  async function enableAlerts(){
    if(!('Notification'in window)){set('alertsBtn','ALERTS UNSUPPORTED');return}
    const p=await Notification.requestPermission();state.alerts=p==='granted';set('alertsBtn',state.alerts?'✓ OPPORTUNITY ALERTS ENABLED':'ALERTS '+p.toUpperCase());
  }

  function tick(){
    set('clock',new Date().toISOString().slice(11,19)+' UTC');
    if(state.market&&Date.now()>state.market.endTs*1000+1500)discover();
    evaluate();draw();
  }

  function boot(){
    $('alertsBtn').onclick=enableAlerts;
    seedHistory();discover();connectRtds();
    setInterval(discover,8000);setInterval(tick,250);
    window.addEventListener('resize',draw);
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot,{once:true});else boot();
})();