"""Complete, refreshable MAST image-observation index; science pixels stay in MAST."""
import asyncio
import json
import math
import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path

import httpx
import numpy as np
from astropy.time import Time

from integrations import MAST, now, number

PATH = Path(__file__).parent / 'data' / 'recent-archive.sqlite3'
START = '2022-01-01'
FIELDS = 'objID,obsid,obs_id,obs_collection,target_name,instrument_name,filters,t_min,t_max,t_exptime,s_ra,s_dec,s_region,jpegURL,dataURL,dataRights,calib_level,proposal_id,obs_title,mtFlag'
PAGE_SIZE = 5000
_task = None
_coordinates = None

def connect():
    c = sqlite3.connect(PATH, timeout=30)
    c.row_factory = sqlite3.Row
    c.execute('PRAGMA journal_mode=WAL')
    c.executescript('''
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS observations (
        generation TEXT, obsid TEXT, mission TEXT, ra REAL, dec REAL, observed REAL,
        title TEXT, filter TEXT, payload TEXT NOT NULL, PRIMARY KEY(generation,obsid));
      CREATE INDEX IF NOT EXISTS obs_date ON observations(generation,observed DESC);
      CREATE INDEX IF NOT EXISTS obs_mission ON observations(generation,mission);
    ''')
    return c

def setting(c, key, default=None):
    row = c.execute('SELECT value FROM settings WHERE key=?', (key,)).fetchone()
    return json.loads(row[0]) if row else default

def put(c, key, value):
    c.execute('INSERT OR REPLACE INTO settings VALUES (?,?)', (key, json.dumps(value)))

def save_job(job):
    with connect() as c: put(c, 'job', job)

def active(c):
    complete = setting(c, 'complete')
    job = setting(c, 'job', {})
    return (complete or job).get('generation', '')

def status():
    with connect() as c:
        complete = setting(c, 'complete')
        job = setting(c, 'job', {})
        generation = active(c)
        counts = {r['mission']: r['n'] for r in c.execute('SELECT mission,COUNT(*) n FROM observations WHERE generation=? GROUP BY mission', (generation,))}
        dates = c.execute('SELECT MIN(observed),MAX(observed),COUNT(*)-COUNT(ra) FROM observations WHERE generation=?', (generation,)).fetchone()
    if job.get('state') == 'running' and (_task is None or _task.done()):
        job = {**job, 'state':'interrupted', 'error':'Update interrupted. Update images will retry the full date range.'}
    return {'counts': counts, 'total': sum(counts.values()), 'unmapped': dates[2],
            'earliest_mjd':dates[0], 'latest_mjd':dates[1], 'complete':complete,
            'job':job, 'generation':generation, 'start':START,
            'scope':'Public HST and JWST science image observations, calibration levels 2 and 3, observed since 2022-01-01. Each record can have several files.',
            'storage':'Coordinates and image references are saved locally. Previews and original science files are fetched when opened.'}

async def fetch_page(client, mission, end, page):
    filters = [{'paramName':k,'values':v} for k,v in [
        ('obs_collection',[mission]), ('dataproduct_type',['image']),
        ('dataRights',['PUBLIC']), ('calib_level',[2,3]), ('intentType',['science']),
        ('t_min',[{'min':float(Time(START).mjd),'max':end}])]]
    req = {'service':'Mast.Caom.Filtered','params':{'columns':FIELDS,'filters':filters},
           'format':'json','page':page,'pagesize':PAGE_SIZE,'timeout':25}
    # One fixed end timestamp per run gives pages a common MAST snapshot and makes
    # the next update a new query, including older observations newly made public.
    last = None
    for attempt in range(6):
        try:
            r = await client.get(MAST, params={'request':json.dumps(req,separators=(',',':'))})
            r.raise_for_status()
            d = r.json()
            if d.get('status') == 'COMPLETE': return d
            last = ValueError(d.get('msg') or 'MAST query still executing')
            if d.get('status') not in ('EXECUTING', None): raise last
        except (httpx.HTTPError, ValueError) as e:
            last = e
        await asyncio.sleep(min(2*(attempt+1),10))
    raise ValueError(f'MAST {mission} page {page} could not complete: {last}')

