"""Small, read-only adapters for public astronomy services."""
import asyncio
import hashlib
import json
import math
import uuid
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote

import httpx

ROOT = Path(__file__).parent
CACHE = ROOT / 'data' / 'cache'
CACHE.mkdir(parents=True, exist_ok=True)
MAST = 'https://mast.stsci.edu/api/v0/invoke'
LIVE = 'https://spacetelescopelive.org'
REQUESTED_OBS = '01M0T4XYBKBP63HYG18QQ1QT8S'

def now():
    return datetime.now(timezone.utc).isoformat()

async def remote_json(url, *, params=None, headers=None, ttl=300):
    key = hashlib.sha256(json.dumps([url, params, headers], sort_keys=True).encode()).hexdigest()
    path = CACHE / (key + '.json')
    cached = None
    if path.exists():
        try:
            cached = json.loads(path.read_text(encoding='utf-8'))
            age = (datetime.now(timezone.utc) - datetime.fromisoformat(cached['fetched_at'])).total_seconds()
            if age < ttl:
                return {**cached, 'stale': False, 'cached': True}
        except (ValueError, KeyError):
            cached = None
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(50, connect=12), follow_redirects=True) as c:
            r = await c.get(url, params=params, headers={'User-Agent': 'UniverseExplorer/0.1 personal astronomy app', **(headers or {})})
            r.raise_for_status()
            data = json.loads(r.text)
        result = {'data': data, 'fetched_at': now(), 'stale': False, 'cached': False}
        # Never cache an incomplete or failed MAST response as a successful query.
        if isinstance(data, dict) and data.get('status') in ('ERROR', 'EXECUTING'):
            raise ValueError(data.get('msg') or 'Archive query is still processing. Please retry.')
        temp = path.with_suffix('.'+uuid.uuid4().hex+'.tmp')
        temp.write_text(json.dumps(result), encoding='utf-8')
        temp.replace(path)
        return result
    except (httpx.HTTPError, ValueError) as e:
        if cached:
            return {**cached, 'stale': True, 'cached': True, 'warning': f'Live refresh failed: {type(e).__name__}. Showing saved data.'}
        raise ValueError(f'The remote service did not respond successfully ({type(e).__name__}). Please retry.') from e

def number(value):
    try:
        n = float(value)
        return n if math.isfinite(n) else None
    except (ValueError, TypeError):
        return None

def normalize_live(payload, telescope):
    d = payload.get('data', payload)
    if not isinstance(d, dict) or not d.get('id'):
        raise ValueError('No observation is available from the telescope feed.')
    target = (d.get('targets') or [{}])[0]
    p = d.get('proposal') or {}
    start = next((d.get(k) for k in ['executedStartTime','scheduledStartTime','predictedStartTime','startTime'] if d.get(k)), None)
    end = next((d.get(k) for k in ['executedEndTime','scheduledEndTime','predictedEndTime','endTime'] if d.get(k)), None)
    status = (d.get('executionStatus') or {}).get('title')
    if not status:
        if d.get('executed') is True or d.get('executedEndTime'):
            status = 'Execution reported'
        else:
            status = 'Scheduled / execution unconfirmed'
    return {
        'telescope': telescope, 'id': d['id'],
        'target': target.get('name') or d.get('targetName') or 'Unnamed target',
        'ra': number(target.get('rightAscensionInDegrees') or d.get('targetRightAscensionInDegrees') or d.get('boreSightRightAscensionInDegrees')),
        'dec': number(target.get('declinationInDegrees') or d.get('targetDeclinationInDegrees') or d.get('boreSightDeclinationInDegrees')),
        'moving_target': bool(d.get('isMovingTarget')), 'start': start, 'end': end, 'status': status,
        'title': p.get('title'), 'program': p.get('proposalID'),
        'investigator': (p.get('primaryInvestigator') or {}).get('formalName'),
        'instruments': [i.get('code', i.get('title')) for i in p.get('instruments', [])],
        'category': (p.get('scientificCategory') or {}).get('title'),
        'target_category': target.get('category'),
        'source_url': f'{LIVE}/{telescope}?obsId={d["id"]}',
        'image_note': 'Observation schedule metadata. This is not a live telescope image.',
    }

async def live_observation(telescope, obs_id='current'):
    result = await remote_json(f'{LIVE}/api/get/{telescope}', headers={'endpoint': obs_id}, ttl=60)
    return {**{k:v for k,v in result.items() if k != 'data'}, **normalize_live(result['data'], telescope)}

async def mast(service, params, page=1, pagesize=60):
    req = {'service': service, 'params': params, 'format': 'json', 'page': page, 'pagesize': pagesize}
    return await remote_json(MAST, params={'request': json.dumps(req, separators=(',', ':'))}, ttl=600)

