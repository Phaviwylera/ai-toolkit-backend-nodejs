from __future__ import annotations
import asyncio, json, math, time
from collections import deque, defaultdict
from pathlib import Path
import httpx
import websockets

POLY_GAMMA='https://gamma-api.polymarket.com'
POLY_CLOB='https://clob.polymarket.com'
COINBASE_REST='https://api.exchange.coinbase.com'
CLOB_WS='wss://ws-subscriptions-clob.polymarket.com/ws/market'
RTDS_WS='wss://ws-live-data.polymarket.com'
STATE_FILE=Path('/tmp/poly_server_demo_v1.json')
DEMO_BALANCE=20.0
MAX_TRADE_NOTIONAL=6.0
FEED_FRESH_SEC=5.0
OPEN_STABILIZE_SEC=15.0
LAG_MIN_REMAINING_SEC=18.0
RESOLUTION_WINDOW_SEC=75.0

def _jsonish(v):
    if isinstance(v,list): return v
    if not isinstance(v,str): return []
    try:
        x=json.loads(v)
        return x if isinstance(x,list) else []
    except Exception:
        return []

def _best(book, side):
    rows=book.get(side) or []
    vals=[]
    for row in rows:
        try: vals.append((float(row.get('price')),float(row.get('size') or 0)))
        except Exception: pass
    if not vals: return {'price':None,'size':0.0}
    p=max(x[0] for x in vals) if side=='bids' else min(x[0] for x in vals)
    return {'price':p,'size':sum(x[1] for x in vals if x[0]==p)}

def _cdf(x):
    return .5*(1+math.erf(x/math.sqrt(2)))

def _fee_per_share(price):
    return round(0.07*price*(1-price),5)