def store_page(generation, rows):
    values = []
    for r in rows:
        if not str(r.get('obsid','')).isdigit(): raise ValueError('MAST returned an invalid observation identifier.')
        ra, dec = number(r.get('s_ra')), number(r.get('s_dec'))
        if ra is None or dec is None or not 0 <= ra < 360 or not -90 <= dec <= 90: ra = dec = None
        r = {**r, 'record_id':str(r.get('objID') or r['obsid'])}
        values.append((generation,r['record_id'],r['obs_collection'],ra,dec,number(r.get('t_min')),
                       r.get('target_name') or r['obs_id'],r.get('filters'),json.dumps(r,separators=(',',':'))))
    with connect() as c:
        c.executemany('INSERT OR REPLACE INTO observations VALUES (?,?,?,?,?,?,?,?,?)',values)

async def synchronize(job):
    global _coordinates
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(100,connect=15), follow_redirects=True) as client:
            for mission in ('JWST','HST'):
                page, received, expected = 1, 0, None
                while True:
                    job.update(mission=mission,page=page,message=f'Fetching {mission} page {page}')
                    save_job(job)
                    raw = await fetch_page(client,mission,job['end_mjd'],page)
                    paging = raw.get('paging',{})
                    total = int(paging['rowsFiltered'])
                    pages = int(paging['pagesFiltered'])
                    if expected is not None and expected != total: raise ValueError('MAST result count changed during pagination. Retry to obtain a complete snapshot.')
                    expected = total
                    rows = raw.get('data',[])
                    if not rows and received < total: raise ValueError('MAST returned an empty page before all records were received.')
                    await asyncio.to_thread(store_page,job['generation'],rows)
                    received += len(rows)
                    job['missions'][mission] = {'received':received,'expected':total,'pages':pages,'page':page}
                    job['received'] = sum(v['received'] for v in job['missions'].values())
                    save_job(job)
                    _coordinates = None
                    if page >= pages: break
                    page += 1
                with connect() as c:
                    unique = c.execute('SELECT COUNT(*) FROM observations WHERE generation=? AND mission=?',(job['generation'],mission)).fetchone()[0]
                if received != expected or unique != expected:
                    raise ValueError(f'{mission} completeness check failed: {unique} unique records for {expected} expected. Retry the update.')
        job.update(state='complete',completed_at=now(),message='All matching result pages downloaded and verified.')
        with connect() as c:
            put(c,'complete',dict(job))
            put(c,'job',job)
            c.execute('DELETE FROM observations WHERE generation<>?',(job['generation'],))
        _coordinates = None
    except asyncio.CancelledError:
        job.update(state='interrupted',error='App stopped during update. Retry with Update images.')
        save_job(job)
        raise
    except Exception as e:
        job.update(state='failed',error=str(e),message='Update incomplete. The last complete index is retained.')
        save_job(job)

def start_sync():
    global _task
    if _task is not None and not _task.done(): return status()
    job = {'generation':uuid.uuid4().hex,'state':'running','started_at':now(),'start':START,
           'end_mjd':float(Time(datetime.now(timezone.utc)).mjd),'missions':{},'received':0,'message':'Connecting to MAST'}
    save_job(job)
    _task = asyncio.create_task(synchronize(job))
    return status()

def coordinate_table():
    global _coordinates
    with connect() as c:
        generation = active(c)
        if _coordinates is not None and _coordinates[0] == generation: return _coordinates
        rows = c.execute('SELECT obsid,ra,dec,mission FROM observations WHERE generation=? AND ra IS NOT NULL',(generation,)).fetchall()
    ids = np.array([r[0] for r in rows])
    coords = np.array([(r[1],r[2]) for r in rows],dtype=float).reshape(-1,2)
    missions = np.array([r[3]=='JWST' for r in rows])
    _coordinates = (generation,ids,coords,missions)
    return _coordinates

