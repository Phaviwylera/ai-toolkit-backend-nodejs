'use strict';
(() => {
  const $=id=>document.getElementById(id);
  let last=null;

  function set(id,val,cls=''){const e=$(id);if(!e)return;e.textContent=val;if(cls)e.className=cls}
  function money(n,d=4){n=Number(n)||0;return (n>=0?'+$':'-$')+Math.abs(n).toFixed(d)}
  function pct(n,d=1){return (Number(n)||0).toFixed(d)+'%'}
  function feedText(feed){
    if(!feed)return 'WARMING';
    return 'MARKET '+String(feed.market||'—').toUpperCase()+' · CLOB '+String(feed.clob||'—').toUpperCase()+' · RTDS '+String(feed.rtds||'—').toUpperCase();
  }

  function renderReasons(reasons){
    const box=$('demoReasons');if(!box)return;box.replaceChildren();
    const entries=Object.entries(reasons||{}).sort((a,b)=>b[1]-a[1]).slice(0,8);
    if(!entries.length){
      const d=document.createElement('div');const s=document.createElement('span');s.textContent='AUDIT';const b=document.createElement('b');b.textContent='Collecting gate decisions…';d.append(s,b);box.append(d);return;
    }
    for(const [reason,count] of entries){
      const d=document.createElement('div'),s=document.createElement('span'),b=document.createElement('b');
      s.textContent=reason.toUpperCase();b.textContent=String(count)+' checks';d.append(s,b);box.append(d);
    }
  }

  function renderEvents(events){
    const body=$('demoTape');if(!body)return;body.replaceChildren();
    if(!Array.isArray(events)||!events.length){
      const e=document.createElement('div');e.className='empty';e.textContent='No paper order yet. Decision audit above shows why.';body.append(e);return;
    }
    for(const x of events.slice(0,35)){
      const row=document.createElement('div');row.className='demoRow';
      const vals=[
        new Date((Number(x.t)||0)*1000).toLocaleTimeString(),
        x.action||'—',x.side||'—',
        Number.isFinite(Number(x.price))?(Number(x.price)*100).toFixed(1)+'¢':'—',
        Number.isFinite(Number(x.pnl))?(Number(x.pnl)>=0?'+$':'-$')+Math.abs(Number(x.pnl)).toFixed(4):'—',
        x.detail||''
      ];
      vals.forEach((v,i)=>{
        const e=document.createElement(i===1||i===4?'b':'span');e.textContent=v;
        if(i===1)e.className=x.action==='BUY'?'buy':x.action==='SELL'?'sell':'';
        if(i===4&&Number.isFinite(Number(x.pnl)))e.className=Number(x.pnl)>=0?'win':'loss';
        row.append(e);
      });
      body.append(row);
    }
  }

  function render(j){
    last=j;
    const p=j.paper||{},eq=Number(p.equity)||0,start=Number(p.startingBalance)||20,real=Number(p.realizedPnl)||0;
    set('demoEquity','$'+eq.toFixed(4),eq>=start?'good':'bad');
    set('demoPnl',money(real,4),real>=0?'good':'bad');
    set('demoTrades',String(p.trades||0));
    set('demoWinRate',p.trades?pct(p.winRatePct||0,1):'—');
    set('demoFees','$'+Number(p.fees||0).toFixed(4));
    set('demoDrawdown',pct((Number(p.maxDrawdown)||0)*100,2));
    set('demoBlocked',String(p.blocked||0));
    set('demoNoFill',String(p.nofills||0));
    const left=Math.max(0,Math.floor((Number(p.endsAt)||0)-Number(j.serverTime||Date.now()/1000)));
    set('demoLeft',String(Math.floor(left/3600)).padStart(2,'0')+':'+String(Math.floor((left%3600)/60)).padStart(2,'0')+':'+String(left%60).padStart(2,'0'));
    const status=p.status==='complete'?'COMPLETE':'SERVER LIVE PAPER';
    set('demoStatus',status,p.status==='complete'?'warn':'good');

    if(p.position){
      const side=p.position.side||'—',key=side==='UP'?'up':'down';
      const bid=Number(j.bbo?.[key]?.bid);
      set('demoPosition',side+' · '+Number(p.position.shares||0).toFixed(2)+' shares · entry '+(Number(p.position.entryPrice||0)*100).toFixed(1)+'¢ · live bid '+(Number.isFinite(bid)?(bid*100).toFixed(1)+'¢':'—'),'warn');
    }else set('demoPosition','NO OPEN PAPER POSITION');

    set('demoWhy',(j.mode?j.mode+' · ':'')+(j.decision||'warming up'),String(j.decision||'').startsWith('OPPORTUNITY_')?'good':'warn');
    if(j.candidate){
      set('demoBest',(j.candidate.side||'—')+' ask '+(Number(j.candidate.ask||0)*100).toFixed(1)+'¢ · fair '+(Number(j.candidate.fair||0)*100).toFixed(1)+'% · net '+(Number(j.candidate.net||0)*100).toFixed(2)+'¢');
    }else set('demoBest','—');
    set('demoFeed',feedText(j.feed),(j.feed?.market==='live'&&j.feed?.clob==='live'&&j.feed?.rtds==='live')?'good':'warn');

    renderReasons(j.reasonCounts);
    renderEvents(p.events);
  }

  function acceptSnapshot(j){
    if(j&&typeof j==='object')render(j);
  }

  window.addEventListener('poly-edge-server-snapshot',e=>acceptSnapshot(e.detail));
  window.addEventListener('poly-edge-server-error',e=>{
    const d=e.detail||{};
    if(d.status===429){set('demoStatus','RATE LIMIT BACKOFF','warn');set('demoWhy','Shared feed backing off '+Math.ceil((d.retryMs||0)/1000)+'s','warn')}
  });

  function boot(){
    const snap=window.POLY_EDGE_STATE?.snap;if(snap)acceptSnapshot(snap);
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot,{once:true});else boot();
})();