class PolyServerDemo:
    def __init__(self):
        self.market=None
        self.bbo={'up':{'bid':None,'ask':None,'bidSize':0.0,'askSize':0.0},
                  'down':{'bid':None,'ask':None,'bidSize':0.0,'askSize':0.0}}
        self.spot=None; self.spot_ts=0.0
        self.twap=None; self.twap_ts=0.0
        self.open_ref=None; self.open_ref_ts=0.0; self.open_trusted=False
        self.spot_sec={}
        self.twap_hist=deque(maxlen=300)
        self.visual_history=deque(maxlen=900)
        self.fallback_sigma=0.00008
        self.feed={'market':'warming','clob':'warming','rtds':'warming'}
        self.latest_model=None
        self.latest_candidate=None
        self.latest_reason='warming up'
        self.latest_mode='WARMING'
        self.reason_counts=defaultdict(int)
        self.last_reason_count_at=0.0
        self.paper=None
        self.pending=False
        self.market_version=0
        self.tasks=[]
        self.started=False

    async def _get(self,url,params=None,headers=None):
        async with httpx.AsyncClient(timeout=12,follow_redirects=False) as c:
            r=await c.get(url,params=params,headers=headers)
        r.raise_for_status()
        return r.json()

    async def start(self):
        if self.started: return
        self.started=True
        await self._seed_sigma()
        if not self._restore_saved():
            self._new_session()
        self.tasks=[
            asyncio.create_task(self.market_worker(),name='poly-market'),
            asyncio.create_task(self.clob_worker(),name='poly-clob'),
            asyncio.create_task(self.rtds_worker(),name='poly-rtds'),
            asyncio.create_task(self.engine_worker(),name='poly-paper'),
        ]

    def _restore_saved(self):
        try:
            if not STATE_FILE.exists(): return False
            data=json.loads(STATE_FILE.read_text(encoding='utf-8'))
            p=data.get('paper')
            now=time.time()
            if not isinstance(p,dict) or float(p.get('endsAt') or 0)<=now:
                return False
            # Strip calculated presentation fields before resuming mutable state.
            p=dict(p)
            p.pop('equity',None);p.pop('roiPct',None);p.pop('winRatePct',None)
            self.paper=p
            self.reason_counts=defaultdict(int,data.get('reasonCounts') or {})
            self.visual_history.clear()
            for row in (data.get('history') or [])[-900:]:
                if isinstance(row,dict): self.visual_history.append(row)
            m=data.get('market')
            if isinstance(m,dict) and float(m.get('startTs') or 0)<=now<float(m.get('endTs') or 0):
                self.market=m
                b=data.get('bbo')
                if isinstance(b,dict): self.bbo=b
                self.open_ref=data.get('openRef')
                self.open_trusted=bool(data.get('openTrusted') and self.open_ref)
                self.latest_model=data.get('model')
                self.latest_candidate=data.get('candidate')
                self.latest_reason=data.get('decision') or 'restored'
                self.latest_mode=data.get('mode') or 'RESTORED'
                self.spot=data.get('spot')
                self.twap=data.get('twap')
                sa=data.get('spotAgeSec');ta=data.get('twapAgeSec')
                if self.spot is not None:self.spot_ts=now-max(0,float(sa or 0))
                if self.twap is not None:self.twap_ts=now-max(0,float(ta or 0))
            print(f"POLY_DEMO_RESTORED session={self.paper.get('sessionId')} market={self.market.get('slug') if self.market else None} openTrusted={self.open_trusted}",flush=True)
            return True
        except Exception as exc:
            print(f"POLY_DEMO_RESTORE_FAILED {type(exc).__name__}",flush=True)
            return False

    def _new_session(self):
        now=time.time()
        self.paper={
            'version':3,'sessionId':'srv_'+hex(int(now*1_000_000))[2:],
            'startedAt':now,'endsAt':now+10800,'startingBalance':20.0,'cash':20.0,
            'realizedPnl':0.0,'fees':0.0,'trades':0,'wins':0,'losses':0,
            'blocked':0,'nofills':0,'peakEquity':20.0,'maxDrawdown':0.0,
            'position':None,'events':[],'status':'running','lastOpportunityAt':0.0,
            'signals':0,'candidatesSeen':0
        }
        self.reason_counts.clear()
        self._save()

    async def reset(self):
        self._new_session()
        return self.snapshot()

    async def _seed_sigma(self):
        try:
            data=await self._get(COINBASE_REST+'/products/BTC-USD/candles',
                                 params={'granularity':'60'},headers={'User-Agent':'POLY-EDGE/1.0'})
            rows=sorted(data,key=lambda x:x[0])[-120:]
            closes=[float(x[4]) for x in rows]
            rs=[math.log(b/a) for a,b in zip(closes,closes[1:]) if a>0 and b>0]
            if rs:
                rms=math.sqrt(sum(r*r for r in rs)/len(rs))
                self.fallback_sigma=max(1e-6,rms/math.sqrt(60))
        except Exception as e:
            print('POLY_DEMO_SIGMA_FALLBACK',type(e).__name__,flush=True)

    async def fetch_current_market(self):
        now=int(time.time());bucket=(now//300)*300
        selected=None
        for ts in [bucket,bucket+300,bucket-300]:
            try: data=await self._get(POLY_GAMMA+'/markets',{'slug':f'btc-updown-5m-{ts}'})
            except Exception: continue
            if isinstance(data,list) and data:
                selected=(ts,data[0])
                if ts==bucket: break
        if not selected: raise RuntimeError('current market unavailable')
        ts,m=selected
        outs=_jsonish(m.get('outcomes')); tids=_jsonish(m.get('clobTokenIds'))
        mp={str(o).strip().lower():str(t) for o,t in zip(outs,tids)}
        up=mp.get('up') or mp.get('yes');down=mp.get('down') or mp.get('no')
        if not up or not down: raise RuntimeError('token mapping unavailable')
        ub,db=await asyncio.gather(
            self._get(POLY_CLOB+'/book',{'token_id':up}),
            self._get(POLY_CLOB+'/book',{'token_id':down})
        )
        return {
            'slug':m.get('slug') or f'btc-updown-5m-{ts}','question':m.get('question'),
            'startTs':ts,'endTs':ts+300,'active':bool(m.get('active')),
            'closed':bool(m.get('closed')),'acceptingOrders':bool(m.get('acceptingOrders')),
            'minOrderSize':float(m.get('orderMinSize') or 0),
            'minTickSize':float(m.get('orderPriceMinTickSize') or .01),
            'volume':float(m.get('volumeNum') or m.get('volume') or 0),
            'liquidity':float(m.get('liquidityNum') or m.get('liquidity') or 0),
            'upToken':up,'downToken':down,
            'up':{'bid':_best(ub,'bids'),'ask':_best(ub,'asks')},
            'down':{'bid':_best(db,'bids'),'ask':_best(db,'asks')}
        }

    def _apply_rest_book(self,m):
        for side in ('up','down'):
            self.bbo[side]['bid']=m[side]['bid']['price']
            self.bbo[side]['bidSize']=m[side]['bid']['size']
            self.bbo[side]['ask']=m[side]['ask']['price']
            self.bbo[side]['askSize']=m[side]['ask']['size']

    async def market_worker(self):
        while True:
            try:
                m=await self.fetch_current_market()
                old=self.market
                changed=not old or old.get('slug')!=m.get('slug')
                if changed:
                    if old and self.paper and self.paper.get('position') and self.paper['position'].get('marketSlug')==old.get('slug'):
                        await self._settle_position(old.get('slug'))
                    self.open_ref=None;self.open_ref_ts=0;self.open_trusted=False
                    self.market_version+=1
                    print('POLY_DEMO_MARKET',m['slug'],flush=True)
                self.market=m;self._apply_rest_book(m);self.feed['market']='live'
            except Exception as e:
                self.feed['market']='error:'+type(e).__name__
            await asyncio.sleep(1.2)

    async def clob_worker(self):
        while True:
            if not self.market:
                await asyncio.sleep(.5);continue
            version=self.market_version
            up=self.market['upToken'];down=self.market['downToken']
            try:
                async with websockets.connect(CLOB_WS,ping_interval=None,close_timeout=2,max_size=2_000_000) as ws:
                    await ws.send(json.dumps({'type':'market','assets_ids':[up,down],'initial_dump':True,'custom_feature_enabled':True}))
                    self.feed['clob']='live'
                    print('POLY_DEMO_CLOB_CONNECTED',self.market.get('slug'),flush=True)
                    async def pinger():
                        while True:
                            await asyncio.sleep(10)
                            await ws.send('PING')
                    pt=asyncio.create_task(pinger())
                    try:
                        while version==self.market_version:
                            raw=await asyncio.wait_for(ws.recv(),timeout=15)
                            if raw=='PONG': continue
                            try: data=json.loads(raw)
                            except Exception: continue
                            msgs=data if isinstance(data,list) else [data]
                            for msg in msgs:self._handle_clob(msg)
                    finally:
                        pt.cancel()
            except Exception as e:
                self.feed['clob']='error:'+type(e).__name__
                await asyncio.sleep(1)

    def _handle_clob(self,m):
        if not self.market or not isinstance(m,dict): return
        def side_for(t):
            if str(t)==str(self.market.get('upToken')): return 'up'
            if str(t)==str(self.market.get('downToken')): return 'down'
            return None
        et=m.get('event_type')
        if et=='book':
            side=side_for(m.get('asset_id'))
            if not side:return
            bids=[(float(x['price']),float(x.get('size') or 0)) for x in (m.get('bids') or []) if 'price'in x]
            asks=[(float(x['price']),float(x.get('size') or 0)) for x in (m.get('asks') or []) if 'price'in x]
            if bids:
                p=max(x[0] for x in bids);self.bbo[side]['bid']=p;self.bbo[side]['bidSize']=sum(x[1] for x in bids if x[0]==p)
            if asks:
                p=min(x[0] for x in asks);self.bbo[side]['ask']=p;self.bbo[side]['askSize']=sum(x[1] for x in asks if x[0]==p)
        elif et=='price_change':
            for pc in (m.get('price_changes') or m.get('changes') or []):
                side=side_for(pc.get('asset_id'))
                if not side:continue
                if pc.get('best_bid') is not None:self.bbo[side]['bid']=float(pc['best_bid'])
                if pc.get('best_ask') is not None:self.bbo[side]['ask']=float(pc['best_ask'])
        elif et=='best_bid_ask':
            side=side_for(m.get('asset_id'))
            if side:
                if m.get('best_bid') is not None:self.bbo[side]['bid']=float(m['best_bid'])
                if m.get('best_ask') is not None:self.bbo[side]['ask']=float(m['best_ask'])

    async def rtds_worker(self):
        while True:
            try:
                async with websockets.connect(RTDS_WS,ping_interval=None,close_timeout=2,max_size=2_000_000) as ws:
                    flt=json.dumps({'symbol':'btc/usd'},separators=(',',':'))
                    await ws.send(json.dumps({'action':'subscribe','subscriptions':[
                        {'topic':'crypto_prices_chainlink','type':'update','filters':flt},
                        {'topic':'crypto_prices_twap_sixty','type':'update','filters':flt}
                    ]}))
                    self.feed['rtds']='live'
                    print('POLY_DEMO_RTDS_CONNECTED',flush=True)
                    async def pinger():
                        while True:
                            await asyncio.sleep(5);await ws.send('PING')
                    pt=asyncio.create_task(pinger())
                    try:
                        while True:
                            raw=await asyncio.wait_for(ws.recv(),timeout=12)
                            if raw=='PONG':continue
                            try:data=json.loads(raw)
                            except Exception:continue
                            for msg in (data if isinstance(data,list) else [data]):self._handle_rtds(msg)
                    finally:pt.cancel()
            except Exception as e:
                self.feed['rtds']='error:'+type(e).__name__
                print('POLY_DEMO_RTDS_ERROR',type(e).__name__,str(e)[:180],flush=True)
                await asyncio.sleep(1)

    def _handle_rtds(self,m):
        if not isinstance(m,dict) or m.get('message'):return
        topic=str(m.get('topic') or '')
        p=m.get('payload') or m.get('data') or {}
        try:value=float(p.get('value',p.get('full_accuracy_value',m.get('value'))))
        except Exception:return
        try:ts=float(p.get('timestamp',m.get('timestamp',time.time()*1000)))
        except Exception:ts=time.time()*1000
        tms=ts*1000 if ts<1e12 else ts
        if value<=0:return
        if topic in {'crypto_prices','crypto_prices_chainlink'}:
            self.spot=value;self.spot_ts=tms/1000
            sec=int(tms/1000);self.spot_sec[sec]=value
            cutoff=int(time.time())-300
            for k in list(self.spot_sec):
                if k<cutoff:self.spot_sec.pop(k,None)
        elif topic=='crypto_prices_twap_sixty':
            self.twap=value;self.twap_ts=tms/1000
            self.twap_hist.append({'t':tms/1000,'p':value})
            if self.market and self.open_ref is None:
                start=float(self.market['startTs'])
                delta=abs(tms/1000-start)
                if delta<=8:
                    self.open_ref=value;self.open_ref_ts=tms/1000;self.open_trusted=True
                    print('POLY_DEMO_OPEN_TRUSTED',self.market['slug'],value,flush=True)
                elif start+8<tms/1000<start+22:
                    self.open_ref=value;self.open_ref_ts=tms/1000;self.open_trusted=False

    def _series(self):
        return [{'t':k,'p':v} for k,v in sorted(self.spot_sec.items())]

    def _avg_spot(self,a,b):
        xs=[x['p'] for x in self._series() if a<=x['t']<=b]
        return sum(xs)/len(xs) if xs else None

    def _sigma(self):
        xs=self._series()[-100:]
        if len(xs)<8:return self.fallback_sigma
        rs=[math.log(b['p']/a['p']) for a,b in zip(xs,xs[1:]) if a['p']>0 and b['p']>0]
        if len(rs)<5:return self.fallback_sigma
        mean=sum(rs)/len(rs)
        return math.sqrt(sum((r-mean)**2 for r in rs)/len(rs)) or self.fallback_sigma

    def _momentum(self):
        xs=self._series()[-7:]
        if len(xs)<4:return 0.0
        dt=max(1,xs[-1]['t']-xs[0]['t'])
        x=math.log(xs[-1]['p']/xs[0]['p'])/dt
        return max(-.0002,min(.0002,x))

    def _model(self):
        if not all([self.market,self.spot,self.twap,self.open_ref]):return None
        now=time.time();start=float(self.market['startTs']);end=float(self.market['endTs'])
        remaining=max(0,end-now);elapsed=max(0,now-start)
        final_start=end-60
        known=self._avg_spot(final_start,now)
        known_secs=max(0,min(60,now-final_start))
        future_secs=max(0,min(60,remaining))
        drift=self._momentum()
        current60=self._avg_spot(now-60,now)
        basis=self.twap-current60 if current60 else 0.0
        sig=self._sigma()

        # Early/mid-window uncertainty must remain wide. The old model incorrectly
        # used a <=60s horizon everywhere and saturated at 99% far too early.
        if remaining<=60:
            future_mean=self.spot*math.exp(drift*future_secs*.18)
            projected=((known or self.spot)*known_secs+future_mean*future_secs)/max(1,known_secs+future_secs)+basis
            T=max(1,remaining)
            std=max(.000015,sig*(T**1.5)/(math.sqrt(3)*60))
        else:
            horizon=min(remaining,240)
            projected=self.spot*math.exp(drift*min(horizon,90)*.10)+basis
            std=max(.00008,sig*math.sqrt(max(30,horizon))*1.15)

        margin=(projected-self.open_ref)/self.open_ref
        total=math.sqrt(std*std+.00006**2)
        z=max(-5,min(5,margin/total))
        raw_up=max(.01,min(.99,_cdf(z)))

        # Shrink early-window resolution probability toward 50%; confidence grows
        # naturally as the five-minute market approaches resolution.
        progress=max(0,min(1,elapsed/300))
        reliability=.30+.70*(progress**.72)
        fair_up=max(.02,min(.98,.5+(raw_up-.5)*reliability))

        series=self._series()
        impulse5=0.0
        if len(series)>=2:
            recent=[x for x in series if x['t']>=now-5]
            if len(recent)>=2 and recent[0]['p']>0:
                impulse5=math.log(recent[-1]['p']/recent[0]['p'])*10_000
        lead_bps=(self.spot/self.twap-1)*10_000 if self.twap else 0.0
        lag_score=abs(lead_bps)+.65*abs(impulse5)

        return {'remaining':remaining,'elapsed':elapsed,'projected':projected,'sigma':sig,'margin':margin,'z':z,
                'rawFairUp':raw_up,'fairUp':fair_up,'fairDown':1-fair_up,'basis':basis,'drift':drift,
                'leadBps':lead_bps,'impulse5Bps':impulse5,'lagScore':lag_score,'reliability':reliability}

    def _candidate(self,m):
        candidates=[]
        for side,key in [('UP','up'),('DOWN','down')]:
            ask=self.bbo[key].get('ask')
            if ask is None:continue
            ask=float(ask);fair=m['fairUp'] if side=='UP' else m['fairDown']
            fee=_fee_per_share(ask);raw=fair-ask;net=raw-fee-.005
            candidates.append({'side':side,'ask':ask,'fair':fair,'fee':fee,'raw':raw,'net':net,
                               'size':float(self.bbo[key].get('askSize') or 0)})
        return max(candidates,key=lambda x:x['net']) if candidates else None

    def _reason(self,m,best,confidence):
        now=time.time()
        fresh=max(now-self.spot_ts if self.spot_ts else 1e9,now-self.twap_ts if self.twap_ts else 1e9)<FEED_FRESH_SEC
        min_sh=float(self.market.get('minOrderSize') or 0)
        liquid=best and (best['size']<=0 or best['size']>=max(.01,min_sh))
        price_ok=best and .03<=best['ask']<=.97
        if not self.open_trusted:
            self.latest_mode='WAIT_OPEN';return 'opening reference not trusted'
        if not fresh:
            self.latest_mode='WAIT_FEED';return 'reference feed stale'
        if not best:
            self.latest_mode='WAIT_BOOK';return 'order book unavailable'
        if not liquid:
            self.latest_mode='WAIT_LIQUIDITY';return 'insufficient best-ask liquidity'
        if not price_ok:
            self.latest_mode='WAIT_PRICE';return 'price outside safety band'
        if m['elapsed']<OPEN_STABILIZE_SEC:
            self.latest_mode='OPEN_STABILIZE';return 'opening stabilization period'
        if m['remaining']<4:
            self.latest_mode='CLOSE_LOCK';return 'too close to resolution'

        # Late-stage outcome strategy.
        if m['remaining']<=RESOLUTION_WINDOW_SEC:
            self.latest_mode='RESOLUTION'
            if confidence<72:return 'resolution confidence below 72%'
            if best['fair']<.68:return 'resolution probability below 68%'
            if best['net']<.018:return 'resolution net edge below 1.8c'
            return 'OPPORTUNITY_RESOLUTION'

        # Main strategy: exploit a measurable fast-price/TWAP lead while the
        # Polymarket ask still lags. This is allowed through most of the window.
        if m['remaining']>=LAG_MIN_REMAINING_SEC:
            self.latest_mode='LAG_SCALP'
            direction=1 if best['side']=='UP' else -1
            aligned=(m['leadBps']*direction>.20 and m['impulse5Bps']*direction>-.10)
            if not aligned:return 'lag direction not aligned'
            if m['lagScore']<.45:return 'BTC-to-TWAP lead below 0.45bps'
            if confidence<66:return 'lag confidence below 66%'
            if best['fair']<.60:return 'lag fair probability below 60%'
            if best['net']<.025:return 'lag net edge below 2.5c'
            return 'OPPORTUNITY_LAG'

        self.latest_mode='WAIT_TIME'
        return 'timing gate'

    def _equity(self):
        p=self.paper
        if not p:return 0.0
        e=float(p['cash'])
        pos=p.get('position')
        if pos:
            key='up' if pos['side']=='UP' else 'down'
            bid=self.bbo[key].get('bid')
            e+=pos['shares']*(float(bid) if bid is not None else pos['entryPrice'])
        return e

    def _record(self,action,**kw):
        if not self.paper:return
        ev={'t':time.time(),'action':action,**kw}
        self.paper['events'].insert(0,ev);self.paper['events']=self.paper['events'][:500]
        print('POLY_DEMO_EVENT',action,kw.get('side',''),str(kw.get('detail',''))[:120],flush=True)
        self._save()

    async def _enter(self,best,m,confidence):
        if self.pending or not self.paper or self.paper.get('position'):return
        p=self.paper;market=self.market
        if time.time()>=p['endsAt']:return
        min_sh=float(market.get('minOrderSize') or 0)
        ask0=float(best['ask']);key='up' if best['side']=='UP' else 'down'
        size0=float(self.bbo[key].get('askSize') or 0)
        unit=ask0+_fee_per_share(ask0)
        risk_cash=min(p['cash'],MAX_TRADE_NOTIONAL)
        affordable=math.floor((risk_cash/unit)*100)/100 if unit>0 else 0
        shares=math.floor(min(affordable,size0 if size0>0 else affordable)*100)/100
        if shares<min_sh or shares<=0:
            p['blocked']+=1
            self._record('BLOCK',side=best['side'],price=ask0,detail=f'min {min_sh:.2f} shares; affordable {shares:.2f} with 20 USD account')
            return
        self.pending=True
        tick=max(.001,float(market.get('minTickSize') or .01));max_price=min(.99,ask0+tick)
        self._record('ORDER',side=best['side'],price=ask0,detail=f'paper FAK buy {shares:.2f} shares max {max_price:.3f}')
        await asyncio.sleep(.35)
        try:
            ask=self.bbo[key].get('ask');avail=float(self.bbo[key].get('askSize') or 0)
            if ask is None or float(ask)>max_price or avail<shares:
                p['nofills']+=1;self._record('NOFILL',side=best['side'],price=float(ask) if ask is not None else None,detail='book moved during 350ms latency');return
            ask=float(ask);fee=shares*_fee_per_share(ask);total=shares*ask+fee
            if total>p['cash']+1e-9:
                p['nofills']+=1;self._record('NOFILL',side=best['side'],price=ask,detail='live fill exceeds remaining cash');return
            p['cash']-=total;p['fees']+=fee
            p['position']={'marketSlug':market['slug'],'side':best['side'],'entryPrice':ask,'shares':shares,
                           'entryNotional':shares*ask,'entryFee':fee,'entryTotalCost':total,'entryAt':time.time(),
                           'openRef':self.open_ref,'modelFair':best['fair'],'confidence':confidence,
                           'mode':self.latest_mode,'entryNetEdge':best['net'],'entryLeadBps':m.get('leadBps',0),
                           'entryImpulse5Bps':m.get('impulse5Bps',0)}
            self._record('BUY',side=best['side'],price=ask,detail=f'{self.latest_mode}; filled live ask after 350ms; {shares:.2f} shares; fee USD {fee:.5f}')
        finally:self.pending=False

    async def _try_sell(self,reason):
        if self.pending or not self.paper or not self.paper.get('position'):return False
        p=self.paper;pos=p['position'];key='up' if pos['side']=='UP' else 'down'
        min_sh=float(self.market.get('minOrderSize') or 0) if self.market else 0
        if pos['shares']<min_sh:return False
        bid0=self.bbo[key].get('bid');size0=float(self.bbo[key].get('bidSize') or 0)
        if bid0 is None or size0<pos['shares']:return False
        bid0=float(bid0);tick=max(.001,float(self.market.get('minTickSize') or .01));min_price=max(.01,bid0-tick)
        self.pending=True;self._record('ORDER',side=pos['side'],price=bid0,detail=f'paper FAK sell; {reason}')
        await asyncio.sleep(.35)
        try:
            bid=self.bbo[key].get('bid');avail=float(self.bbo[key].get('bidSize') or 0)
            if bid is None or float(bid)<min_price or avail<pos['shares']:
                p['nofills']+=1;self._record('NOFILL',side=pos['side'],price=float(bid) if bid is not None else None,detail='exit book moved during 350ms latency');return False
            bid=float(bid);fee=pos['shares']*_fee_per_share(bid);proceeds=pos['shares']*bid-fee
            pnl=proceeds-pos['entryTotalCost']
            p['cash']+=proceeds;p['fees']+=fee;p['realizedPnl']+=pnl;p['trades']+=1
            if pnl>=0:p['wins']+=1
            else:p['losses']+=1
            self._record('SELL',side=pos['side'],price=bid,pnl=pnl,detail=reason+f'; fee USD {fee:.5f}')
            p['position']=None
            return True
        finally:self.pending=False

    async def _settle_position(self,slug):
        p=self.paper
        if not p or not p.get('position') or p['position'].get('marketSlug')!=slug:return
        pos=p['position'];final=self.twap
        if final is None or pos.get('openRef') is None:return
        winner='UP' if final>=pos['openRef'] else 'DOWN'
        payout=pos['shares'] if pos['side']==winner else 0.0
        pnl=payout-pos['entryTotalCost']
        p['cash']+=payout;p['realizedPnl']+=pnl;p['trades']+=1
        if pnl>=0:p['wins']+=1
        else:p['losses']+=1
        self._record('SETTLE',side=pos['side'],price=1.0 if pos['side']==winner else 0.0,pnl=pnl,
                     detail=f'TWAP resolution winner {winner}; final {final:.2f}')
        p['position']=None

    def _save(self):
        try:STATE_FILE.write_text(json.dumps(self.snapshot(),separators=(',',':')),encoding='utf-8')
        except Exception:pass

    async def engine_worker(self):
        last_audit=0.0
        while True:
            await asyncio.sleep(.25)
            p=self.paper
            if not p:continue
            now=time.time()
            if now>=p['endsAt'] and not p.get('position'):
                p['status']='complete';self._save();continue
            m=self._model();self.latest_model=m
            if not m:
                self.latest_candidate=None;self.latest_reason='waiting for live spot/TWAP/open reference'
                continue
            best=self._candidate(m);self.latest_candidate=best
            fresh_age=max(now-self.spot_ts if self.spot_ts else 1e9,now-self.twap_ts if self.twap_ts else 1e9)
            data_score=min(18,len(self.spot_sec)/5)
            lead_score=min(18,m.get('lagScore',0)*10)
            time_score=14 if m['remaining']<=RESOLUTION_WINDOW_SEC else 8
            confidence=max(0,min(100,(32 if self.open_trusted else 5)+(18 if fresh_age<FEED_FRESH_SEC else 4)+data_score+lead_score+time_score+min(8,abs(m['z'])*1.5)))
            reason=self._reason(m,best,confidence);self.latest_reason=reason
            if now-last_audit>=1:
                self.reason_counts[reason]+=1;last_audit=now;p['candidatesSeen']+=1
                self.visual_history.append({
                    't':now,'spot':self.spot,'twap':self.twap,'open':self.open_ref,
                    'fairUp':m.get('fairUp'),'upAsk':self.bbo['up'].get('ask'),
                    'equity':self._equity(),'mode':self.latest_mode,'decision':reason
                })
            if reason.startswith('OPPORTUNITY_') and best:
                p['signals']+=1
                if not p.get('position') and not self.pending and now-p.get('lastOpportunityAt',0)>3:
                    p['lastOpportunityAt']=now
                    await self._enter(best,m,confidence)
            pos=p.get('position')
            if pos and self.market and pos.get('marketSlug')==self.market.get('slug') and not self.pending:
                key='up' if pos['side']=='UP' else 'down';bid=self.bbo[key].get('bid')
                if bid is not None:
                    bid=float(bid);fee=pos['shares']*_fee_per_share(bid)
                    net=pos['shares']*bid-fee;pnl=net-pos['entryTotalCost']
                    fair=m['fairUp'] if pos['side']=='UP' else m['fairDown']
                    age=now-float(pos.get('entryAt') or now)
                    direction=1 if pos['side']=='UP' else -1
                    lead_reversed=m.get('leadBps',0)*direction<-.15
                    if pnl>=max(.025,pos['entryTotalCost']*.012):await self._try_sell('take-profit on live bid')
                    elif pos.get('mode')=='LAG_SCALP' and fair-bid<=.012 and pnl>0:await self._try_sell('lag pricing gap converged')
                    elif pos.get('mode')=='LAG_SCALP' and lead_reversed:await self._try_sell('fast-price lead reversed')
                    elif pos.get('mode')=='LAG_SCALP' and age>=22:await self._try_sell('lag scalp time stop')
                    elif fair<pos['entryPrice']-.035:await self._try_sell('model invalidated')
                    elif m['remaining']<=4:await self._try_sell('market near close')
            eq=self._equity();p['peakEquity']=max(p['peakEquity'],eq)
            if p['peakEquity']>0:p['maxDrawdown']=max(p['maxDrawdown'],(p['peakEquity']-eq)/p['peakEquity'])
            self._save()

    def snapshot(self):
        p=self.paper or {}
        eq=self._equity() if self.paper else 0
        return {
            'status':'ok','serverTime':time.time(),'feed':dict(self.feed),'market':self.market,
            'bbo':self.bbo,'spot':self.spot,'spotAgeSec':time.time()-self.spot_ts if self.spot_ts else None,
            'twap':self.twap,'twapAgeSec':time.time()-self.twap_ts if self.twap_ts else None,
            'openRef':self.open_ref,'openTrusted':self.open_trusted,
            'model':self.latest_model,'candidate':self.latest_candidate,'decision':self.latest_reason,'mode':self.latest_mode,
            'history':list(self.visual_history)[-240:],
            'reasonCounts':dict(self.reason_counts),
            'paper':{**p,'equity':eq,'roiPct':((eq/p.get('startingBalance',20))-1)*100 if p else 0,
                     'winRatePct':(p.get('wins',0)/p.get('trades',1)*100 if p.get('trades',0) else 0)}
        }

engine=PolyServerDemo()