def map_points(ra,dec,radius,fov,mission='both'):
    generation,ids,coords,webb = coordinate_table()
    mask = np.ones(len(ids),dtype=bool)
    if mission != 'both': mask &= webb if mission=='webb' else ~webb
    if radius < 180 and len(coords):
        cosdist = np.sin(np.radians(coords[:,1]))*math.sin(math.radians(dec))+np.cos(np.radians(coords[:,1]))*math.cos(math.radians(dec))*np.cos(np.radians(coords[:,0]-ra))
        mask &= cosdist >= math.cos(math.radians(radius)) - 1e-12
    ids,coords,webb = ids[mask],coords[mask],webb[mask]
    total = len(ids)
    if total <= 250:
        return {'generation':generation,'total':total,'grouped':False,'rows':[
            {'id':str(i),'ra':float(p[0]),'dec':float(p[1]),'count':1,'webb':int(w),'hubble':int(not w)} for i,p,w in zip(ids,coords,webb)]}
    # Angular bins bound the display cost; every record contributes to a count.
    cell = max(fov/18,0.00001)
    decbin = np.floor((coords[:,1]+90)/cell)
    middec = np.clip((decbin+.5)*cell-90,-90,90)
    widths = np.minimum(360,cell/np.maximum(.01,np.cos(np.radians(middec))))
    rabin = np.floor(coords[:,0]/widths)
    keys = np.column_stack((decbin,rabin))
    _,inverse = np.unique(keys,axis=0,return_inverse=True)
    count = np.bincount(inverse)
    x = np.bincount(inverse,weights=np.cos(np.radians(coords[:,0])))
    y = np.bincount(inverse,weights=np.sin(np.radians(coords[:,0])))
    meanra = np.degrees(np.arctan2(y,x))%360
    meandec = np.bincount(inverse,weights=coords[:,1])/count
    wc = np.bincount(inverse,weights=webb).astype(int)
    return {'generation':generation,'total':total,'grouped':True,'cell':cell,'rows':[
        {'id':f'group-{n}','ra':float(meanra[n]),'dec':float(meandec[n]),'count':int(v),'webb':int(wc[n]),'hubble':int(v-wc[n]),'radius':min(180,cell*2)} for n,v in enumerate(count)]}

def listing(ra=None,dec=None,radius=180,mission='both',page=1,search=''):
    generation,ids,coords,webb = coordinate_table()
    clauses = ['generation=?']; args = [generation]
    if mission != 'both': clauses.append('mission=?'); args.append('JWST' if mission=='webb' else 'HST')
    if search: clauses.append('(title LIKE ? OR filter LIKE ? OR obsid=?)'); args.extend(['%'+search+'%','%'+search+'%',search])
    if ra is not None and dec is not None and radius < 180:
        # SQL exact great-circle filter, including RA wrap and poles.
        clauses.append('(sin(radians(dec))*sin(radians(?))+cos(radians(dec))*cos(radians(?))*cos(radians(ra-?)))>=?')
        args.extend([dec,dec,ra,math.cos(math.radians(radius))-1e-12])
    where = ' AND '.join(clauses)
    with connect() as c:
        # Python's SQLite build need not provide the optional math extension.
        for name,func in [('sin',math.sin),('cos',math.cos),('radians',math.radians)]: c.create_function(name,1,lambda x,f=func: None if x is None else f(x))
        total = c.execute('SELECT COUNT(*) FROM observations WHERE '+where,args).fetchone()[0]
        rows = c.execute('SELECT payload FROM observations WHERE '+where+' ORDER BY observed DESC,obsid LIMIT 36 OFFSET ?',args+[(page-1)*36]).fetchall()
    return {'rows':[json.loads(r[0]) for r in rows],'total':total,'page':page,'pages':math.ceil(total/36)}

def observation(obsid):
    with connect() as c:
        row = c.execute('SELECT payload FROM observations WHERE generation=? AND obsid=?',(active(c),obsid)).fetchone()
    if not row: raise ValueError('Observation is not in the local recent-image index.')
    return json.loads(row[0])
