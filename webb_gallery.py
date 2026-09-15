"""NASA Webb's public Flickr collections, with explicit sky-location provenance."""
import asyncio
import html
import json
import math
import re
import shutil
import sqlite3
import subprocess
import uuid
from pathlib import Path
from urllib.parse import urlparse

import httpx

import integrations as remote

PATH = Path(__file__).parent/'data'/'webb-gallery.sqlite3'
BASE = 'https://www.flickr.com/photos/nasawebbtelescope/'
SOURCES = [
    {'id':'72177720331299130','name':'2026 Webb Images/Science','url':BASE+'albums/72177720331299130/'},
    {'id':'72177720323168468','name':'2025 Webb Images/Science','url':BASE+'albums/72177720323168468/'},
    {'id':'72177720332131144','name':'Galaxies + Webb','url':BASE+'albums/72177720332131144/'},
    {'id':'photostream','name':'NASA Webb · full photostream','url':BASE},
]
_task = None

def connect():
    c=sqlite3.connect(PATH,timeout=30);c.row_factory=sqlite3.Row
    c.execute('PRAGMA journal_mode=WAL')
    c.executescript('''
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS photos (
        id TEXT PRIMARY KEY,title TEXT,posted REAL,kind TEXT,ra REAL,dec REAL,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS membership (source TEXT,photo TEXT,generation TEXT,PRIMARY KEY(source,photo));
      CREATE INDEX IF NOT EXISTS photo_date ON photos(posted DESC);
      CREATE TABLE IF NOT EXISTS locations (name TEXT PRIMARY KEY,payload TEXT NOT NULL);
    ''')
    return c

def get_setting(c,key,default=None):
    r=c.execute('SELECT value FROM settings WHERE key=?',(key,)).fetchone()
    return json.loads(r[0]) if r else default

def put(c,key,value): c.execute('INSERT OR REPLACE INTO settings VALUES (?,?)',(key,json.dumps(value)))

def save_job(job):
    with connect() as c:put(c,'job',job)

def status():
    with connect() as c:
        job=get_setting(c,'job',{})
        sources=[{**s,**get_setting(c,s['id'],{}),'indexed':c.execute('SELECT COUNT(*) FROM membership WHERE source=?',(s['id'],)).fetchone()[0]} for s in SOURCES]
        total,mapped=c.execute('SELECT COUNT(*),COUNT(ra) FROM photos').fetchone()
    if job.get('state')=='running' and (_task is None or _task.done()):job={**job,'state':'interrupted','error':'Gallery update interrupted. Update images will retry.'}
    return {'sources':sources,'total':total,'mapped':mapped,'unmapped':total-mapped,'job':job}

def curl_page(url):
    # curl uses Windows' HTTP/TLS stack; Flickr rejects this machine's httpx TLS
    # handshake. Fetch only public NASA Webb listing pages, never account cookies.
    parsed=urlparse(url)
    if parsed.scheme!='https' or parsed.hostname!='www.flickr.com' or not parsed.path.startswith('/photos/nasawebbtelescope/'):
        raise ValueError('Only NASA Webb public Flickr pages are accepted.')
    exe=shutil.which('curl.exe') or shutil.which('curl')
    if not exe:raise ValueError('Windows curl is required to refresh the Flickr gallery.')
    p=subprocess.run([exe,'--silent','--show-error','--fail','--location','--proto','=https','--proto-redir','=https','--max-time','70','--max-filesize','15000000','--user-agent','Mozilla/5.0',url],capture_output=True,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0),timeout=80)
    if p.returncode:raise ValueError(f'Flickr page could not be fetched (curl {p.returncode}). Retry the update.')
    return p.stdout.decode('utf-8')

def unwrap(v):
    if isinstance(v,dict) and 'exportMetaType' in v:return unwrap(v.get('data'))
    if isinstance(v,dict):return {k:unwrap(x) for k,x in v.items()}
    if isinstance(v,list):return [unwrap(x) for x in v]
    return v

