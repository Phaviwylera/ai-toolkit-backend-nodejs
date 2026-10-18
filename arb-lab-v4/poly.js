'use strict';
(() => {
  const $=id=>document.getElementById(id);
  const state={
    snap:null,history:[],tape:[],alerts:false,lastMarket:'',lastSignalKey:'',lastSignalAt:0,
    market:null,spot:0,twap:0,openRef:0,openTrusted:false,bbo:{up:{},down:{}},
    latestBest:null,latestOpportunity:false,latestMode:'WARMING',
    clob:{readyState:0},rtds:{readyState:0}
  };
  window.POLY_EDGE_STATE=state;

  const num=v=>{if(v===null||v===undefined||v==='')return null;const x=Number(v);return Number.isFinite(x)?x:null;};
  const fmt=(v,d=2)=>num(v)!==null?Number(v).toLocaleString('en-US',{minimumFractionDigits:d,maximumFractionDigits:d}):'—';
  const pct=v=>num(v)!==null?(Number(v)*100).toFixed(1)+'%':'—';
  const bps=v=>num(v)!==null?(Number(v)>=0?'+':'')+Number(v).toFixed(2)+' bps':'—';
  const istClock=d=>new Intl.DateTimeFormat('en-IN',{timeZone:'Asia/Kolkata',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(d);
  const istTape=d=>new Intl.DateTimeFormat('en-IN',{timeZone:'Asia/Kolkata',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(d);
  const istMarket=ts=>new Intl.DateTimeFormat('en-IN',{timeZone:'Asia/Kolkata',day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit',hour12:true}).format(new Date(Number(ts)*1000));
  const set=(id,val,cls='')=>{const e=$(id);if(!e)return;e.textContent=val;if(cls)e.className=cls};

  function syncPublicState(j){
    state.snap=j;
    state.market=j.market||null;state.spot=num(j.spot)||0;state.twap=num(j.twap)||0;
    state.openRef=num(j.openRef)||0;state.openTrusted=!!j.openTrusted;state.bbo=j.bbo||state.bbo;
    state.latestBest=j.candidate||null;state.latestOpportunity=String(j.decision||'').startsWith('OPPORTUNITY_');
    state.latestMode=j.mode||'WAIT';state.clob.readyState=j.feed?.clob==='live'?1:0;state.rtds.readyState=j.feed?.rtds==='live'?1:0;
  }

  function renderDesk(desk){
    if(!desk)return;
    const agents=['ATLAS','VEGA','ORION','LUNA','TITAN','NOVA'];
    const idMap={ATLAS:'atlas',VEGA:'vega',ORION:'orion',LUNA:'luna',TITAN:'titan',NOVA:'nova'};
    for(const name of agents){
      const a=desk[name]||{},id=idMap[name],v=String(a.verdict||'WAIT');
      const cls=(/TRADE|APPROVE|CONFIRM|WATCH/.test(v)?'good':/REJECT|VETO|FAIL/.test(v)?'bad':'warn');
      set(id+'Verdict',v,cls);
      set(id+'Summary',a.summary||'No evidence yet.');
    }
    const sp=desk.sourcePack||{};
    const parts=[
      sp.paperOnly?'PAPER ONLY':null,
      sp.market?'LIVE MARKET':null,
      'NEWS '+String(sp.verifiedNewsCount||0),
      sp.sentimentDatasetConnected?'SENTIMENT CONNECTED':'NO SENTIMENT SOURCE'
    ].filter(Boolean);
    set('sourcePackState',parts.join(' · '),sp.paperOnly?'good':'warn');
  }

  function render(j){
    syncPublicState(j);
    renderDesk(j.desk);
    window.dispatchEvent(new CustomEvent('poly-edge-server-snapshot',{detail:j}));
    const m=j.market||{},b=j.bbo||{},model=j.model||{},c=j.candidate||{},paper=j.paper||{};
    const now=Number(j.serverTime)||Date.now()/1000,left=Math.max(0,(Number(m.endTs)||now)-now);
    const feedLive=j.feed?.market==='live'&&j.feed?.clob==='live'&&j.feed?.rtds==='live';
    set('feedStatus',feedLive?'SERVER LIVE':'SYNCING',feedLive?'good':'warn');
    set('clock',istClock(new Date(now*1000))+' IST');
    set('marketState',m.acceptingOrders?'ACCEPTING ORDERS':'READ ONLY',m.acceptingOrders?'good':'warn');
    set('question',m.startTs&&m.endTs?('Bitcoin Up or Down · '+istMarket(m.startTs)+' – '+istMarket(m.endTs)+' IST'):(m.question||'Bitcoin Up or Down · 5m'));
    set('timeLeft',String(Math.floor(left/60)).padStart(2,'0')+':'+String(Math.floor(left%60)).padStart(2,'0'));
    set('volume','$'+fmt(m.volume,0));set('liquidity','$'+fmt(m.liquidity,0));set('minOrder',m.minOrderSize?fmt(m.minOrderSize,2)+' shares':'—');
    if($('marketLink')&&m.slug)$('marketLink').href='https://polymarket.com/event/'+encodeURIComponent(m.slug);

    const up=b.up||{},down=b.down||{};
    set('upBbo',(num(up.bid)==null?'—':fmt(up.bid,3))+' / '+(num(up.ask)==null?'—':fmt(up.ask,3)));
    set('downBbo',(num(down.bid)==null?'—':fmt(down.bid,3))+' / '+(num(down.ask)==null?'—':fmt(down.ask,3)));
    set('upAsk',num(up.ask)==null?'—':pct(up.ask));set('downAsk',num(down.ask)==null?'—':pct(down.ask));

    set('spotPrice',num(j.spot)==null?'$—':'$'+fmt(j.spot,2));
    set('twapPrice',num(j.twap)==null?'$—':'$'+fmt(j.twap,2));
    set('openRef',num(j.openRef)==null?'WAIT NEXT OPEN':'$'+fmt(j.openRef,2));
    set('projectedTwap',num(model.projected)==null?'$—':'$'+fmt(model.projected,2));
    set('modelDistance',bps((num(model.margin)||0)*10000),(num(model.margin)||0)>=0?'good':'bad');
    set('refState',j.openTrusted?'TRUSTED OPEN':'WAITING',j.openTrusted?'good':'warn');
    set('captureState',j.openTrusted?'TRUSTED':'WAIT',j.openTrusted?'good':'warn');

    const age=Math.max(num(j.spotAgeSec)||999,num(j.twapAgeSec)||999);
    set('latency',age<900?(age*1000).toFixed(0)+' ms':'—',age<5?'good':'bad');
    set('leadBps',bps(model.leadBps));set('impulse5',bps(model.impulse5Bps));set('impulse5Mirror',bps(model.impulse5Bps));
    set('lagScore',num(model.lagScore)==null?'—':Number(model.lagScore).toFixed(2));
    set('sigma',num(model.sigma)==null?'—':(Number(model.sigma)*10000).toFixed(3)+' bp/sqrt(s)');
    set('strategyMode',j.mode||'WAIT',String(j.decision||'').startsWith('OPPORTUNITY_')?'good':'warn');set('strategyModeMirror',j.mode||'WAIT');

    const bestNet=num(c.net),fair=num(c.fair),ask=num(c.ask),fee=num(c.fee);
    set('fairUp',pct(model.fairUp));set('fairDown',pct(model.fairDown));
    set('feePerShare',fee==null?'—':'$'+fee.toFixed(4));
    set('rawEdge',num(c.raw)==null?'—':((c.raw>=0?'+':'')+(c.raw*100).toFixed(2)+'c'));
    set('netEdge',bestNet==null?'—':((bestNet>=0?'+':'')+(bestNet*100).toFixed(2)+'c'),bestNet>0?'good':'bad');
    set('bestEdge',bestNet==null?'—':((bestNet>=0?'+':'')+(bestNet*100).toFixed(2)+'c / share'),bestNet>0?'good':'bad');
    set('bestSide',c.side?c.side+' @ '+(ask*100).toFixed(1)+'c':'NO TRADE');
    if($('edgeBar'))$('edgeBar').style.width=Math.max(0,Math.min(100,(bestNet||0)*900))+'%';

    const decision=String(j.decision||'warming up'),op=decision.startsWith('OPPORTUNITY_');
    set('modelState',op?'MARKET MISTAKE':(j.mode||'WAIT'),op?'good':'warn');
    set('edgeState',op?'OPPORTUNITY':'NO TRADE',op?'good':'warn');
    set('decision',(op?'OPPORTUNITY - ':'NO TRADE - ')+(j.mode||'WAIT')+' - '+decision.replace(/^OPPORTUNITY_/,'').replaceAll('_',' '),op?'good':'warn');
    set('confidence',paper.position?.confidence!=null?Number(paper.position.confidence).toFixed(0)+'%':(num(model.reliability)!=null?(Number(model.reliability)*100).toFixed(0)+'%':'—'));
    set('edgeWhy',c.side?('ALIGNED '+c.side+' · fair '+pct(fair)+' vs ask '+pct(ask)+' · round-trip edge '+(bestNet*100).toFixed(2)+'c · lead '+Number(model.leadBps||0).toFixed(2)+' bps · 5s impulse '+Number(model.impulse5Bps||0).toFixed(2)+' bps.'):'Waiting for executable order book.');

    set('clobGate',j.feed?.clob==='live'?'LIVE':String(j.feed?.clob||'WARMING').toUpperCase(),j.feed?.clob==='live'?'good':'warn');
    set('rtdsGate',j.feed?.rtds==='live'?'LIVE':String(j.feed?.rtds||'WARMING').toUpperCase(),j.feed?.rtds==='live'?'good':'warn');

    if(!state.history.length&&Array.isArray(j.history)&&j.history.length){
      state.history=j.history.map(x=>({t:Number(x.t)*1000,spot:num(x.spot),twap:num(x.twap),open:num(x.open),fairUp:num(x.fairUp),upAsk:num(x.upAsk),equity:num(x.equity)})).filter(x=>x.spot);
    }
    const h={t:now*1000,spot:num(j.spot),twap:num(j.twap),open:num(j.openRef),fairUp:num(model.fairUp),upAsk:num(up.ask),equity:num(paper.equity)};
    if(h.spot&&(!state.history.length||h.t-state.history[state.history.length-1].t>=450))state.history.push(h);
    state.history=state.history.filter(x=>x.t>Date.now()-180000).slice(-360);

    if(m.slug&&m.slug!==state.lastMarket){
      window.dispatchEvent(new CustomEvent('poly-edge-market-change',{detail:{previous:{slug:state.lastMarket||null},current:m,finalTwap:j.twap,previousOpenRef:j.openRef}}));
      state.lastMarket=m.slug;
    }
    if(op&&c.side){
      const key=m.slug+'|'+c.side+'|'+j.mode;
      if(key!==state.lastSignalKey||Date.now()-state.lastSignalAt>4000){
        state.lastSignalKey=key;state.lastSignalAt=Date.now();
        const item={t:new Date(),side:c.side,ask,fair,net:bestNet,state:j.mode||'OPPORTUNITY'};
        state.tape.unshift(item);state.tape=state.tape.slice(0,40);renderTape();
        window.dispatchEvent(new CustomEvent('poly-edge-opportunity',{detail:{best:c,m:model,confidence:paper.position?.confidence||0,market:m,openRef:j.openRef,openTrusted:j.openTrusted,mode:j.mode}}));
        if(state.alerts&&'Notification'in window&&Notification.permission==='granted'){
          try{new Notification('POLY/EDGE - '+j.mode+' '+c.side,{body:'Net edge '+(bestNet*100).toFixed(2)+'c/share - '+Math.round(left)+'s left',tag:key})}catch{}
        }
      }
    }
  }

  function renderTape(){
    const body=$('tapeBody');if(!body)return;body.replaceChildren();
    if(!state.tape.length){const e=document.createElement('div');e.className='empty';e.textContent='No trade-quality signal yet.';body.append(e);return}
    for(const x of state.tape){
      const r=document.createElement('div');r.className='tapeRow';
      const vals=[istTape(x.t)+' IST',x.side,(x.ask*100).toFixed(1)+'c',pct(x.fair),(x.net*100).toFixed(2)+'c',x.state];
      vals.forEach((v,i)=>{const e=document.createElement(i===5?'b':'span');e.textContent=v;if(i===4||i===5)e.className='good';r.append(e)});body.append(r);
    }
  }

  function drawChart(){
    const c=$('chart');if(!c)return;
    const r=c.getBoundingClientRect(),dpr=Math.max(1,Math.min(2,devicePixelRatio||1));
    const w=Math.max(320,r.width),h=Math.max(240,r.height||270);
    c.width=Math.floor(w*dpr);c.height=Math.floor(h*dpr);
    const x=c.getContext('2d');x.setTransform(dpr,0,0,dpr,0,0);x.clearRect(0,0,w,h);

    const validPrice=v=>Number.isFinite(v)&&v>1000;
    const data=state.history.filter(a=>validPrice(a.spot)||validPrice(a.twap)).slice(-300);
    if(data.length<2){requestAnimationFrame(drawChart);return}

    const plotL=52,plotR=w-18,priceTop=16,priceBottom=h*.73,leadTop=h*.79,leadBottom=h-20;
    const t0=data[0].t,t1=data[data.length-1].t||t0+1;
    const px=t=>plotL+(t-t0)/Math.max(1,t1-t0)*(plotR-plotL);

    // Scale only from recent BTC spot/TWAP values. Missing/open=0 can never flatten it.
    const prices=data.flatMap(a=>[a.spot,a.twap].filter(validPrice));
    let lo=Math.min(...prices),hi=Math.max(...prices);
    const center=(lo+hi)/2;
    // Guarantee a useful zoom even during a quiet period.
    const observed=Math.max(.5,hi-lo);
    const minVisualSpan=Math.max(6,center*.00006);
    const span=Math.max(observed*1.45,minVisualSpan);
    let mn=center-span/2,mx=center+span/2;

    const open=[...data].reverse().map(a=>a.open).find(validPrice);
    // Include OPEN only when reasonably close. Otherwise keep microstructure zoom intact.
    if(validPrice(open)){
      const local=mx-mn,dist=Math.min(Math.abs(open-mn),Math.abs(open-mx));
      if(open>=mn-local*.6&&open<=mx+local*.6){
        mn=Math.min(mn,open-local*.08);mx=Math.max(mx,open+local*.08);
      }
    }
    const py=p=>priceBottom-(p-mn)/Math.max(.01,mx-mn)*(priceBottom-priceTop);

    // Price grid and live dollar labels.
    x.font='9px ui-monospace,SFMono-Regular,Menlo,monospace';
    x.textAlign='right';x.textBaseline='middle';
    for(let i=0;i<=4;i++){
      const yy=priceTop+(priceBottom-priceTop)*i/4;
      const price=mx-(mx-mn)*i/4;
      x.strokeStyle='rgba(255,255,255,.055)';x.lineWidth=1;
      x.beginPath();x.moveTo(plotL,yy);x.lineTo(plotR,yy);x.stroke();
      x.fillStyle='rgba(130,150,140,.7)';x.fillText('$'+price.toFixed(2),plotL-7,yy);
    }

    const drawPrice=(key,color,width,fill)=>{
      const arr=data.filter(a=>validPrice(a[key]));if(arr.length<2)return;
      const points=arr.map(a=>[px(a.t),py(a[key])]);
      if(fill){
        x.beginPath();points.forEach((p,i)=>i?x.lineTo(p[0],p[1]):x.moveTo(p[0],p[1]));
        x.lineTo(points[points.length-1][0],priceBottom);x.lineTo(points[0][0],priceBottom);x.closePath();
        const g=x.createLinearGradient(0,priceTop,0,priceBottom);g.addColorStop(0,fill);g.addColorStop(1,'rgba(0,0,0,0)');
        x.fillStyle=g;x.fill();
      }
      x.beginPath();points.forEach((p,i)=>i?x.lineTo(p[0],p[1]):x.moveTo(p[0],p[1]));
      x.strokeStyle=color;x.lineWidth=width;x.lineJoin='round';x.lineCap='round';x.shadowColor=color;x.shadowBlur=7;x.stroke();x.shadowBlur=0;
    };
    drawPrice('spot','#6cffa9',2.0,'rgba(108,255,169,.075)');
    drawPrice('twap','#b36cff',1.55,null);

    // Opening reference never controls the zoom if it is far away.
    if(validPrice(open)){
      if(open>=mn&&open<=mx){
        const oy=py(open);x.setLineDash([5,6]);x.strokeStyle='rgba(255,200,87,.85)';x.lineWidth=1;
        x.beginPath();x.moveTo(plotL,oy);x.lineTo(plotR,oy);x.stroke();x.setLineDash([]);
        x.fillStyle='#ffc857';x.textAlign='left';x.fillText('OPEN $'+open.toFixed(2),plotL+6,Math.max(priceTop+8,oy-8));
      }else{
        const above=open>mx,yy=above?priceTop+8:priceBottom-8;
        x.fillStyle='#ffc857';x.textAlign='left';x.fillText((above?'▲ ':'▼ ')+'OPEN $'+open.toFixed(2)+' · OFF RANGE',plotL+6,yy);
      }
    }

    // Current live markers + labels.
    const last=[...data].reverse().find(a=>validPrice(a.spot));
    if(last&&validPrice(last.spot)){
      const lx=px(last.t),ly=py(last.spot);
      x.fillStyle='#6cffa9';x.shadowColor='#6cffa9';x.shadowBlur=14;x.beginPath();x.arc(lx,ly,3.8,0,Math.PI*2);x.fill();x.shadowBlur=0;
      x.fillStyle='#6cffa9';x.textAlign='right';x.fillText('$'+last.spot.toFixed(2),plotR,Math.max(priceTop+8,ly-10));
    }

    // Lower strip: SPOT minus TWAP in bps. This exposes the actual lag signal.
    const lead=data.map(a=>({t:a.t,v:(validPrice(a.spot)&&validPrice(a.twap))?(a.spot/a.twap-1)*10000:null})).filter(a=>Number.isFinite(a.v));
    x.strokeStyle='rgba(255,255,255,.07)';x.beginPath();x.moveTo(plotL,(leadTop+leadBottom)/2);x.lineTo(plotR,(leadTop+leadBottom)/2);x.stroke();
    x.fillStyle='rgba(130,150,140,.72)';x.textAlign='left';x.fillText('SPOT−TWAP LEAD (bps)',plotL,leadTop-8);
    if(lead.length>=2){
      const abs=Math.max(.12,...lead.map(a=>Math.abs(a.v)))*1.18;
      const lpy=v=>(leadTop+leadBottom)/2-v/abs*(leadBottom-leadTop)*.44;
      x.beginPath();lead.forEach((a,i)=>i?x.lineTo(px(a.t),lpy(a.v)):x.moveTo(px(a.t),lpy(a.v)));
      x.strokeStyle='#63d7ff';x.lineWidth=1.4;x.shadowColor='#63d7ff';x.shadowBlur=6;x.stroke();x.shadowBlur=0;
      const lv=lead[lead.length-1].v;
      x.fillStyle=lv>=0?'#6cffa9':'#ff6076';x.textAlign='right';x.fillText((lv>=0?'+':'')+lv.toFixed(3)+' bps',plotR,leadTop-8);
    }

    requestAnimationFrame(drawChart);
  }
  function drawOrb(){
    const c=$('orbCanvas');if(!c){requestAnimationFrame(drawOrb);return}
    const r=c.getBoundingClientRect(),dpr=Math.max(1,Math.min(2,devicePixelRatio||1)),w=Math.max(280,r.width),h=Math.max(320,r.height||420);
    c.width=Math.floor(w*dpr);c.height=Math.floor(h*dpr);const x=c.getContext('2d');x.setTransform(dpr,0,0,dpr,0,0);x.clearRect(0,0,w,h);
    const cx=w/2,cy=h/2,R=Math.min(w,h)*.34,t=performance.now()/1000,m=state.snap?.model||{},best=state.snap?.candidate||{},fair=best.side==='DOWN'?m.fairDown:m.fairUp,edge=Math.max(0,Math.min(1,(Number(best.net)||0)*8));
    const bg=x.createRadialGradient(cx,cy,0,cx,cy,R*1.35);bg.addColorStop(0,'rgba(108,255,169,.10)');bg.addColorStop(.48,'rgba(119,52,190,.05)');bg.addColorStop(1,'rgba(0,0,0,0)');x.fillStyle=bg;x.fillRect(0,0,w,h);
    x.save();x.translate(cx,cy);
    for(let k=0;k<5;k++){const rr=R*(.40+k*.16);x.beginPath();x.setLineDash(k%2?[2,8]:[1,6]);x.strokeStyle=k===4?'rgba(108,255,169,.24)':'rgba(255,255,255,.08)';x.lineWidth=1;x.arc(0,0,rr,0,Math.PI*2);x.stroke()}
    x.setLineDash([]);
    for(let k=0;k<18;k++){const a=k/18*Math.PI*2+t*(k%2?-.08:.05),rr=R*(.66+(k%4)*.08);x.fillStyle=k%3===0?'rgba(108,255,169,.8)':'rgba(179,108,255,.5)';x.beginPath();x.arc(Math.cos(a)*rr,Math.sin(a)*rr,k%3===0?2.4:1.3,0,Math.PI*2);x.fill()}
    if(Number.isFinite(Number(fair))){x.beginPath();x.strokeStyle='#6cffa9';x.shadowColor='#6cffa9';x.shadowBlur=14;x.lineWidth=8;x.lineCap='round';x.arc(0,0,R*.82,-Math.PI/2,-Math.PI/2+Math.PI*2*Number(fair));x.stroke();x.shadowBlur=0}
    x.beginPath();x.strokeStyle='rgba(255,79,216,.85)';x.lineWidth=3;x.arc(0,0,R*1.04,-Math.PI/2,-Math.PI/2+Math.PI*2*edge);x.stroke();
    const a=t*.8;x.rotate(a);x.strokeStyle='rgba(120,223,255,.7)';x.lineWidth=1;x.beginPath();x.moveTo(0,0);x.lineTo(R*1.12,0);x.stroke();x.fillStyle='#78dfff';x.beginPath();x.arc(R*.72,0,3,0,Math.PI*2);x.fill();x.restore();
    set('orbMode',state.latestMode||'WAIT');set('orbSide',best.side||'—');set('orbEdge',num(best.net)==null?'—':((best.net>=0?'+':'')+(best.net*100).toFixed(2)+'c'));set('orbLead',num(m.leadBps)==null?'LEAD —':'LEAD '+bps(m.leadBps));
    requestAnimationFrame(drawOrb);
  }

  let pollTimer=null,pollBusy=false,pollDelay=1000;
  function schedulePoll(delay=pollDelay){
    clearTimeout(pollTimer);
    pollTimer=setTimeout(poll,document.hidden?Math.max(1800,delay):delay);
  }
  async function poll(){
    if(pollBusy){schedulePoll();return}
    pollBusy=true;
    const started=performance.now();
    try{
      const r=await fetch('/api/poly/demo/server',{cache:'no-store'});
      let j=null;try{j=await r.json()}catch{}
      if(r.status===429){
        const retry=Number(r.headers.get('Retry-After'))||5;
        pollDelay=Math.max(2500,retry*1000);
        set('feedStatus','RATE LIMIT BACKOFF','warn');
        set('decision','PAUSED POLLING - server rate-limit backoff '+Math.ceil(pollDelay/1000)+'s','warn');
        window.dispatchEvent(new CustomEvent('poly-edge-server-error',{detail:{status:429,message:j?.detail||'Rate limit reached',retryMs:pollDelay,t:Date.now()}}));
        return;
      }
      if(!r.ok)throw new Error(j?.detail||('HTTP '+r.status));
      pollDelay=1000;
      render(j);
      window.POLY_EDGE_LATEST_SNAPSHOT=j;
      window.dispatchEvent(new CustomEvent('poly-edge-server-snapshot',{detail:j}));
      set('serverPing',Math.round(performance.now()-started)+' ms');
    }catch(e){
      pollDelay=Math.min(5000,Math.max(1500,pollDelay*1.5));
      set('feedStatus','SERVER RETRY','bad');set('decision','SERVER RETRY - '+e.message,'bad');
      window.dispatchEvent(new CustomEvent('poly-edge-server-error',{detail:{status:0,message:String(e.message||e),retryMs:pollDelay,t:Date.now()}}));
    }finally{
      pollBusy=false;
      schedulePoll();
    }
  }

  async function alerts(){
    if(!('Notification'in window)){set('alertsBtn','ALERTS UNSUPPORTED');return}
    const p=await Notification.requestPermission();state.alerts=p==='granted';set('alertsBtn',state.alerts?'ALERTS ENABLED':'ALERTS '+p.toUpperCase());
  }

  function boot(){
    if($('alertsBtn'))$('alertsBtn').onclick=alerts;
    poll();requestAnimationFrame(drawChart);requestAnimationFrame(drawOrb);
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot,{once:true});else boot();
})();