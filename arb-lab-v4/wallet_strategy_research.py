from __future__ import annotations
import asyncio, json, math, random, re, statistics, time
from collections import defaultdict
from datetime import datetime, timezone
from typing import Any
import httpx

DATA="https://data-api.polymarket.com"
GAMMA="https://gamma-api.polymarket.com"
TARGET_WALLET="0x31393e2f8333d4a6e2e31ca6424defe8b6cb9e2e"
FEE_RATE={"CRYPTO":.07,"SPORTS":.05,"FINANCE":.04,"POLITICS":.04,"ECONOMICS":.05,
          "CULTURE":.05,"WEATHER":.05,"OTHER":.05,"GENERAL":.05,"MENTIONS":.04,"TECH":.04,
          "GEOPOLITICS":0.0}

def f(v,d=0.0):
    try:return float(v)
    except:return d
def i(v,d=0):
    try:return int(v)
    except:return d
def side(x):return str(x or "").upper()
def role(x):
    r=str(x.get("trader_side") or x.get("type") or x.get("role") or "").upper()
    return "MAKER" if "MAKER" in r else ("TAKER" if "TAKER" in r else "UNKNOWN")
def med(xs):
    xs=[f(x) for x in xs if x is not None]
    return statistics.median(xs) if xs else None
def mean(xs):
    xs=[f(x) for x in xs if x is not None]
    return sum(xs)/len(xs) if xs else None
def quantile(xs,q):
    xs=sorted(f(x) for x in xs)
    if not xs:return None
    j=(len(xs)-1)*q;a=math.floor(j);b=math.ceil(j)
    return xs[a] if a==b else xs[a]*(b-j)+xs[b]*(j-a)
def pct(x): return None if x is None else round(100*x,4)

class API:
    def __init__(self):
        self.c=httpx.AsyncClient(timeout=35,follow_redirects=True,headers={"User-Agent":"POLY-EDGE-WALLET-RESEARCH/1.0"})
        self.sem=asyncio.Semaphore(5)
    async def close(self):await self.c.aclose()
    async def get(self,url,params=None,retries=8):
        delay=.5
        for n in range(retries):
            try:
                async with self.sem:
                    r=await self.c.get(url,params=params)
                if r.status_code in (429,503):
                    await asyncio.sleep(f(r.headers.get("Retry-After"),delay));delay=min(8,delay*1.7);continue
                r.raise_for_status();return r.json()
            except Exception:
                if n==retries-1:raise
                await asyncio.sleep(delay);delay=min(8,delay*1.7)
    async def paged(self,path,params,limit=1000,progress=None):
        out=[];cursor=None;page=0
        while True:
            q=dict(params);q["limit"]=limit
            if cursor:q["cursor"]=cursor
            body=await self.get(DATA+path,q);page+=1
            rows=body.get("data") if isinstance(body,dict) else body
            rows=rows or [];out.extend(rows)
            if progress is not None:progress.update({"page":page,"rows":len(out)})
            pg=body.get("pagination") or {} if isinstance(body,dict) else {}
            cursor=pg.get("next_cursor")
            if not pg.get("has_more") or not cursor:break
            await asyncio.sleep(.05)
        return out

def parse_json_list(v):
    if isinstance(v,list):return v
    try:
        x=json.loads(v);return x if isinstance(x,list) else []
    except:return []

def market_category(m):
    cat=str(m.get("category") or "").upper()
    if "GEO" in cat or "WORLD" in cat:return "GEOPOLITICS"
    return cat if cat in FEE_RATE else "OTHER"

def fee_rate(m):
    if not m or m.get("feesEnabled") is False:return 0.0
    fs=m.get("feeSchedule") or {}
    for k in ("takerFeeRate","taker_fee_rate","feeRate","rate"):
        if k in fs:
            x=f(fs.get(k))
            if x>1:x/=10000
            return x
    return FEE_RATE.get(market_category(m),.05)

def taker_fee(shares,price,m):
    return round(shares*fee_rate(m)*price*(1-price),5)

def resolved_winner(m):
    if not m or not m.get("closed"):return None
    status=str(m.get("umaResolutionStatus") or m.get("resolutionStatus") or "").lower()
    ps=parse_json_list(m.get("outcomePrices"));outs=parse_json_list(m.get("outcomes"))
    if status and "resolv" not in status:return None
    if len(ps)!=len(outs) or not ps:return None
    vals=[f(x,-1) for x in ps]
    if max(vals)<.999:return None
    idx=max(range(len(vals)),key=vals.__getitem__)
    return {"index":idx,"outcome":str(outs[idx]),"prices":vals}