def parse_listing(text):
    match=re.search(r'modelExport:\s*(\{)',text)
    if not match:raise ValueError('Flickr page format changed; no complete photo list was found.')
    export=json.JSONDecoder().raw_decode(text[match.start(1):])[0]
    data=unwrap(export['main'])
    lists=[]
    def walk(v):
        if isinstance(v,dict):
            if '_data' in v and 'totalItems' in v:lists.append(v)
            for x in v.values():walk(x)
        elif isinstance(v,list):
            for x in v:walk(x)
    walk(data)
    if not lists:raise ValueError('Flickr did not report the collection total.')
    listing=max(lists,key=lambda v:len(v.get('_data',[])))
    photos=[v for v in listing['_data'] if isinstance(v,dict) and v.get('_flickrModelRegistry')=='photo-models']
    # Server HTML normally includes only 25 items in a 100-photo page. A public
    # /with/<photo>/ link renders the whole containing page. Verify totals below.
    return photos,int(listing['totalItems'])

async def fetch_listing(url):
    last=None
    for attempt in range(3):
        try:return parse_listing(await asyncio.to_thread(curl_page,url))
        except (ValueError,subprocess.TimeoutExpired) as e:
            last=e
            if attempt<2:await asyncio.sleep(2*(attempt+1))
    raise ValueError(str(last))

def clean_text(value):
    return html.unescape(re.sub(r'<[^>]+>','',value or '')).strip()

def image_kind(title,description):
    t=title.lower()
    if re.search(r"artist.{0,4}(concept|impression|illustration)|illustration|simulat|concept",t):return 'Illustration / simulation'
    if re.search(r'spectrum|spectra|light curve|lightcurve|infographic|diagram|graph|chart',t):return 'Chart / spectrum'
    if re.search(r'video|animation|sonification|fly.through|timelapse|time.lapse',t):return 'Video / animation'
    if re.search(r'\b(webb|jwst|telescope)\b',t) and re.search(r'clean.?room|mirror|sunshield|test|launch|technician|engineer|assembly|goddard|chamber|integration|unbox|shipment',t):return 'Mission photograph'
    return 'Published image'

def normalize(photo):
    pid=str(photo['id'])
    if not pid.isdigit():raise ValueError('Invalid Flickr photo ID')
    title=clean_text(photo.get('title'))
    description=clean_text(photo.get('description'))
    sizes={}
    for key,v in (photo.get('sizes') or {}).items():
        if not isinstance(v,dict):continue
        url=v.get('url') or v.get('src') or v.get('displayUrl') or ''
        if url.startswith('//'):url='https:'+url
        if urlparse(url).hostname=='live.staticflickr.com' and urlparse(url).scheme=='https':sizes[key]={**v,'url':url}
    choice=next((sizes[k] for k in ('k','h','l','c','m') if k in sizes),None)
    thumb=next((sizes[k] for k in ('c','z','m') if k in sizes),choice)
    links=re.findall(r'href=["\x27]([^"\x27]+)',photo.get('description') or '')
    stats=photo.get('stats') if isinstance(photo.get('stats'),dict) else {}
    return {'id':pid,'title':title,'description':description,'kind':image_kind(title,description),
            'source_url':BASE+pid+'/','image_url':choice['url'] if choice else None,'thumbnail_url':thumb['url'] if thumb else None,
            'original_url':(sizes.get('o') or choice or {}).get('url'), 'sizes':sizes,
            'posted':remote.number(stats.get('datePosted')),'date_taken':stats.get('dateTaken'),
            'license':photo.get('license'),'source_links':[html.unescape(u) for u in links if urlparse(html.unescape(u)).scheme=='https'],
            'ra':None,'dec':None,'location':None,'fetched_at':remote.now()}

def save_photos(source,generation,photos):
    with connect() as c:
        for photo in photos:
            p=normalize(photo)
            old=c.execute('SELECT payload FROM photos WHERE id=?',(p['id'],)).fetchone()
            if old:
                old=json.loads(old[0])
                for k in ('ra','dec','location'):p[k]=old.get(k)
            c.execute('INSERT OR REPLACE INTO photos VALUES (?,?,?,?,?,?,?)',(p['id'],p['title'],p['posted'],p['kind'],p['ra'],p['dec'],json.dumps(p)))
            c.execute('INSERT OR REPLACE INTO membership VALUES (?,?,?)',(source,p['id'],generation))

