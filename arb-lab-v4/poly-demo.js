'use strict';
(() => {
  const $=id=>document.getElementById(id);
  const LIVE=()=>window.POLY_EDGE_STATE||null;
  const KEY='poly_edge_demo_v2';
  const START_BALANCE=2.0;
  const DURATION=10800;
  const LATENCY_MS=350;
  let demo=null;
  let pending=false;
  let lastSnapshot=0;

  const fmt=(n,d=4)=>Number(n).toFixed(d);
  const feeUsd=(shares,price)=>shares*0.07*price*(1-price);
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));

  function save(){try{if(demo)localStorage.setItem(KEY,JSON.stringify(demo))}catch{}}
  function load(){try{const d=JSON.parse(localStorage.getItem(KEY)||'null');if(d&&d.version===2)demo=d}catch{}}
  function sideBook(side){const s=LIVE();return side==='UP'?s?.bbo?.up:s?.bbo?.down}
  function sideFair(side){const m=LIVE()?.latestModel;return side==='UP'?m?.fairUp:m?.fairDown}

  async function post(type,payload={}){
    if(!demo||!demo.sessionId||demo.sessionId.startsWith('local_'))return;
    try{
      const r=await fetch('/api/poly/demo/event',{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({sessionId:demo.sessionId,eventType:type,payload})
      });
      if(r.status===404){demo.sessionId='';save();await ensureSession()}
    }catch{}
  }

  function equity(){
    if(!demo)return START_BALANCE;
    let e=demo.cash;
    if(demo.position){
      const b=sideBook(demo.position.side);
      const bid=Number(b?.bid);
      e+=Number.isFinite(bid)?demo.position.shares*bid:demo.position.entryCost;
    }
    return e;
  }

  function summary(){
    const e=equity();
    return {
      sessionId:demo?.sessionId||'',status:demo?.status||'',
      startingBalance:demo?.startingBalance||START_BALANCE,cash:demo?.cash||0,equity:e,
      realizedPnl:demo?.realizedPnl||0,roiPct:demo?((e/demo.startingBalance)-1)*100:0,
      fees:demo?.fees||0,trades:demo?.trades||0,wins:demo?.wins||0,losses:demo?.losses||0,
      winRatePct:demo?.trades?demo.wins/demo.trades*100:0,
      blocked:demo?.blocked||0,nofills:demo?.nofills||0,
      maxDrawdownPct:(demo?.maxDrawdown||0)*100,
      position:demo?.position||null,market:LIVE()?.market?.slug||null,updatedAt:Date.now()/1000
    };
  }

  async function ensureSession(){
    load();
    if(demo&&demo.sessionId)return;
    const base=demo||{
      version:2,sessionId:'',startingBalance:START_BALANCE,cash:START_BALANCE,
      realizedPnl:0,fees:0,trades:0,wins:0,losses:0,blocked:0,nofills:0,
      peakEquity:START_BALANCE,maxDrawdown:0,position:null,events:[],
      startedAt:Date.now()/1000,endsAt:Date.now()/1000+DURATION,status:'starting'
    };
    try{
      const r=await fetch('/api/poly/demo/start',{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({startingBalance:START_BALANCE,durationSeconds:DURATION})
      });
      const j=await r.json();
      if(!r.ok)throw new Error(j.detail||'start failed');
      base.sessionId=j.sessionId;base.startedAt=j.startedAt;base.endsAt=j.endsAt;base.status='running';
    }catch{
      base.sessionId='local_'+Date.now().toString(36);base.status='local-only';
    }
    demo=base;save();render();await post('START',summary());
  }

  function record(action,side='',price=null,pnl=null,detail=''){
    if(!demo)return;
    demo.events.unshift({t:Date.now(),action,side,price,pnl,detail});
    demo.events=demo.events.slice(0,100);
    save();renderTape();post(action,{side,price,pnl,detail,summary:summary(),market:LIVE()?.market?.slug||null});
  }

  function renderTape(){
    const body=$('demoTape');if(!body)return;
    body.replaceChildren();
    if(!demo||!demo.events.length){
      const e=document.createElement('div');e.className='empty';e.textContent='Waiting for a trade-quality live signal.';body.append(e);return;
    }
    for(const x of demo.events.slice(0,30)){
      const row=document.createElement('div');row.className='demoRow';
      const vals=[
        new Date(x.t).toLocaleTimeString(),x.action,x.side||'—',
        Number.isFinite(x.price)?(x.price*100).toFixed(1)+'¢':'—',
        Number.isFinite(x.pnl)?(x.pnl>=0?'+$':'-$')+Math.abs(x.pnl).toFixed(4):'—',
        x.detail||''
      ];
      vals.forEach((v,i)=>{
        const e=document.createElement(i===1||i===4?'b':'span');e.textContent=v;
        if(i===1)e.className=x.action==='BUY'?'buy':x.action==='SELL'?'sell':'';
        if(i===4&&Number.isFinite(x.pnl))e.className=x.pnl>=0?'win':'loss';
        row.append(e);
      });
      body.append(row);
    }
  }

  function render(){
    if(!demo)return;
    const e=equity();
    demo.peakEquity=Math.max(demo.peakEquity||demo.startingBalance,e);
    const dd=demo.peakEquity>0?(demo.peakEquity-e)/demo.peakEquity:0;
    demo.maxDrawdown=Math.max(demo.maxDrawdown||0,dd);
    const set=(id,val,cls='')=>{const el=$(id);if(!el)return;el.textContent=val;if(cls)el.className=cls};
    set('demoEquity','$'+fmt(e),e>=demo.startingBalance?'good':'bad');
    set('demoPnl',(demo.realizedPnl>=0?'+$':'-$')+Math.abs(demo.realizedPnl).toFixed(4),demo.realizedPnl>=0?'good':'bad');
    set('demoTrades',String(demo.trades));
    set('demoWinRate',demo.trades?(demo.wins/demo.trades*100).toFixed(1)+'%':'—');
    set('demoFees','$'+Number(demo.fees||0).toFixed(4));
    set('demoDrawdown',(demo.maxDrawdown*100).toFixed(2)+'%');
    set('demoBlocked',String(demo.blocked||0));
    set('demoNoFill',String(demo.nofills||0));
    const left=Math.max(0,Math.floor((demo.endsAt||0)-Date.now()/1000));
    const hh=String(Math.floor(left/3600)).padStart(2,'0');
    const mm=String(Math.floor((left%3600)/60)).padStart(2,'0');
    const ss=String(left%60).padStart(2,'0');
    set('demoLeft',hh+':'+mm+':'+ss);
    const status=demo.status==='complete'?'COMPLETE':demo.status==='closing'?'CLOSING POSITION':demo.status==='local-only'?'LOCAL PAPER':'LIVE PAPER';
    set('demoStatus',status,demo.status==='complete'?'warn':'good');
    if(demo.position){
      const b=sideBook(demo.position.side),bid=Number(b?.bid);
      set('demoPosition',demo.position.side+' · '+demo.position.shares.toFixed(4)+' net shares · entry '+(demo.position.entryPrice*100).toFixed(1)+'¢ · bid '+(Number.isFinite(bid)?(bid*100).toFixed(1)+'¢':'—'),'warn');
    }else set('demoPosition','NO OPEN PAPER POSITION');
    save();renderTape();
  }

  async function enter(detail){
    if(!demo||demo.status==='complete'||demo.status==='closing'||demo.position||pending)return;
    if(Date.now()/1000>=demo.endsAt){completeIfFlat();return}
    const live=LIVE(),market=detail.market||live?.market,best=detail.best;
    if(!market||!best)return;
    const book=sideBook(best.side);
    const ask0=Number(book?.ask),size0=Number(book?.askSize)||0;
    if(!Number.isFinite(ask0)||ask0<=0)return;
    const minShares=Math.max(5,Number(market.minOrderSize)||0);
    const affordable=Math.floor((demo.cash/ask0)*100)/100;
    const available=size0>0?Math.min(affordable,size0):affordable;
    const shares=Math.floor(available*100)/100;
    if(shares<minShares||shares*ask0<1){
      demo.blocked++;
      record('BLOCK',best.side,ask0,null,'Real minimum not met: need ≥'+minShares+' shares and ≥$1 notional; demo cash $'+demo.cash.toFixed(2)+'.');
      render();return;
    }
    pending=true;
    const tick=Math.max(.001,Number(market.minTickSize)||.01);
    const maxPrice=Math.min(.99,ask0+tick);
    const sent=Date.now();
    record('ORDER',best.side,ask0,null,'FAK buy simulation · '+shares.toFixed(2)+' shares · max '+(maxPrice*100).toFixed(1)+'¢');
    await sleep(LATENCY_MS);
    try{
      const b=sideBook(best.side),ask=Number(b?.ask),avail=Number(b?.askSize)||0;
      if(!Number.isFinite(ask)||ask>maxPrice||avail<shares){
        demo.nofills++;record('NOFILL',best.side,Number.isFinite(ask)?ask:null,null,'Live ask/size changed during '+(Date.now()-sent)+'ms latency.');return;
      }
      const cost=shares*ask;
      if(cost>demo.cash+1e-9){demo.nofills++;record('NOFILL',best.side,ask,null,'Fill would exceed demo cash.');return}
      const fee=feeUsd(shares,ask);
      const feeShares=fee/ask;
      const netShares=shares-feeShares;
      demo.cash-=cost;demo.fees+=fee;
      demo.position={
        marketSlug:market.slug,side:best.side,entryPrice:ask,grossShares:shares,shares:netShares,
        entryCost:cost,entryFeeUsd:fee,entryAt:Date.now(),openRef:detail.openRef,
        modelFair:best.fair,confidence:detail.confidence
      };
      record('BUY',best.side,ask,null,'Filled live ask after '+(Date.now()-sent)+'ms · gross '+shares.toFixed(2)+' · buy fee eq $'+fee.toFixed(4)+' · net '+netShares.toFixed(4)+' shares.');
    }finally{pending=false;render()}
  }

  async function trySell(reason){
    if(!demo?.position||pending)return false;
    const live=LIVE(),market=live?.market,pos=demo.position;
    if(!market||pos.marketSlug!==market.slug)return false;
    const minShares=Math.max(5,Number(market.minOrderSize)||0);
    if(pos.shares<minShares)return false;
    const b=sideBook(pos.side),bid0=Number(b?.bid),size0=Number(b?.bidSize)||0;
    if(!Number.isFinite(bid0)||bid0<=0||size0<pos.shares)return false;
    pending=true;
    const tick=Math.max(.001,Number(market.minTickSize)||.01),minPrice=Math.max(.01,bid0-tick),sent=Date.now();
    record('ORDER',pos.side,bid0,null,'FAK sell simulation · min '+(minPrice*100).toFixed(1)+'¢ · '+reason);
    await sleep(LATENCY_MS);
    try{
      const liveBook=sideBook(pos.side),bid=Number(liveBook?.bid),avail=Number(liveBook?.bidSize)||0;
      if(!Number.isFinite(bid)||bid<minPrice||avail<pos.shares){
        demo.nofills++;record('NOFILL',pos.side,Number.isFinite(bid)?bid:null,null,'Exit book changed during '+(Date.now()-sent)+'ms latency.');return false;
      }
      const gross=pos.shares*bid,fee=feeUsd(pos.shares,bid),proceeds=gross-fee,pnl=proceeds-pos.entryCost;
      demo.cash+=proceeds;demo.fees+=fee;demo.realizedPnl+=pnl;demo.trades++;
      if(pnl>=0)demo.wins++;else demo.losses++;
      record('SELL',pos.side,bid,pnl,reason+' · sell fee $'+fee.toFixed(4));
      demo.position=null;completeIfFlat();render();return true;
    }finally{pending=false}
  }

  function settle(previousSlug,finalTwap){
    if(!demo?.position||demo.position.marketSlug!==previousSlug)return;
    const pos=demo.position;
    if(!Number.isFinite(finalTwap)||!Number.isFinite(pos.openRef))return;
    const winner=finalTwap>=pos.openRef?'UP':'DOWN';
    const payout=pos.side===winner?pos.shares:0;
    const pnl=payout-pos.entryCost;
    demo.cash+=payout;demo.realizedPnl+=pnl;demo.trades++;
    if(pnl>=0)demo.wins++;else demo.losses++;
    record('SETTLE',pos.side,pos.side===winner?1:0,pnl,'Chainlink-TWAP paper resolution · winner '+winner+' · final $'+Number(finalTwap).toFixed(2));
    demo.position=null;completeIfFlat();render();
  }

  function completeIfFlat(){
    if(!demo)return;
    if(Date.now()/1000>=demo.endsAt){
      demo.status=demo.position?'closing':'complete';
      if(demo.status==='complete')post('COMPLETE',summary());
    }
  }

  function manage(){
    if(!demo)return;
    completeIfFlat();
    const pos=demo.position,m=LIVE()?.latestModel;
    if(pos&&m&&LIVE()?.market?.slug===pos.marketSlug&&!pending){
      const b=sideBook(pos.side),bid=Number(b?.bid);
      if(Number.isFinite(bid)){
        const sellFee=feeUsd(pos.shares,bid);
        const net=pos.shares*bid-sellFee;
        const pnl=net-pos.entryCost;
        const fair=sideFair(pos.side);
        if(pnl>=Math.max(.02,pos.entryCost*.015))trySell('take-profit on live bid');
        else if(Number.isFinite(fair)&&fair-bid<=.01&&pnl>0)trySell('pricing gap converged');
        else if(Number.isFinite(fair)&&fair<pos.entryPrice-.03)trySell('model invalidated');
        else if(m.remaining<=4)trySell('market near close');
      }
    }
    const e=equity();demo.peakEquity=Math.max(demo.peakEquity||demo.startingBalance,e);
    demo.maxDrawdown=Math.max(demo.maxDrawdown||0,demo.peakEquity?(demo.peakEquity-e)/demo.peakEquity:0);
    if(Date.now()-lastSnapshot>10000){lastSnapshot=Date.now();post('SNAPSHOT',summary())}
    render();
  }

  window.addEventListener('poly-edge-opportunity',e=>enter(e.detail||{}));
  window.addEventListener('poly-edge-market-change',e=>{
    const d=e.detail||{},slug=d.previous?.slug;
    if(slug&&demo?.position?.marketSlug===slug)settle(slug,Number(d.finalTwap));
  });

  async function boot(){
    await ensureSession();
    render();
    setInterval(manage,250);
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot,{once:true});else boot();
})();