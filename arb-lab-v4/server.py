"""ARB/LAB One Site: public read-only scanner and non-custodial Solana RPC/Jupiter gateway.

No wallet private keys, passphrases or encrypted vaults are sent to this service.
Live transaction signing, when explicitly enabled, happens ONLY in the unlocked browser tab.
This is experimental, non-atomic and cannot ensure realized profitability.
"""
from __future__ import annotations
import os
import re
import time
import asyncio
from collections import defaultdict, deque
from pathlib import Path
import httpx
from fastapi import FastAPI, Request, HTTPException
from fastapi.responses import FileResponse, JSONResponse, Response
from pydantic import BaseModel, Field

ROOT = Path(__file__).resolve().parent
JUPITER = 'https://api.jup.ag/swap/v2'
RPC = os.environ.get('SOLANA_RPC_URL', 'https://api.mainnet-beta.solana.com')
SOL='So11111111111111111111111111111111111111112'
USDC='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
app=FastAPI(title='ARB/LAB — Unified Solana Terminal',docs_url=None,redoc_url=None)
requests_by_ip=defaultdict(deque)
jupiter_order_lock=asyncio.Lock()
last_jupiter_order=0.0
jupiter_provider_selftest='pending'

@app.middleware('http')
async def guard(request:Request,call_next):
    if request.url.path.startswith('/api/'):
        ip=(request.client.host if request.client else 'unknown')
        now=time.monotonic(); hits=requests_by_ip[ip]
        while hits and hits[0]<now-60: hits.popleft()
        if len(hits)>240: return JSONResponse({'detail':'Rate limit reached. Try later.'},status_code=429)
        hits.append(now)
    return await call_next(request)