CATALOG_PATTERN=re.compile(r'\b(?:NGC\s*\d+[A-Z]?|IC\s*\d+[A-Z]?|UGC\s*\d+|Arp\s*\d+|Messier\s*\d+|M\s?\d{1,3}\b|HH\s*\d+|Westerlund\s*[12]|Abell\s*\d+|TRAPPIST-1|TOI-\d+(?:\s?[b-h])?|NGC\s*\d+|MACS\s*J\d+[.\d]*[+-]\d+|VV\s*\d+|LDN\s*\d+|Barnard\s*\d+)\b',re.I)
ALIASES={'pillars of creation':'M16','cosmic cliffs':'NGC 3324','stephan’s quintet':'HCG 92',"stephan's quintet":'HCG 92','cartwheel galaxy':'ESO 350-40','centaurus a':'NGC 5128','sombrero galaxy':'M104','orion nebula':'M42','ring nebula':'M57','crab nebula':'M1','tarantula nebula':'NGC 2070','southern ring':'NGC 3132','horsehead nebula':'Barnard 33','cassiopeia a':'Cas A','phantom galaxy':'M74','rho ophiuchi':'rho Oph','beta pictoris':'beta Pic','serpens nebula':'Serpens Cloud'}

def target_name(p):
    if p['kind']=='Mission photograph':return None
    # Resolve explicitly named subjects, not a guess from color or appearance.
    title=p['title']
    direct=CATALOG_PATTERN.search(title)
    if direct:return direct.group(0)
    for alias,name in sorted(ALIASES.items(),key=lambda item:-len(item[0])):
        if alias in title.lower():return name
    # A target must occur in the introduction, before credits/comparisons.
    intro=p['description'][:450]
    direct=CATALOG_PATTERN.search(intro)
    if direct:return direct.group(0)
    return None

async def locate_photo(p):
    name=target_name(p)
    if not name:return None
    with connect() as c:r=c.execute('SELECT payload FROM locations WHERE name=?',(name.lower(),)).fetchone()
    if r:
        result=json.loads(r[0])
        if result:return result
        return None
    try:
        result=await remote.resolve(name)
        ra,dec=remote.number(result.get('ra')),remote.number(result.get('dec'))
        if ra is None or dec is None or not 0<=ra<360 or not -90<=dec<=90:return None
        location={'name':name,'ra':ra,'dec':dec,'method':'Named target resolved by MAST/Sesame',
                  'source_url':p['source_url'],'resolved_at':remote.now(),
                  'note':'Catalog target position. This is a visit marker, not a measured image footprint or pixel alignment.'}
        with connect() as c:c.execute('INSERT OR REPLACE INTO locations VALUES (?,?)',(name.lower(),json.dumps(location)))
        return location
    except ValueError:
        # Do not persist a network failure as "no coordinates"; the next update retries.
        return None

async def synchronize(job):
    try:
        for source in SOURCES:
            job.update(message='Reading '+source['name'],source=source['id'],page=1);save_job(job)
            seed,total=await fetch_listing(source['url'])
            seen=set();pages=max(1,math.ceil(total/100));reported_totals={total}
            for page in range(1,pages+1):
                if page>1:seed,current_total=await fetch_listing(source['url']+f'page{page}/')
                else:current_total=total
                reported_totals.add(current_total)
                if not seed and total:raise ValueError(f'Flickr page {page} returned no photos.')
                full,check_total=await fetch_listing(source['url']+'with/'+str(seed[0]['id'])+'/') if seed else ([],total)
                reported_totals.add(check_total)
                await asyncio.to_thread(save_photos,source['id'],job['generation'],full)
                seen.update(str(p['id']) for p in full)
                job.update(page=page,pages=pages,received=len(seen),expected=total,message=f"{source['name']}: {len(seen):,} / {total:,} photos")
                save_job(job)
                await asyncio.sleep(.2)
            warning=None
            if len(seen)!=total or len(reported_totals)>1:
                warning=f"{source['name']}: all {pages} public pages traversed; {len(seen)} unique items retrieved. Flickr pages report inconsistent totals ({', '.join(str(v) for v in sorted(reported_totals))}). Completeness against the larger total is unverified."
                job.setdefault('warnings',[]).append(warning)
            with connect() as c:
                if not warning:c.execute('DELETE FROM membership WHERE source=? AND generation<>?',(source['id'],job['generation']))
                put(c,source['id'],{'total':total,'updated_at':remote.now(),'complete':not bool(warning),'traversal_complete':True,'reported_totals':sorted(reported_totals),'warning':warning})
        job.update(message='Resolving named sky targets',phase='locations');save_job(job)
        with connect() as c:photos=[json.loads(r[0]) for r in c.execute('SELECT payload FROM photos WHERE ra IS NULL ORDER BY posted DESC')]
        candidates=[p for p in photos if target_name(p)]
        for n,p in enumerate(candidates):
            loc=await locate_photo(p)
            if loc:
                p.update(ra=loc['ra'],dec=loc['dec'],location=loc)
                with connect() as c:c.execute('UPDATE photos SET ra=?,dec=?,payload=? WHERE id=?',(p['ra'],p['dec'],json.dumps(p),p['id']))
            job.update(message=f'Resolving named sky targets: {n+1} / {len(candidates)}',locations_checked=n+1)
            save_job(job)
        job.update(state='complete',completed_at=remote.now(),message='Public Flickr pages traversed; named targets resolved where available. Check source counts for any reported discrepancy.')
        save_job(job)
    except asyncio.CancelledError:
        job.update(state='interrupted',error='App stopped during gallery update. Retry Update images.');save_job(job);raise
    except Exception as e:
        job.update(state='failed',error=str(e),message='Gallery update incomplete. Previously downloaded photos remain available.');save_job(job)

