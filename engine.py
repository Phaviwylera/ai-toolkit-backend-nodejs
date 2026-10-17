"""Original-stream extraction and download service. No video transcoding."""
import copy, ipaddress, logging, shutil, socket, threading, time
from pathlib import Path
from urllib.parse import urlsplit
import yt_dlp

ROOT=Path(__file__).resolve().parent
DATA=Path('/tmp/streamsave-files');DATA.mkdir(exist_ok=True)
JOBS={};CACHE={};CACHE_LOCK=threading.Lock();LOG=logging.getLogger('streamsave.extractor')
class ExtractorLog:
    def debug(self,msg):
        if not msg.startswith('[debug]'):LOG.info('%s',msg)
    def warning(self,msg):LOG.warning('%s',msg)
    def error(self,msg):LOG.error('%s',msg)

class VideoError(ValueError):
    def __init__(self,message,code='source_unavailable',retryable=False):
        super().__init__(message);self.code=code;self.retryable=retryable

def describe_error(error,site):
    if isinstance(error,VideoError):return error
    s=str(error).lower()
    if any(t in s for t in ['sign in to confirm','not a bot']):
        return VideoError(f'{site} is asking this hosting server to verify its requests. This video cannot be downloaded from this server right now.','server_verification')
    if any(t in s for t in ['private video','members-only','not available in your country','age-restricted','login required','log in to','cookies are needed']):
        return VideoError(f'{site} requires login, verification, or access permission for this video. This online server cannot retrieve it.','access_restricted')
    if any(t in s for t in ['failed to extract any player response','http error 429','http error 403','http error 402','http error 404','unable to download api','unable to download webpage']):
        return VideoError(f'{site} is refusing requests from this hosting server. Try again later, or try another public video.','platform_blocked',True)
    if 'unsupported url' in s:return VideoError('This link is not supported. Paste the video’s direct post or watch link.','unsupported_url')
    if any(t in s for t in ['not available','removed','deleted','unavailable']):return VideoError('This video is unavailable or has been removed.','video_unavailable')
    if any(t in s for t in ['timed out','timeout','connection','resolve','temporary failure']):return VideoError('The source did not respond in time. Please try again.','network_error',True)
    return VideoError('The source could not provide a downloadable video. Try its direct public video link.','source_unavailable',True)

def validate(url):
    u=urlsplit(url)
    if u.scheme not in ('http','https') or not u.hostname or u.username or u.password:raise VideoError('Paste a public HTTP or HTTPS video link.','invalid_url')
    if u.port and u.port not in (80,443):raise VideoError('Only standard web links are supported.','invalid_url')
    for addr in socket.getaddrinfo(u.hostname,u.port or (443 if u.scheme=='https' else 80)):
        if not ipaddress.ip_address(addr[4][0]).is_global:raise VideoError('Local and private network links are not supported.','invalid_url')
    return url

def platform(url):
    host=(urlsplit(url).hostname or '').lower().rstrip('.')
    for name,domains in [('YouTube',('youtube.com','youtu.be','youtube-nocookie.com')),('Instagram',('instagram.com',)),('X / Twitter',('x.com','twitter.com')),('Facebook',('facebook.com','fb.watch','fb.com'))]:
        if any(host==d or host.endswith('.'+d) for d in domains):return name
    return 'Website'

def options():
    return {'quiet':True,'logger':ExtractorLog(),'noplaylist':True,'socket_timeout':12,'retries':1,'extractor_retries':0,'allow_unplayable_formats':False,'enable_file_urls':False,'js_runtimes':{'node':{},'deno':{}},'format_sort':['res','fps','br'],'format_sort_force':True}

def video_formats(info):
    if info.get('_type') in ('playlist','multi_video') or info.get('entries'):raise VideoError('Paste one video link instead of a playlist, profile, or carousel.','multiple_videos')
    if info.get('is_live'):raise VideoError('Live streams are not supported. Try the recording after it ends.','live_video')
    fs=[f for f in info.get('formats',[]) if not f.get('has_drm') and (f.get('vcodec') not in (None,'none') or (f.get('vcodec') is None and f.get('ext') in ('mp4','webm','mkv','mov','flv','avi','m4v')))]
    if not fs:raise VideoError('No unprotected video stream was available from this link.','no_video_streams')
    return fs

def inspect(url):
    with CACHE_LOCK:
        cached=CACHE.get(url)
        if cached and time.time()-cached[0]<180:return copy.deepcopy(cached[1]),video_formats(cached[1])
    site=platform(url)
    if site=='YouTube' and not (shutil.which('node') or shutil.which('deno')):raise VideoError('The YouTube engine is temporarily unavailable. Please try again later.','engine_unavailable')
    attempts=[{}]
    if site=='YouTube':attempts.append({'extractor_args':{'youtube':{'player_client':['web_safari','android_vr'],'player_skip':['webpage','configs']}}})
    failure=None
    for i,extra in enumerate(attempts):
        try:
            LOG.info('Extracting %s using strategy %s',site,i+1)
            with yt_dlp.YoutubeDL({**options(),**extra}) as y:info=y.extract_info(url,download=False)
            fs=video_formats(info)
            with CACHE_LOCK:
                for k,(created,_) in list(CACHE.items()):
                    if time.time()-created>180:CACHE.pop(k,None)
                if len(CACHE)<64:CACHE[url]=(time.time(),copy.deepcopy(info))
            return info,fs
        except Exception as e:
            failure=describe_error(e,site);LOG.warning('Extraction strategy %s: %s',i+1,str(e)[:900])
            if failure.code in ('access_restricted','video_unavailable','multiple_videos','live_video'):break
    raise failure

def run(jobid,url,quality):
    j=JOBS[jobid];j['status']='Inspecting source'
    try:
        info,fs=inspect(url);j['title']=info.get('title','Video');started=time.monotonic()
        if not shutil.which('ffmpeg'):raise VideoError('The video merger is temporarily unavailable. Try again later.','engine_unavailable')
        folder=DATA/jobid;folder.mkdir(exist_ok=True)
        def hook(d):
            if d.get('downloaded_bytes',0)>1024**3 or time.monotonic()-started>900:raise VideoError('This free service supports files up to 1 GB per track and 15 minutes of processing.','size_limit')
            if d['status']=='downloading':
                total=d.get('total_bytes') or d.get('total_bytes_estimate')
                j.update(status='Downloading',percent=round(min(100,d.get('downloaded_bytes',0)/total*100),1) if total else None,speed=d.get('speed'),eta=d.get('eta'))
            elif d['status']=='finished':j.update(status='Merging original streams',percent=None)
        fmt='bv*+ba/b' if quality=='best' else f'bv*[height<={quality}]+ba/b[height<={quality}]'
        opts={**options(),'format':fmt,'merge_output_format':'mkv','outtmpl':str(folder/'%(title).140B.%(ext)s'),'progress_hooks':[hook],'max_filesize':1024**3}
        with yt_dlp.YoutubeDL(opts) as y:result=y.process_ie_result(info,download=True)
        files=[p for p in folder.iterdir() if p.suffix not in ('.part','.ytdl','.temp') and p.is_file()]
        if len(files)!=1:raise VideoError('The video did not finish downloading. Please retry.','incomplete_download',True)
        j.update(status='Ready',percent=100,filename=files[0].name,path=str(files[0]),size=files[0].stat().st_size,height=result.get('height'),format=result.get('ext'))
    except Exception as e:
        error=describe_error(e,platform(url));LOG.exception('Download failed')
        j.update(status='Failed',error=str(error),errorCode=error.code,retryable=error.retryable)
