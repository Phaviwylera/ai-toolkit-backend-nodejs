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

  const num=v=>Number.isFinite(Number(v))?Number(v):null;
  const fmt=(v,d=2)=>num(v)!==null?Number(v).toLocaleString('en-US',{minimumFractionDigits:d,maximumFractionDigits:d}):'—';
  const pct=v=>num(v)!==null?(Number(v)*100).toFixed(1)+'%':'—';
  const bps=v=>num(v)!==null?(Number(v)>=0?'+':'')+Number(v).toFixed(2)+' bps':'—';
  const set=(id,val,cls='')=>{const e=$(id);if(!e)return;e.textContent=val;if(cls)e.className=cls};

  function syncPublicState(j){
    state.snap=j;
    state.market=j.market||null;state.spot=num(j.spot)||0;state.twap=num(j.twap)||0;
    state.openRef=num(j.openRef)||0;state.openTrusted=!!j.openTrusted;state.bbo=j.bbo||state.bbo;
    state.latestBest=j.candidate||null;state.latestOpportunity=String(j.decision||'').startsWith('OPPORTUNITY_');
    state.latestMode=j.mode||'WAIT';state.clob.readyState=j.feed?.clob==='live'?1:0;state.rtds.readyState=j.feed?.rtds==='live'?1:0;
  }

  function render(j){
    syncPublicState(j);
    const m=j.market||{},b=j.bbo||{},model=j.model||{},c=j.candidate||{},paper=j.paper||{};
    const now=Number(j.serverTime)||Date.now()/1000,left=Math.max(0,(Number(m.endTs)||now)-now);
    const feedLive=j.feed?.market==='live'&&j.feed?.clob==='live'&&j.feed?.rtds==='live';
    set('feedStatus',feedLive?'SERVER LIVE':'SYNCING',feedLive?'good':'warn');
    set('clock',new Date(now*1000).toISOString().slice(11,19)+' UTC');
    set('marketState',m.acceptingOrders?'ACCEPTING ORDERS':'READ ONLY',m.acceptingOrders?'good':'warn');
    set('question',m.question||'Bitcoin Up or Down - 5 minute');
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
    set('leadBps',bps(model.leadBps));set('impulse5',bps(model.impulse5Bps));
    set('lagScore',num(model.lagScore)==null?'—':Number(model.lagScore).toFixed(2));
    set('sigma',num(model.sigma)==null?'—':(Number(model.sigma)*10000).toFixed(3)+' bp/sqrt(s)');
    set('strategyMode',j.mode||'WAIT',String(j.decision||'').startsWith('OPPORTUNITY_')?'good':'warn');

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
    set('edgeWhy',c.side?('Best '+c.side+' - fair '+pct(fair)+' vs ask '+pct(ask)+' - net '+(bestNet*100).toFixed(2)+'c - lead '+Number(model.leadBps||0).toFixed(2)+' bps.'):'Waiting for executable order book.');

    set('clobGate',j.feed?.clob==='live'?'LIVE':String(j.feed?.clob||'WARMING').toUpperCase(),j.feed?.clob==='live'?'good':'warn');
    set('rtdsGate',j.feed?.rtds==='live'?'LIVE':String(j.feed?.rtds||'WARMING').toUpperCase(),j.feed?.rtds==='live'?'good':'warn');

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
      const vals=[x.t.toLocaleTimeString(),x.side,(x.ask*100).toFixed(1)+'c',pct(x.fair),(x.net*100).toFixed(2)+'c',x.state];
      vals.forEach((v,i)=>{const e=document.createElement(i===5?'b':'span');e.textContent=v;if(i===4||i===5)e.className='good';r.append(e)});body.append(r);
    }
  }

  function drawChart(){
    const c=$('chart');if(!c)return;
    const r=c.getBoundingClientRect(),dpr=Math.max(1,Math.min(2,devicePixelRatio||1)),w=Math.max(320,r.width),h=Math.max(220,r.height||260);
    c.width=Math.floor(w*dpr);c.height=Math.floor(h*dpr);const x=c.getContext('2d');x.setTransform(dpr,0,0,dpr,0,0);x.clearRect(0,0,w,h);
    const data=state.history;if(data.length<2){requestAnimationFrame(drawChart);return}
    const vals=data.flatMap(a=>[a.spot,a.twap,a.open].filter(Number.isFinite)),lo=Math.min(...vals),hi=Math.max(...vals),pad=Math.max(1,(hi-lo)*.18),mn=lo-pad,mx=hi+pad;
    const t0=data[0].t,t1=data[data.length-1].t||t0+1,px=t=>24+(t-t0)/Math.max(1,t1-t0)*(w-42),py=p=>h-22-(p-mn)/Math.max(1,mx-mn)*(h-44);
    x.strokeStyle='rgba(255,255,255,.055)';x.lineWidth=1;
    for(let i=1;i<6;i++){x.beginPath();x.moveTo(22,i*h/6);x.lineTo(w-10,i*h/6);x.stroke()}
    const draw=(key,color,width,fill)=>{
      const arr=data.filter(a=>Number.isFinite(a[key]));if(arr.length<2)return;
      x.beginPath();arr.forEach((a,i)=>{const xx=px(a.t),yy=py(a[key]);i?x.lineTo(xx,yy):x.moveTo(xx,yy)});
      if(fill){const last=arr[arr.length-1],first=arr[0];x.lineTo(px(last.t),h-22);x.lineTo(px(first.t),h-22);x.closePath();const g=x.createLinearGradient(0,0,0,h);g.addColorStop(0,fill);g.addColorStop(1,'rgba(0,0,0,0)');x.fillStyle=g;x.fill();x.beginPath();arr.forEach((a,i)=>{i?x.lineTo(px(a.t),py(a[key])):x.moveTo(px(a.t),py(a[key]))})}
      x.strokeStyle=color;x.lineWidth=width;x.shadowColor=color;x.shadowBlur=8;x.stroke();x.shadowBlur=0;
    };
    draw('spot','#6cffa9',1.8,'rgba(108,255,169,.08)');draw('twap','#b36cff',1.4,null);
    const open=data[data.length-1].open;if(Number.isFinite(open)){x.setLineDash([5,6]);x.strokeStyle='rgba(255,200,87,.7)';x.beginPath();x.moveTo(22,py(open));x.lineTo(w-10,py(open));x.stroke();x.setLineDash([])}
    const last=data[data.length-1];x.fillStyle='#6cffa9';x.shadowColor='#6cffa9';x.shadowBlur=14;x.beginPath();x.arc(px(last.t),py(last.spot),3.5,0,Math.PI*2);x.fill();x.shadowBlur=0;
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

  async function poll(){
    const started=performance.now();
    try{
      const r=await fetch('/api/poly/demo/server',{cache:'no-store'}),j=await r.json();
      if(!r.ok)throw new Error(j.detail||('HTTP '+r.status));
      render(j);
      set('serverPing',Math.round(performance.now()-started)+' ms');
    }catch(e){set('feedStatus','SERVER ERROR','bad');set('decision','SERVER ERROR - '+e.message,'bad')}
  }

  async function alerts(){
    if(!('Notification'in window)){set('alertsBtn','ALERTS UNSUPPORTED');return}
    const p=await Notification.requestPermission();state.alerts=p==='granted';set('alertsBtn',state.alerts?'ALERTS ENABLED':'ALERTS '+p.toUpperCase());
  }

  function boot(){
    if($('alertsBtn'))$('alertsBtn').onclick=alerts;
    poll();setInterval(poll,750);requestAnimationFrame(drawChart);requestAnimationFrame(drawOrb);
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot,{once:true});else boot();
})();