import os, time, secrets, socket, ipaddress, shutil, threading, uuid, json
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
from fastapi import FastAPI, Request, HTTPException
from fastapi.responses import HTMLResponse, FileResponse, JSONResponse
from starlette.concurrency import run_in_threadpool
import engine

ROOT=Path(__file__).resolve().parent
engine.DATA=Path('/tmp/streamsave-files');engine.DATA.mkdir(exist_ok=True)
JOBS=engine.JOBS;POOL=ThreadPoolExecutor(max_workers=2);LOCK=threading.Lock();INSPECT=threading.BoundedSemaphore(2)
SESSIONS={};RATE={};TTL=1800;MAX=1024**3
raw_dns=socket.getaddrinfo

def public_dns(host,*args,**kwargs):
    rows=raw_dns(host,*args,**kwargs)
    if any(not ipaddress.ip_address(r[4][0]).is_global for r in rows):raise OSError('Private network destinations are blocked')
    return rows
socket.getaddrinfo=public_dns
base_options=engine.options

def cloud_options():
    return {**base_options(),'socket_timeout':15,'retries':1,'cachedir':False,'hls_prefer_native':True,'external_downloader':{'default':'native'},'proxy':'','max_filesize':MAX,'extractor_retries':0}
engine.options=cloud_options
app=FastAPI(docs_url=None,redoc_url=None)

def cleanup():
    now=time.time()
    with LOCK:
        for key,j in list(JOBS.items()):
            if j['status'] in ('Ready','Failed') and now-j.get('finished',now)>TTL:
                shutil.rmtree(engine.DATA/key,ignore_errors=True);JOBS.pop(key,None)
        for key,expiry in list(SESSIONS.items()):
            if expiry<now:SESSIONS.pop(key,None);RATE.pop(key,None)

def rate(sid):
    now=time.time(); hits=[t for t in RATE.get(sid,[]) if now-t<60]
    if len(hits)>=8:raise HTTPException(429,'Please wait a minute before starting more requests.')
    RATE[sid]=hits+[now]

@app.middleware('http')
async def session(request,call_next):
    cleanup();sid=request.cookies.get('streamsave_session');new=sid not in SESSIONS
    if new:
        if len(SESSIONS)>2000:return JSONResponse({'error':'Server busy. Please try again later.'},503)
        sid=secrets.token_urlsafe(32)
    SESSIONS[sid]=time.time()+7200;request.state.sid=sid
    if request.method=='POST':
        origin=request.headers.get('origin')
        if origin and origin.split('://',1)[-1]!=request.headers.get('host'):return JSONResponse({'error':'Cross-site requests are blocked.'},403)
        if int(request.headers.get('content-length','0'))>16384:return JSONResponse({'error':'Request too large'},413)
    response=await call_next(request)
    if new:response.set_cookie('streamsave_session',sid,httponly=True,samesite='strict',secure=bool(os.getenv('RENDER')),max_age=7200)
    response.headers['Cache-Control']='no-store';response.headers['X-Content-Type-Options']='nosniff';response.headers['Referrer-Policy']='no-referrer'
    return response

@app.exception_handler(HTTPException)
async def error(request,e):return JSONResponse({'error':str(e.detail)},e.status_code)

@app.get('/')
def index():return HTMLResponse((ROOT/'index.html').read_text())
@app.get('/api/health')
def health():return {'ready':True,'ffmpeg':bool(shutil.which('ffmpeg')),'version':engine.yt_dlp.version.__version__,'mode':'cloud'}

async def body(request):
    raw=await request.body()
    if len(raw)>16384:raise HTTPException(413,'Request too large')
    try:
        data=json.loads(raw);url=engine.validate(data.get('url',''))
    except Exception as e:raise HTTPException(400,str(e))
    rate(request.state.sid)
    return data,url

@app.post('/api/inspect')
async def inspect(request:Request):
    data,url=await body(request)
    if not INSPECT.acquire(blocking=False):raise HTTPException(429,'The server is checking other videos. Please try again shortly.')
    try:
        info,fs=await run_in_threadpool(engine.inspect,url)
        return {'title':info.get('title','Video'),'source':engine.platform(url),'duration':info.get('duration'),'thumbnail':info.get('thumbnail'),'maxHeight':max((f.get('height') or 0 for f in fs),default=0),'heights':sorted({int(f['height']) for f in fs if f.get('height')},reverse=True)}
    except Exception as e:
        error=engine.describe_error(e,engine.platform(url))
        return JSONResponse({'error':str(error),'code':error.code,'retryable':error.retryable},422)
    finally:INSPECT.release()

def download(jobid,url,quality):
    j=JOBS[jobid]
    try:
        engine.run(jobid,url,quality)
    finally:
        j['finished']=time.time()
        if j['status']=='Failed':shutil.rmtree(engine.DATA/jobid,ignore_errors=True)

@app.post('/api/download')
async def start(request:Request):
    data,url=await body(request);quality=str(data.get('quality','best'))
    if quality!='best' and (not quality.isdigit() or not 1<=int(quality)<=16384):raise HTTPException(400,'Invalid resolution')
    with LOCK:
        if sum(j['status'] not in ('Ready','Failed') for j in JOBS.values())>=3:raise HTTPException(429,'The download queue is full. Please try again shortly.')
        if sum(j['owner']==request.state.sid and j['status'] not in ('Ready','Failed') for j in JOBS.values())>=2:raise HTTPException(429,'Wait for your current downloads to finish.')
        if shutil.disk_usage(engine.DATA).free<3*MAX:raise HTTPException(503,'Temporary storage is full. Please try again later.')
        jobid=uuid.uuid4().hex;JOBS[jobid]={'id':jobid,'owner':request.state.sid,'status':'Queued','percent':None,'created':time.time()}
    POOL.submit(download,jobid,url,quality);return {'id':jobid}

def job(request,jobid):
    j=JOBS.get(jobid)
    if not j or j['owner']!=request.state.sid:raise HTTPException(404,'Download expired or not found. Start it again.')
    return j
@app.get('/api/jobs/{jobid}')
def progress(request:Request,jobid:str):return {k:v for k,v in job(request,jobid).items() if k not in ('path','owner')}
@app.get('/api/files/{jobid}')
def file(request:Request,jobid:str):
    j=job(request,jobid)
    if j['status']!='Ready':raise HTTPException(409,'The video is not ready yet.')
    return FileResponse(j['path'],filename=j['filename'],media_type='application/octet-stream')