@app.head('/')
async def head_home():return Response(status_code=200,headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'})

@app.get('/')
async def home():return FileResponse(ROOT/'index.html', headers={'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff'})

@app.get('/app.js')
async def app_js():return FileResponse(ROOT/'app.js',media_type='text/javascript',headers={'Cache-Control':'no-store'})

@app.get('/style.css')
async def style():return FileResponse(ROOT/'style.css',media_type='text/css')

@app.get('/health')
async def health():return {'status':'online','chain':'solana-mainnet','wallet_private_keys_on_server':False,'jupiter_key_configured':bool(os.environ.get('JUPITER_API_KEY')),'jupiter_provider_selftest':jupiter_provider_selftest,'atomic_arbitrage':False}

async def external_call(method:str,url:str,*,headers=None,json_data=None,params=None):
    try:
        async with httpx.AsyncClient(timeout=20,follow_redirects=False) as client:
            response=await client.request(method,url,headers=headers,json=json_data,params=params)
        try: body=response.json()
        except ValueError: raise HTTPException(502,'External provider gave a non-JSON response')
        if response.status_code>=400:
            msg=(body.get('errorMessage') or body.get('error') or body.get('message') or 'Provider error') if isinstance(body,dict) else 'Provider error'
            raise HTTPException(502,str(msg)[:300])
        return body
    except httpx.RequestError as exc:
        raise HTTPException(503, f'Provider unavailable: {type(exc).__name__}')


def jup_key(request:Request):
    key=os.environ.get('JUPITER_API_KEY') or request.headers.get('x-jupiter-api-key','')
    if not key or len(key)>350 or any(ch.isspace() for ch in key):
        raise HTTPException(400,'Set your free Jupiter API key in the dashboard to access mainnet quotes.')
    return {'x-api-key':key,'Accept':'application/json'}

async def jupiter_order(headers, params):
    global last_jupiter_order
    async with jupiter_order_lock:
        delay = 1.05 - (time.monotonic() - last_jupiter_order)
        if delay > 0:
            await asyncio.sleep(delay)
        try:
            return await external_call('GET',JUPITER+'/order',headers=headers,params=params)
        finally:
            last_jupiter_order=time.monotonic()

@app.on_event('startup')
async def verify_jupiter_provider():
    global jupiter_provider_selftest
    key=os.environ.get('JUPITER_API_KEY')
    if not key:
        jupiter_provider_selftest='missing-key'
        print('JUPITER_SELFTEST_MISSING_KEY', flush=True)
        return
    params={'inputMint':SOL,'outputMint':USDC,'amount':'1000000','taker':'BQ72nSv9f3PRyRKCBnHLVrerrv37CYTHm5h3s9VSGQDV'}
    try:
        result=await jupiter_order({'x-api-key':key,'Accept':'application/json'},params)
        if not isinstance(result,dict) or not result.get('outAmount'):
            raise RuntimeError('unexpected order response')
        jupiter_provider_selftest='ok'
        print('JUPITER_SELFTEST_OK', flush=True)
    except Exception as exc:
        code=getattr(exc,'status_code',type(exc).__name__)
        jupiter_provider_selftest=f'error:{code}'
        print(f'JUPITER_SELFTEST_FAILED {code}', flush=True)

class Order(BaseModel):
    inputMint:str
    outputMint:str
    amount:str
    taker:str|None=None

class HypotheticalScan(BaseModel):
    investmentUsd:float=Field(default=2.0,ge=0.5,le=25.0)

SCAN_TAKER='BQ72nSv9f3PRyRKCBnHLVrerrv37CYTHm5h3s9VSGQDV'
SCAN_FEE_LAMPORTS=180_000
SCAN_MOVE_BUFFER_BPS=35

@app.post('/api/hypothetical')
async def hypothetical(payload:HypotheticalScan,request:Request):
    """Read-only $-sized SOL->USDC->SOL market scan. Never signs or submits a transaction."""
    headers=jup_key(request)
    usd_raw=max(500_000,min(25_000_000,round(payload.investmentUsd*1_000_000)))

    # First quote estimates how much SOL currently corresponds to the requested USD notional.
    seed=await jupiter_order(headers,{
        'inputMint':USDC,'outputMint':SOL,'amount':str(usd_raw),'taker':SCAN_TAKER
    })
    sol_start=int(seed.get('outAmount') or 0)
    if sol_start<=0:
        raise HTTPException(502,'Jupiter did not return a usable SOL reference quote')

    leg1=await jupiter_order(headers,{
        'inputMint':SOL,'outputMint':USDC,'amount':str(sol_start),'taker':SCAN_TAKER
    })
    usdc_mid=int(leg1.get('outAmount') or 0)
    if usdc_mid<=0:
        raise HTTPException(502,'Jupiter did not return a usable SOL to USDC quote')

    leg2=await jupiter_order(headers,{
        'inputMint':USDC,'outputMint':SOL,'amount':str(usdc_mid),'taker':SCAN_TAKER
    })
    sol_return=int(leg2.get('outAmount') or 0)
    if sol_return<=0:
        raise HTTPException(502,'Jupiter did not return a usable USDC to SOL quote')

    investment=float(usd_raw)/1_000_000
    sol_start_ui=sol_start/1_000_000_000
    sol_return_ui=sol_return/1_000_000_000
    sol_price=(investment/sol_start_ui) if sol_start_ui>0 else 0.0
    raw_profit_sol=sol_return_ui-sol_start_ui
    raw_profit_usd=raw_profit_sol*sol_price
    raw_edge_bps=(raw_profit_usd/investment*10_000) if investment else 0.0
    fee_allowance_usd=(SCAN_FEE_LAMPORTS/1_000_000_000)*sol_price
    move_buffer_usd=investment*(SCAN_MOVE_BUFFER_BPS/10_000)
    conservative_profit_usd=raw_profit_usd-fee_allowance_usd-move_buffer_usd
    conservative_edge_bps=(conservative_profit_usd/investment*10_000) if investment else 0.0

    # Heuristic confidence: quote margin relative to conservative cost assumptions.
    # It is deliberately bounded and is NOT a calibrated probability of profit.
    confidence=max(5.0,min(95.0,50.0+conservative_edge_bps*0.45))
    verdict='EXECUTE-CANDIDATE' if conservative_profit_usd>0.005 else ('WATCH' if raw_profit_usd>0 else 'REJECT')

    return {
        'status':'ok',
        'timestamp':time.time(),
        'investmentUsd':round(investment,6),
        'solPriceUsd':round(sol_price,6),
        'startSol':sol_start,
        'startSolUi':round(sol_start_ui,9),
        'midUsdc':usdc_mid,
        'midUsdcUi':round(usdc_mid/1_000_000,6),
        'returnSol':sol_return,
        'returnSolUi':round(sol_return_ui,9),
        'rawProfitUsd':round(raw_profit_usd,8),
        'rawEdgeBps':round(raw_edge_bps,3),
        'feeAllowanceUsd':round(fee_allowance_usd,8),
        'moveBufferUsd':round(move_buffer_usd,8),
        'conservativeProfitUsd':round(conservative_profit_usd,8),
        'conservativeEdgeBps':round(conservative_edge_bps,3),
        'projectedReturnUsd':round(investment+conservative_profit_usd,8),
        'confidence':round(confidence,1),
        'confidenceType':'heuristic-not-statistical',
        'verdict':verdict,
        'route':'SOL → USDC → SOL',
        'router':'Jupiter Swap V2'
    }

@app.post('/api/order')
async def order(input:Order, request:Request):
    if {input.inputMint,input.outputMint}!={SOL,USDC} or input.inputMint==input.outputMint:
        raise HTTPException(400,'Only SOL / USDC swap quotes are permitted')
    if not re.fullmatch(r'[0-9]{1,14}',input.amount) or not 1000<=int(input.amount)<=1_000_000_000:
        raise HTTPException(400,'Swap amount outside supported bounds')
    if input.taker and not re.fullmatch(r'[1-9A-HJ-NP-Za-km-z]{32,44}',input.taker):
        raise HTTPException(400,'Invalid Solana public wallet address')
    params={'inputMint':input.inputMint,'outputMint':input.outputMint,'amount':input.amount}
    if input.taker: params['taker']=input.taker
    return await jupiter_order(jup_key(request),params)

class Execute(BaseModel):
    signedTransaction:str=Field(min_length=80,max_length=16000)
    requestId:str=Field(min_length=1,max_length=256)

@app.post('/api/execute')
async def execute(payload:Execute,request:Request):
    # Signed transactions have already been authorized by a key that NEVER leaves the browser.
    if not re.fullmatch(r'[A-Za-z0-9+/=]+',payload.signedTransaction):
        raise HTTPException(400,'Invalid base64 signed transaction')
    return await external_call('POST',JUPITER+'/execute',headers={**jup_key(request),'Content-Type':'application/json'},json_data=payload.model_dump())

class Rpc(BaseModel):
    method:str
    params:list

ALLOWED={'getBalance','getTokenAccountsByOwner','getLatestBlockhash','getSignatureStatuses','getAccountInfo','sendTransaction'}
@app.post('/api/rpc')
async def rpc(body:Rpc):
    if body.method not in ALLOWED:raise HTTPException(400,'RPC method not permitted')
    if len(str(body.params))>18000:raise HTTPException(400,'RPC parameters too large')
    data=await external_call('POST',RPC,json_data={'jsonrpc':'2.0','id':1,'method':body.method,'params':body.params})
    if isinstance(data,dict) and 'error' in data:
        raise HTTPException(502,str(data['error'])[:250])
    return data.get('result')