async def archive_search(ra, dec, radius, telescope='both', page=1, band='all'):
    collections = ['HST','HLA','JWST'] if telescope == 'both' else (['HST','HLA'] if telescope == 'hubble' else ['JWST'])
    filters = [
        {'paramName':'obs_collection', 'values':collections},
        {'paramName':'dataproduct_type', 'values':['image']},
        {'paramName':'dataRights', 'values':['PUBLIC']},
        {'paramName':'calib_level', 'values':[2,3]},
    ]
    bands = {'ha':['F656N','F657N'], 'oiii':['F502N'], 'sii':['F673N'], 'h2':['F212N'], 'nir':['F200W'], 'mir':['F770W']}
    if band in bands:
        filters.append({'paramName':'filters','values':bands[band],'separator':';'})
    # Normalize insignificant floating-point jitter from sky-map projections so repeat
    # field searches share a cache entry (8 decimals retain 0.036 milliarcsecond precision).
    result = await mast('Mast.Caom.Filtered.Position', {'columns':'*','filters':filters,'position':f'{round(ra,8)}, {round(dec,8)}, {radius}'}, page)
    raw = result['data']
    keep = ['obsid','obs_id','obs_collection','target_name','instrument_name','filters','t_min','t_max','t_exptime','s_ra','s_dec','s_fov','s_region','jpegURL','dataURL','dataRights','calib_level','proposal_id']
    rows = [{k:r.get(k) for k in keep} for r in raw.get('data', [])]
    return {**{k:v for k,v in result.items() if k != 'data'}, 'rows':rows, 'paging':raw.get('paging', {}), 'source':'MAST public calibrated images', 'radius':radius}

async def products(obsid):
    result = await mast('Mast.Caom.Products', {'obsid':str(obsid)}, pagesize=500)
    rows=[]
    for r in result['data'].get('data', []):
        if r.get('dataRights') not in ('PUBLIC', None):
            continue
        uri = r.get('dataURI') or ''
        name = r.get('productFilename') or ''
        if not (name.lower().endswith(('.fits','.fits.gz','.jpg','.jpeg','.png')) and uri.startswith('mast:')):
            continue
        rows.append({k:r.get(k) for k in ['productFilename','dataURI','size','description','productType','productSubGroupDescription','calib_level']})
    rows.sort(key=lambda r: (r.get('productSubGroupDescription') not in ['I2D','DRZ','DRC','MOS','CAL'], r.get('productType') != 'SCIENCE', (r.get('calib_level') or 0) < 2, r.get('size') or 0))
    return {'rows':rows,'fetched_at':result['fetched_at'],'stale':result['stale'],'paging':result['data'].get('paging',{})}

async def resolve(name):
    result = await mast('Mast.Name.Lookup', {'input':name, 'format':'json'}, pagesize=1)
    rows = result['data'].get('resolvedCoordinate') or []
    if not rows:
        raise ValueError('Object name was not resolved. Try a catalog name or decimal RA, Dec.')
    return {'name':name,'ra':rows[0]['ra'],'dec':rows[0]['decl']}

async def exoplanets(ra, dec, radius):
    query = ("select top 100 pl_name,hostname,ra,dec,discoverymethod,disc_year,pl_orbper,pl_rade,sy_dist "
             "from pscomppars where 1=contains(point('ICRS',ra,dec)," f"circle('ICRS',{ra},{dec},{radius})) order by pl_name")
    r=await remote_json('https://exoplanetarchive.ipac.caltech.edu/TAP/sync', params={'query':query,'format':'json'}, ttl=3600)
    return {'rows':r['data'],'fetched_at':r['fetched_at'],'stale':r['stale'],'source':'NASA Exoplanet Archive; known confirmed planets'}

async def catalog_match(ra, dec):
    r=await mast('Mast.Catalogs.GaiaDR3.Cone', {'ra':ra,'dec':dec,'radius':3/3600}, pagesize=20)
    fields=['source_id','ra','dec','phot_g_mean_mag','parallax','pmra','pmdec','distance']
    rows=[{k:v.get(k) for k in fields} for v in r['data'].get('data',[])]
    for row in rows:
        if row['source_id'] is not None: row['source_id']=str(row['source_id'])
    return {'rows':rows,'radius_arcsec':3,'fetched_at':r['fetched_at'],'stale':r['stale'],
            'note':'Gaia DR3 positional check only. No match does not establish a new object; consider catalog depth, epoch, proper motion, artifacts, and other catalogs.'}

async def download_mast(uri, max_bytes=100*1024*1024):
    if not uri.startswith('mast:') or len(uri)>1000:
        raise ValueError('Only MAST archive product identifiers are accepted.')
    url='https://mast.stsci.edu/api/v0.1/Download/file'
    buf=bytearray()
    async with httpx.AsyncClient(timeout=httpx.Timeout(120, connect=15), follow_redirects=True) as c:
        async with c.stream('GET',url,params={'uri':uri}) as r:
            r.raise_for_status()
            if int(r.headers.get('content-length','0'))>max_bytes:
                raise ValueError('This product exceeds the 100 MB in-app limit. Download it through MAST and crop it locally.')
            async for chunk in r.aiter_bytes():
                buf.extend(chunk)
                if len(buf)>max_bytes:
                    raise ValueError('Product exceeds the 100 MB in-app limit.')
    return bytes(buf)
