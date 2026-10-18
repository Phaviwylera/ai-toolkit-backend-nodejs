from __future__ import annotations
import asyncio
from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware
from wallet_strategy_research import WalletResearch, TARGET_WALLET

app=FastAPI(title="POLY Wallet Research",docs_url=None,redoc_url=None)
app.add_middleware(CORSMiddleware,allow_origins=["https://arb-lab-v4-unified.onrender.com"],allow_methods=["GET","POST","OPTIONS"],allow_headers=["*"])
STATE={"runner":None,"task":None,"wallet":TARGET_WALLET}

async def launch(wallet=TARGET_WALLET,copy=True):
    if STATE.get("task") and not STATE["task"].done():return
    r=WalletResearch(wallet);STATE["runner"]=r;STATE["wallet"]=wallet
    async def go():
        try:await r.run(copy=copy)
        except Exception:pass
    STATE["task"]=asyncio.create_task(go())

@app.on_event("startup")
async def startup():
    await launch(TARGET_WALLET,True)

@app.get("/health")
async def health():
    r=STATE.get("runner")
    return {"status":"online","wallet":STATE["wallet"],"progress":r.progress if r else {"stage":"idle"}}

@app.get("/api/research/progress")
async def progress():
    r=STATE.get("runner")
    return {"wallet":STATE["wallet"],"progress":r.progress if r else {"stage":"idle"}}

@app.get("/api/research/report")
async def report():
    r=STATE.get("runner")
    return {"wallet":STATE["wallet"],"progress":r.progress if r else {"stage":"idle"},"report":r.report if r else None}

@app.post("/api/research/run")
async def run(wallet:str=Query(default=TARGET_WALLET),copy:bool=Query(default=True)):
    await launch(wallet.lower(),copy)
    return {"started":True,"wallet":wallet.lower(),"copy":copy}