def asset(title):
    t=(title or "").lower()
    for a,ks in [("BTC",("bitcoin","btc")),("ETH",("ethereum","eth")),("SOL",("solana","sol")),
                 ("XRP",("xrp",)),("DOGE",("doge","dogecoin")),("OIL",("oil","crude","wti","brent"))]:
        if any(k in t for k in ks):return a
    return "OTHER"

def timeframe(title):
    t=(title or "").lower()
    if re.search(r"5\s*(minute|min)",t) or "5m" in t:return "5m"
    if re.search(r"15\s*(minute|min)",t) or "15m" in t:return "15m"
    return "other"

def price_bucket(p):
    return "0-10c" if p<.1 else "10-25c" if p<.25 else "25-40c" if p<.40 else "40-60c" if p<.60 else "60-75c" if p<.75 else "75-90c" if p<.90 else "90-100c"

def dt_epoch(v):
    if v is None:return None
    if isinstance(v,(int,float)):return f(v)
    try:return datetime.fromisoformat(str(v).replace("Z","+00:00")).timestamp()
    except:return None

class WalletResearch:
    def __init__(self,wallet=TARGET_WALLET):
        self.wallet=wallet.lower();self.api=API();self.progress={"stage":"idle"};self.report=None;self.market_cache={}
    async def fetch_market(self,condition):
        if condition in self.market_cache:return self.market_cache[condition]
        body=await self.api.get(GAMMA+"/markets",{"condition_ids":condition,"limit":5})
        m=(body or [None])[0] if isinstance(body,list) else None
        self.market_cache[condition]=m
        return m
    async def enrich_markets(self,conditions):
        self.progress={"stage":"market_metadata","done":0,"total":len(conditions)}
        async def one(c):
            try:await self.fetch_market(c)
            finally:self.progress["done"]+=1
        for off in range(0,len(conditions),50):
            await asyncio.gather(*(one(c) for c in conditions[off:off+50]))
            await asyncio.sleep(.08)

    async def wallet_data(self):
        p={"stage":"wallet_trades","page":0,"rows":0};self.progress=p
        trades=await self.api.paged("/v2/trades",{"user":self.wallet,"taker_only":"false","start":1,"sort_by":"TIMESTAMP","sort_direction":"ASC"},1000,p)
        p={"stage":"closed_positions","page":0,"rows":0};self.progress=p
        closed=await self.api.paged("/v2/positions",{"user":self.wallet,"status":"CLOSED","sort_by":"TIMESTAMP","sort_direction":"ASC"},1000,p)
        self.progress={"stage":"official_stats"}
        stats=await self.api.get(DATA+"/v2/user-stats",{"user":self.wallet})
        pnl=await self.api.get(DATA+"/v2/user-pnl",{"user":self.wallet,"interval":"max","fidelity":"1d"})
        return trades,closed,stats,pnl

    def reconstruct(self,trades,closed):
        by_cond=defaultdict(list)
        for t in trades:by_cond[str(t.get("condition_id") or t.get("conditionId") or "")].append(t)
        official=defaultdict(float)
        for p in closed:official[str(p.get("condition_id") or "")]+=f(p.get("realized_pnl"))
        rows=[]
        for cond,ts in by_cond.items():
            if not cond:continue
            ts=sorted(ts,key=lambda z:i(z.get("timestamp")))
            m=self.market_cache.get(cond) or {};win=resolved_winner(m)
            title=str(next((z.get("title") for z in ts if z.get("title")),m.get("question") or ""))
            end=dt_epoch(m.get("endDate") or m.get("endDateIso") or m.get("closedTime"))
            event=(m.get("events") or [{}])[0] if isinstance(m.get("events"),list) else {}
            event_id=str(event.get("id") or ts[0].get("event_id") or "");event_slug=str(event.get("slug") or ts[0].get("event_slug") or "")
            roles=defaultdict(int);outcomes=defaultdict(lambda:{"buy_sh":0.0,"buy_cost":0.0,"sell_sh":0.0,"sell_cash":0.0,"buys":[],"sells":[]})
            cash=0.0;net=defaultdict(float);fee_cash=0.0;buy_fee_shares=defaultdict(float)
            for z in ts:
                sh=f(z.get("size"));pr=f(z.get("price"));o=str(z.get("outcome") or z.get("outcome_index"));sd=side(z.get("side"));rl=role(z);roles[rl]+=1
                fee=taker_fee(sh,pr,m) if rl=="TAKER" else 0.0
                if sd=="BUY":
                    cash-=sh*pr;net[o]+=sh;outcomes[o]["buy_sh"]+=sh;outcomes[o]["buy_cost"]+=sh*pr;outcomes[o]["buys"].append(z)
                    # historical fee-on-buy variant: compare both later
                    if pr>0:buy_fee_shares[o]+=fee/pr
                elif sd=="SELL":
                    cash+=sh*pr-fee;fee_cash+=fee;net[o]-=sh;outcomes[o]["sell_sh"]+=sh;outcomes[o]["sell_cash"]+=sh*pr-fee;outcomes[o]["sells"].append(z)
            payout_cashfee=0.0;payout_sharefee=0.0
            if win:
                wo=str(win["outcome"])
                payout_cashfee=max(0.0,net.get(wo,0.0))
                payout_sharefee=max(0.0,net.get(wo,0.0)-buy_fee_shares.get(wo,0.0))
            buy_fee_total=sum(taker_fee(f(z.get("size")),f(z.get("price")),m) for z in ts if side(z.get("side"))=="BUY" and role(z)=="TAKER")
            pnl_cashfee=cash-buy_fee_total+payout_cashfee
            pnl_sharefee=cash+payout_sharefee
            off=official.get(cond)
            buy_vwaps={o:(v["buy_cost"]/v["buy_sh"] if v["buy_sh"] else None) for o,v in outcomes.items()}
            pair_cost=sum(v for v in buy_vwaps.values() if v is not None) if len([v for v in buy_vwaps.values() if v is not None])>=2 else None
            first_buy=min((i(z.get("timestamp")) for z in ts if side(z.get("side"))=="BUY"),default=None)
            rows.append({
                "condition":cond,"eventId":event_id,"eventSlug":event_slug,"title":title,"asset":asset(title),"timeframe":timeframe(title),
                "fills":len(ts),"makerFills":roles["MAKER"],"takerFills":roles["TAKER"],"unknownRoleFills":roles["UNKNOWN"],
                "makerShare":roles["MAKER"]/len(ts) if ts else 0,"bothSidesBought":len([1 for v in outcomes.values() if v["buy_sh"]>0])>=2,
                "buyVwaps":buy_vwaps,"pairBuyVwapSum":pair_cost,"firstBuy":first_buy,"secondsToClose":(end-first_buy if end and first_buy else None),
                "winner":win["outcome"] if win else None,"resolved":bool(win),"officialPnl":off,
                "pnlCashFee":pnl_cashfee if win else None,"pnlShareFee":pnl_sharefee if win else None,
                "boughtUsd":sum(v["buy_cost"] for v in outcomes.values()),"soldUsd":sum(v["sell_cash"] for v in outcomes.values()),
                "outcomes":outcomes
            })
        return rows

    def choose_fee_model(self,rows):
        candidates={}
        for k in ("pnlCashFee","pnlShareFee"):
            pairs=[(f(r[k]),f(r["officialPnl"])) for r in rows if r.get(k) is not None and r.get("officialPnl") is not None]
            if not pairs:continue
            abs_err=sum(abs(a-b) for a,b in pairs);den=sum(abs(b) for _,b in pairs) or 1
            candidates[k]={"markets":len(pairs),"absError":abs_err,"relativeAbsError":abs_err/den}
        best=min(candidates,key=lambda k:candidates[k]["relativeAbsError"]) if candidates else "pnlCashFee"
        return best,candidates

    def group_stats(self,rows,pnl_key,key):
        d=defaultdict(list)
        for r in rows:
            if r.get(pnl_key) is not None:d[str(r.get(key) or "UNKNOWN")].append(f(r[pnl_key]))
        return {k:{"markets":len(v),"pnl":sum(v),"avg":mean(v),"median":med(v),"winRate":sum(x>0 for x in v)/len(v)} for k,v in sorted(d.items(),key=lambda q:sum(q[1]),reverse=True)}

    def bootstrap(self,vals,n=2000,seed=1337):
        vals=[f(v) for v in vals];rng=random.Random(seed)
        if not vals:return None
        means=[]
        for _ in range(n):means.append(sum(rng.choice(vals) for __ in vals)/len(vals))
        return {"mean":mean(vals),"lo95":quantile(means,.025),"hi95":quantile(means,.975),"n":len(vals)}

    def wash_lower_bound(self,trades):
        tx=defaultdict(list)
        for t in trades:
            h=str(t.get("transaction_hash") or "")
            if h:tx[h].append(t)
        hits=[]
        for h,xs in tx.items():
            roles={role(x) for x in xs};sides={side(x.get("side")) for x in xs}
            if "MAKER" in roles and "TAKER" in roles and len(sides)>1:
                hits.append({"tx":h,"rows":len(xs),"conditions":len({x.get("condition_id") for x in xs})})
        return {"transactions":len(hits),"examples":hits[:25]}

    def war_bets(self,rows):
        kws=("war","strike","ceasefire","regime","invasion","attack","military")
        out=[]
        for r in rows:
            if r.get("winner","").lower()!="yes":continue
            if not any(k in r["title"].lower() for k in kws):continue
            for o,v in r["outcomes"].items():
                for z in v["buys"]:
                    notion=f(z.get("size"))*f(z.get("price"));pr=f(z.get("price"));t=i(z.get("timestamp"))
                    if notion>=10000 and pr<=.30 and r.get("secondsToClose") is not None and 0<=r["secondsToClose"]<=172800:
                        out.append({"condition":r["condition"],"title":r["title"],"price":pr,"notional":notion,"timestamp":t})
        return out

    async def market_taker_trades(self,condition):
        p={"condition":condition,"taker_only":"true"}
        return await self.api.paged("/v2/trades",p,1000,None)

    async def copy_test(self,rows,delays=(0,1,2,5,10),stake=100.0,max_markets=350):
        eligible=[r for r in rows if r.get("resolved") and r.get("firstBuy") and r.get("winner")]
        eligible=sorted(eligible,key=lambda r:r["firstBuy"])[-max_markets:]
        result={str(d):[] for d in delays}
        self.progress={"stage":"copy_test","done":0,"total":len(eligible)}
        async def one(r):
            alltr=await self.market_taker_trades(r["condition"])
            alltr=sorted(alltr,key=lambda z:i(z.get("timestamp")))
            first_by_outcome={}
            for o,v in r["outcomes"].items():
                buys=sorted(v["buys"],key=lambda z:i(z.get("timestamp")))
                if buys:first_by_outcome[o]=buys[0]
            m=self.market_cache.get(r["condition"]) or {}
            for d in delays:
                pnl=0.0;used=False
                for o,src in first_by_outcome.items():
                    target=i(src.get("timestamp"))+d
                    nxt=next((z for z in alltr if side(z.get("side"))=="BUY" and str(z.get("outcome") or z.get("outcome_index"))==o and i(z.get("timestamp"))>=target),None)
                    if not nxt:continue
                    pr=f(nxt.get("price"))
                    if pr<=0:continue
                    gross_sh=stake/pr;fee=taker_fee(gross_sh,pr,m)
                    # economic copy convention: cost = stake + fee; shares = gross shares.
                    payout=gross_sh if o==r["winner"] else 0.0
                    pnl+=payout-stake-fee;used=True
                if used:result[str(d)].append(pnl)
            self.progress["done"]+=1
        for off in range(0,len(eligible),12):
            await asyncio.gather(*(one(r) for r in eligible[off:off+12]))
            await asyncio.sleep(.08)
        return {d:{"markets":len(v),"pnl":sum(v),"avgPnl":mean(v),"winRate":sum(x>0 for x in v)/len(v) if v else None,"bootstrap":self.bootstrap(v)} for d,v in result.items()}

    async def run(self,copy=True):
        try:
            trades,closed,stats,pnl=await self.wallet_data()
            conditions=sorted({str(t.get("condition_id") or t.get("conditionId") or "") for t in trades if t.get("condition_id") or t.get("conditionId")})
            await self.enrich_markets(conditions)
            self.progress={"stage":"reconstruct"}
            rows=self.reconstruct(trades,closed);fee_model,fee_compare=self.choose_fee_model(rows)
            resolved=[r for r in rows if r.get(fee_model) is not None]
            before=[r for r in resolved if r.get("firstBuy") and r["firstBuy"]<1767225600] # 2026-01-01 UTC
            after=[r for r in resolved if r.get("firstBuy") and r["firstBuy"]>=1767225600]
            event_pnl=defaultdict(float)
            for r in resolved:event_pnl[r["eventSlug"] or r["condition"]]+=f(r[fee_model])
            self.progress={"stage":"copy_test"} if copy else {"stage":"summarize"}
            copy_res=await self.copy_test(rows) if copy else None
            official_points=((pnl or {}).get("data") or {}).get("points") or []
            official_latest=official_points[-1] if official_points else {}
            report={
                "wallet":self.wallet,"generatedAt":time.time(),
                "methodology":{
                    "fills":"Data API v2 /trades, taker_only=false, start=1, cursor pagination",
                    "resolution":"Gamma closed + resolved status + binary 0/1 outcomePrices",
                    "pnl":"cash from fills + resolution payout; fee model reconciled against official closed-position PnL",
                    "multiOutcome":"summed by event slug","split":"before 2026 vs 2026","copy":"$100/new position at next real taker BUY after delay; hold to resolution"
                },
                "coverage":{"fills":len(trades),"conditions":len(conditions),"closedPositions":len(closed),"resolvedReconstructed":len(resolved),"events":len(event_pnl)},
                "official":{"stats":stats,"latestPnlPoint":official_latest},
                "feeReconciliation":{"selected":fee_model,"comparisons":fee_compare},
                "reconstructed":{
                    "pnl":sum(f(r[fee_model]) for r in resolved),"wins":sum(f(r[fee_model])>0 for r in resolved),
                    "losses":sum(f(r[fee_model])<0 for r in resolved),"winRate":sum(f(r[fee_model])>0 for r in resolved)/len(resolved) if resolved else None,
                    "marketBootstrap":self.bootstrap([r[fee_model] for r in resolved]),
                    "eventPnl":sum(event_pnl.values()),"eventBootstrap":self.bootstrap(list(event_pnl.values()))
                },
                "persistence":{
                    "pre2026":{"markets":len(before),"boughtUsd":sum(r["boughtUsd"] for r in before),"pnl":sum(f(r[fee_model]) for r in before),"bootstrap":self.bootstrap([r[fee_model] for r in before])},
                    "2026":{"markets":len(after),"boughtUsd":sum(r["boughtUsd"] for r in after),"pnl":sum(f(r[fee_model]) for r in after),"bootstrap":self.bootstrap([r[fee_model] for r in after])}
                },
                "strategy":{
                    "makerShare":sum(r["makerFills"] for r in rows)/max(1,sum(r["fills"] for r in rows)),
                    "bothSidesBoughtRate":sum(r["bothSidesBought"] for r in rows)/max(1,len(rows)),
                    "pairBuyVwapMedian":med([r["pairBuyVwapSum"] for r in rows if r["pairBuyVwapSum"] is not None]),
                    "secondsToCloseMedian":med([r["secondsToClose"] for r in rows if r["secondsToClose"] is not None]),
                    "byAsset":self.group_stats(resolved,fee_model,"asset"),
                    "byTimeframe":self.group_stats(resolved,fee_model,"timeframe"),
                    "byMakerHeavy":self.group_stats([{**r,"makerBand":"maker>=50%" if r["makerShare"]>=.5 else "maker<50%"} for r in resolved],fee_model,"makerBand")
                },
                "copyTest":copy_res,
                "warBets":self.war_bets(rows),
                "washLowerBound":self.wash_lower_bound(trades),
                "markets":[{k:v for k,v in r.items() if k!="outcomes"} for r in sorted(resolved,key=lambda x:f(x[fee_model]),reverse=True)[:150]],
                "limitations":[
                    "Full 45,283-market / 69,237-sibling universe ranking is a separate universe pass; this report is the target-wallet full-history pass.",
                    "Copy test uses public taker prints, not historical order-book depth; therefore it is a best-case no-impact replication, matching the requested methodology.",
                    "Oil-futures 1-minute attribution is not run until a reliable crude-futures 1-minute source is connected; no oil data is invented."
                ]
            }
            self.report=report;self.progress={"stage":"complete","fills":len(trades),"markets":len(rows)}
            return report
        except Exception as e:
            self.progress={"stage":"error","type":type(e).__name__,"message":str(e)}
            raise
        finally:
            await self.api.close()