def start_sync():
    global _task
    if _task is not None and not _task.done():return status()
    job={'generation':uuid.uuid4().hex,'state':'running','started_at':remote.now(),'message':'Connecting to NASA Webb Flickr','phase':'photos'}
    save_job(job);_task=asyncio.create_task(synchronize(job));return status()

def listing(source='all',page=1,search='',mapped=False):
    where=['1=1'];args=[]
    if source!='all':where.append('EXISTS(SELECT 1 FROM membership m WHERE m.photo=p.id AND m.source=?)');args.append(source)
    if search:where.append('(p.title LIKE ? OR p.kind LIKE ?)');args.extend(['%'+search+'%']*2)
    if mapped:where.append('ra IS NOT NULL')
    sql=' AND '.join(where)
    with connect() as c:
        total=c.execute('SELECT COUNT(*) FROM photos p WHERE '+sql,args).fetchone()[0]
        rows=c.execute('SELECT payload FROM photos p WHERE '+sql+' ORDER BY posted DESC,id DESC LIMIT 36 OFFSET ?',args+[(page-1)*36]).fetchall()
    return {'rows':[json.loads(r[0]) for r in rows],'total':total,'page':page,'pages':math.ceil(total/36)}

def photo(pid):
    with connect() as c:r=c.execute('SELECT payload FROM photos WHERE id=?',(pid,)).fetchone()
    if not r:raise ValueError('Photo is not in the local NASA Webb gallery.')
    return json.loads(r[0])

def map_points():
    with connect() as c:rows=c.execute('SELECT id,title,ra,dec FROM photos WHERE ra IS NOT NULL ORDER BY posted DESC').fetchall()
    return {'rows':[dict(r) for r in rows]}

async def image_bytes(pid):
    p=photo(pid);url=p.get('image_url')
    return await asyncio.to_thread(curl_image,url),p


def curl_image(url):
    # The public image CDN needs the same Windows TLS client as the listing pages.
    parsed=urlparse(url or '')
    if parsed.scheme!='https' or parsed.hostname!='live.staticflickr.com' or parsed.port not in (None,443):
        raise ValueError('No supported image preview is available.')
    exe=shutil.which('curl.exe') or shutil.which('curl')
    if not exe:raise ValueError('Windows curl is required to download NASA Webb images.')
    limit=20*1024*1024
    result=subprocess.run([exe,'--silent','--show-error','--fail','--proto','=https','--max-time','90','--max-filesize',str(limit),url],capture_output=True,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0),timeout=100)
    if result.returncode:raise ValueError(f'NASA image download failed (curl {result.returncode}). Retry or open its Flickr source.')
    if len(result.stdout)>limit:raise ValueError('Flickr preview exceeds the 20 MB limit. Use the source link to view it.')
    return result.stdout
