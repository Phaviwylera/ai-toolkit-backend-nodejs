import json, os, secrets, shutil, socket, ipaddress, threading, uuid, webbrowser
from pathlib import Path
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlsplit, parse_qs, quote
from concurrent.futures import ThreadPoolExecutor
import yt_dlp

ROOT = Path(__file__).resolve().parent
DATA = ROOT / 'downloads'; DATA.mkdir(exist_ok=True)
TOKEN = secrets.token_urlsafe(32)
ORIGINS = {'http://127.0.0.1:8765', 'http://localhost:8765', 'https://streamsave-original-video.phavithiranofficial.chatgpt.site'}
JOBS = {}; POOL = ThreadPoolExecutor(max_workers=2)
class Quiet:
    def debug(self, msg): pass
    def warning(self, msg): pass
    def error(self, msg): pass

def validate(url):
    u=urlsplit(url)
    if u.scheme not in ('http','https') or not u.hostname or u.username or u.password:
        raise ValueError('Enter a public HTTP or HTTPS video URL.')
    for addr in socket.getaddrinfo(u.hostname, u.port or (443 if u.scheme=='https' else 80)):
        if not ipaddress.ip_address(addr[4][0]).is_global:
            raise ValueError('Local and private network addresses are not supported.')
    return url

def options():
    return {'quiet':True, 'no_warnings':True, 'logger':Quiet(), 'noplaylist':True, 'socket_timeout':25, 'retries':3, 'allow_unplayable_formats':False, 'enable_file_urls':False, 'js_runtimes':{'deno':{},'node':{}}, 'format_sort':['res','fps','br']}

def platform(url):
    host=(urlsplit(url).hostname or '').lower().rstrip('.')
    for name, domains in [('YouTube',('youtube.com','youtu.be','youtube-nocookie.com')),('Instagram',('instagram.com',)),('X / Twitter',('x.com','twitter.com')),('Facebook',('facebook.com','fb.watch','fb.com'))]:
        if any(host==d or host.endswith('.'+d) for d in domains): return name
    return 'Website'

def inspect(url):
    if platform(url)=='YouTube' and not (shutil.which('node') or shutil.which('deno')):
        raise ValueError('YouTube requires Node.js 22+ or Deno. Install Node.js LTS and restart the companion.')
    with yt_dlp.YoutubeDL(options()) as y:
        info=y.extract_info(url, download=False)
    if info.get('_type') in ('playlist','multi_video') or info.get('entries'):
        raise ValueError('Paste one video URL, rather than a playlist or profile.')
    if info.get('is_live'):
        raise ValueError('Live streams are not supported. Try the recording after it ends.')
    fs=[f for f in info.get('formats',[]) if not f.get('has_drm') and (f.get('vcodec') not in (None,'none') or (f.get('vcodec') is None and f.get('ext') in ('mp4','webm','mkv','mov','flv','avi','m4v')))]
    if not fs: raise ValueError('No unprotected downloadable video stream was found.')
    return info, fs

def run(jobid, url, quality):
    j=JOBS[jobid]; j['status']='Inspecting source'
    try:
        inspect(url)
        started=__import__('time').monotonic()
        if not shutil.which('ffmpeg'): raise ValueError('FFmpeg is required to preserve the best video and audio. Install it and restart the companion.')
        folder=DATA/jobid; folder.mkdir()
        def hook(d):
            if d.get('downloaded_bytes',0)>1024**3 or __import__('time').monotonic()-started>900:
                raise ValueError('This free service supports files up to 1 GB per track and 15 minutes of processing.')
            if d['status']=='downloading':
                total=d.get('total_bytes') or d.get('total_bytes_estimate')
                j.update(status='Downloading', percent=round(d.get('downloaded_bytes',0)/total*100,1) if total else None, speed=d.get('speed'), eta=d.get('eta'))
            elif d['status']=='finished': j.update(status='Merging original streams',percent=None)
        fmt='bv*+ba/b' if quality=='best' else f'bv*[height<={quality}]+ba/b[height<={quality}]'
        opts=options(); opts.update({'format':fmt, 'merge_output_format':'mkv', 'outtmpl':str(folder/'%(title).140B.%(ext)s'), 'progress_hooks':[hook], 'max_filesize':1024**3})
        with yt_dlp.YoutubeDL(opts) as y: y.extract_info(url,download=True)
        files=[p for p in folder.iterdir() if p.suffix not in ('.part','.ytdl','.temp') and p.is_file()]
        if len(files)!=1: raise ValueError('Download did not produce one complete video file.')
        j.update(status='Ready',percent=100,filename=files[0].name,path=str(files[0]),size=files[0].stat().st_size)
    except Exception as e: j.update(status='Failed',error=str(e).replace(TOKEN,'[redacted]')[:1200])

