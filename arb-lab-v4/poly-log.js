'use strict';
(() => {
  const OPENED_AT=Date.now();
  const SESSION_ID='pe_'+OPENED_AT.toString(36)+'_'+Math.random().toString(36).slice(2,8);
  const MAX_EVENTS=20000;
  const events=[];
  let seq=0,lastServerDecision='',lastMarket='',lastFeed='',lastPaperEventCount=-1,lastSnapshot=null;

  function cleanError(e){
    if(!e)return null;
    return {name:String(e.name||'Error'),message:String(e.message||e).slice(0,500),stack:String(e.stack||'').slice(0,2000)};
  }
  function add(type,data={}){
    events.push({seq:++seq,t:Date.now(),iso:new Date().toISOString(),type,data});
    if(events.length>MAX_EVENTS)events.splice(0,events.length-MAX_EVENTS);
  }
  function n(v){const x=Number(v);return Number.isFinite(x)?x:null}
  function reduceServer(j){
    const m=j?.market||{},b=j?.bbo||{},model=j?.model||{},c=j?.candidate||{},p=j?.paper||{};
    return {
      serverTime:n(j?.serverTime),feed:j?.feed||{},
      market:{slug:m.slug||null,startTs:n(m.startTs),endTs:n(m.endTs),acceptingOrders:!!m.acceptingOrders,minOrderSize:n(m.minOrderSize),minTickSize:n(m.minTickSize),volume:n(m.volume),liquidity:n(m.liquidity)},
      bbo:{
        up:{bid:n(b?.up?.bid),ask:n(b?.up?.ask),bidSize:n(b?.up?.bidSize),askSize:n(b?.up?.askSize)},
        down:{bid:n(b?.down?.bid),ask:n(b?.down?.ask),bidSize:n(b?.down?.bidSize),askSize:n(b?.down?.askSize)}
      },
      ref:{spot:n(j?.spot),spotAgeSec:n(j?.spotAgeSec),twap:n(j?.twap),twapAgeSec:n(j?.twapAgeSec),openRef:n(j?.openRef),openTrusted:!!j?.openTrusted},
      model:model?{remaining:n(model.remaining),projected:n(model.projected),sigma:n(model.sigma),margin:n(model.margin),z:n(model.z),fairUp:n(model.fairUp),fairDown:n(model.fairDown),basis:n(model.basis),drift:n(model.drift)}:null,
      candidate:c&&Object.keys(c).length?{side:c.side||null,ask:n(c.ask),fair:n(c.fair),fee:n(c.fee),raw:n(c.raw),net:n(c.net),size:n(c.size)}:null,
      decision:j?.decision||null,
      reasonCounts:j?.reasonCounts||{},
      paper:{
        sessionId:p.sessionId||null,status:p.status||null,startedAt:n(p.startedAt),endsAt:n(p.endsAt),
        startingBalance:n(p.startingBalance),cash:n(p.cash),equity:n(p.equity),realizedPnl:n(p.realizedPnl),roiPct:n(p.roiPct),
        fees:n(p.fees),trades:n(p.trades),wins:n(p.wins),losses:n(p.losses),winRatePct:n(p.winRatePct),
        blocked:n(p.blocked),nofills:n(p.nofills),maxDrawdown:n(p.maxDrawdown),signals:n(p.signals),candidatesSeen:n(p.candidatesSeen),
        position:p.position||null,eventCount:Array.isArray(p.events)?p.events.length:0,
        recentEvents:Array.isArray(p.events)?p.events.slice(0,8):[]
      }
    };
  }
  async function sample(){
    const started=performance.now();
    try{
      const r=await fetch('/api/poly/demo/server',{cache:'no-store'});
      const j=await r.json();
      if(!r.ok)throw new Error(j.detail||('HTTP '+r.status));
      const snap=reduceServer(j);
      snap.httpMs=Math.round(performance.now()-started);
      lastSnapshot=snap;
      add('SERVER_SNAPSHOT',snap);

      const market=snap.market.slug||'';
      if(market!==lastMarket){add('MARKET_CHANGE',{from:lastMarket||null,to:market||null});lastMarket=market}
      const decision=String(snap.decision||'');
      if(decision!==lastServerDecision){add('DECISION_CHANGE',{from:lastServerDecision||null,to:decision,candidate:snap.candidate});lastServerDecision=decision}
      const feed=JSON.stringify(snap.feed||{});
      if(feed!==lastFeed){add('FEED_STATE_CHANGE',{feed:snap.feed});lastFeed=feed}
      const ec=snap.paper.eventCount;
      if(ec!==lastPaperEventCount){
        if(lastPaperEventCount>=0&&ec>lastPaperEventCount)add('PAPER_EVENT_CHANGE',{from:lastPaperEventCount,to:ec,recent:snap.paper.recentEvents});
        lastPaperEventCount=ec;
      }
    }catch(e){
      add('SERVER_SAMPLE_ERROR',{error:cleanError(e),httpMs:Math.round(performance.now()-started)});
    }
  }
  function browserState(){
    const s=window.POLY_EDGE_STATE||{};
    return {
      online:navigator.onLine,visibility:document.visibilityState,
      market:s.market?.slug||null,spot:n(s.spot),twap:n(s.twap),openRef:n(s.openRef),openTrusted:!!s.openTrusted,
      bbo:s.bbo||null,clobReadyState:s.clob?.readyState??null,rtdsReadyState:s.rtds?.readyState??null,
      latestOpportunity:!!s.latestOpportunity,
      latestBest:s.latestBest?{side:s.latestBest.side,ask:n(s.latestBest.ask),fair:n(s.latestBest.fair),net:n(s.latestBest.net)}:null
    };
  }
  function domState(){
    const g=id=>document.getElementById(id)?.textContent?.trim()||null;
    return {
      feedStatus:g('feedStatus'),marketState:g('marketState'),edgeState:g('edgeState'),decision:g('decision'),
      demoStatus:g('demoStatus'),demoWhy:g('demoWhy'),demoBest:g('demoBest'),demoFeed:g('demoFeed'),
      demoEquity:g('demoEquity'),demoPnl:g('demoPnl'),demoTrades:g('demoTrades'),demoBlocked:g('demoBlocked'),demoNoFill:g('demoNoFill')
    };
  }
  function download(){
    add('DOWNLOAD_CLICK',{browser:browserState(),dom:domState()});
    const ended=Date.now();
    const payload={
      format:'POLY_EDGE_DIAGNOSTIC_LOG_V1',
      session:{id:SESSION_ID,openedAt:OPENED_AT,openedAtIso:new Date(OPENED_AT).toISOString(),downloadedAt:ended,downloadedAtIso:new Date(ended).toISOString(),durationMs:ended-OPENED_AT},
      environment:{
        page:location.href,origin:location.origin,userAgent:navigator.userAgent,language:navigator.language,
        online:navigator.onLine,visibility:document.visibilityState,timezone:Intl.DateTimeFormat().resolvedOptions().timeZone||null
      },
      safety:{containsPrivateKeys:false,containsWalletCredentials:false,note:'Diagnostic market/model/paper-trade telemetry only.'},
      final:{server:lastSnapshot,browser:browserState(),dom:domState()},
      events
    };
    const blob=new Blob([JSON.stringify(payload,null,2)],{type:'application/json'});
    const url=URL.createObjectURL(blob);
    const a=document.createElement('a');
    const stamp=new Date().toISOString().replace(/[:.]/g,'-');
    a.href=url;a.download='poly-edge-diagnostic-'+stamp+'.json';
    document.body.appendChild(a);a.click();a.remove();
    setTimeout(()=>URL.revokeObjectURL(url),30000);
    const b=document.getElementById('downloadLogBtn');if(b){const old=b.textContent;b.textContent='✓ LOG DOWNLOADED';setTimeout(()=>b.textContent=old,1800)}
  }

  add('PAGE_OPEN',{browser:browserState(),dom:domState()});
  window.addEventListener('error',e=>add('WINDOW_ERROR',{message:String(e.message||''),filename:e.filename||null,line:e.lineno||null,column:e.colno||null,error:cleanError(e.error)}));
  window.addEventListener('unhandledrejection',e=>add('UNHANDLED_REJECTION',{error:cleanError(e.reason)}));
  window.addEventListener('online',()=>add('BROWSER_ONLINE',browserState()));
  window.addEventListener('offline',()=>add('BROWSER_OFFLINE',browserState()));
  document.addEventListener('visibilitychange',()=>add('VISIBILITY_CHANGE',browserState()));
  window.addEventListener('poly-edge-market-change',e=>add('BROWSER_MARKET_CHANGE',e.detail||{}));
  window.addEventListener('poly-edge-opportunity',e=>add('BROWSER_OPPORTUNITY',e.detail||{}));

  function boot(){
    const btn=document.getElementById('downloadLogBtn');
    if(btn)btn.addEventListener('click',download);
    sample();
    setInterval(sample,1000);
    setInterval(()=>add('BROWSER_HEARTBEAT',{browser:browserState(),dom:domState()}),10000);
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot,{once:true});else boot();
})();