"""All-date, field-scoped MAST history without replacing the complete recent index."""
import asyncio
import json
import sqlite3
import uuid
from pathlib import Path
from astropy.time import Time
import coverage_guide as geometry
import recent_archive
import integrations as remote

PATH=Path(__file__).parent/'data'/'field-history.sqlite3'
# Positional CAOM joins expose objID twice; '*' lets MAST disambiguate it.
FIELDS='*'

def connect():
    c=sqlite3.connect(PATH,timeout=25);c.row_factory=sqlite3.Row
    c.executescript('''CREATE TABLE IF NOT EXISTS records(id TEXT PRIMARY KEY,payload TEXT);
    CREATE TABLE IF NOT EXISTS searches(id TEXT PRIMARY KEY,payload TEXT);
    CREATE TABLE IF NOT EXISTS members(search TEXT,record TEXT,PRIMARY KEY(search,record));''')
    return c

def observation(ident):
    try:return recent_archive.observation(ident)
    except ValueError:
        with connect() as c:r=c.execute('SELECT payload FROM records WHERE id=?',(ident,)).fetchone()
        if not r:raise ValueError('Observation not found in the recent index or saved field history.')
        return json.loads(r[0])

def describe(o):
    t=remote.number(o.get('t_min'))
    return {'id':str(o.get('record_id') or o.get('objID') or o['obsid']), 'obsid':str(o['obsid']),
            'title':o.get('target_name') or o['obs_id'],'observation':o['obs_id'],'mission':o['obs_collection'],
            'instrument':o.get('instrument_name') or '', 'filter':o.get('filters') or '',
            'date':Time(t,format='mjd').isot+'Z' if t is not None else None,'mjd':t,
            'exposure':remote.number(o.get('t_exptime')),'ra':remote.number(o.get('s_ra')),'dec':remote.number(o.get('s_dec')),
            'footprint':o.get('s_region'),'moving':bool(o.get('mtFlag')),
            'fits_available':bool((o.get('dataURL') or '').lower().endswith('.fits')),
            'preview_url':'/api/archive-preview?uri='+__import__('urllib.parse',fromlist=['quote']).quote(o['jpegURL'],safe='') if o.get('jpegURL') else None,
            'source_url':'https://mast.stsci.edu/portal/Mashup/Clients/Mast/Portal.html?searchQuery='+__import__('urllib.parse',fromlist=['quote']).quote(json.dumps({'service':'CAOM','inputText':o['obs_id']}),safe='')}

def local_rows(ra,dec,radius):
    import coverage_index
    candidates=coverage_index.possible_containment(ra,dec,'both')
    with recent_archive.connect() as c:
        gen=recent_archive.active(c)
        rows=c.execute('SELECT payload FROM observations WHERE generation=? AND dec BETWEEN ? AND ?',(gen,dec-radius,dec+radius)).fetchall()
        for start in range(0,len(candidates),400):
            batch=candidates[start:start+400]
            rows+=c.execute('SELECT payload FROM observations WHERE generation=? AND obsid IN ('+','.join('?' for _ in batch)+')',[gen,*batch]).fetchall()
    result={}
    for r in rows:
        o=json.loads(r[0])
        if not o.get('mtFlag') and (geometry.separation(ra,dec,o['s_ra'],o['s_dec'])<=radius or geometry.contains(geometry.footprint(o.get('s_region')),ra,dec)):
            result[str(o.get('record_id') or o.get('objID') or o['obsid'])]=o
    return list(result.values())

async def fetch(ra,dec,radius,job=None):
    # Completeness is checked for this cone; this is not a whole-archive backfill.
    ident=uuid.uuid4().hex;records={};expected=None;page=1;stale=False
    filters=[{'paramName':k,'values':v} for k,v in [('obs_collection',['HST','JWST']),('dataproduct_type',['image']),('dataRights',['PUBLIC']),('calib_level',[2,3]),('intentType',['science'])]]
    while True:
        if job:
            if job['cancelled']:raise ValueError('History download cancelled. Earlier saved searches remain available.')
            job['progress']=f'History page {page} · {len(records)} observations'
        d=await remote.mast('Mast.Caom.Filtered.Position',{'columns':FIELDS,'filters':filters,'position':f'{ra:.8f}, {dec:.8f}, {radius:.8f}'},page=page,pagesize=1000)
        raw=d['data'];p=raw.get('paging',{});total=int(p.get('rowsFiltered',len(raw.get('data',[]))));stale|=d['stale']
        if expected is not None and total!=expected:raise ValueError('MAST result count changed. Retry the field history.')
        expected=total
        if total>20000:raise ValueError(f'{total:,} records in this field. Reduce the radius to keep the history manageable (20,000 record limit).')
        for o in raw.get('data',[]):
            rid=str(o.get('objID') or o['obsid'])
            if not rid.isdigit():raise ValueError('MAST returned an invalid identifier.')
            records[rid]={**o,'record_id':rid}
        if page>=int(p.get('pagesFiltered',1)):break
        if not raw.get('data'):raise ValueError('MAST returned an incomplete history page.')
        page+=1
    if len(records)!=expected:raise ValueError('History completeness check failed; the previous search is preserved.')
    report={'id':ident,'ra':ra,'dec':dec,'radius':radius,'total':len(records),'complete':True,'stale':stale,'fetched_at':remote.now(),'scope':'Public HST and JWST calibrated science images at all available dates within this sky cone.'}
    with connect() as c:
        c.executemany('INSERT OR REPLACE INTO records VALUES(?,?)',[(k,json.dumps(v)) for k,v in records.items()])
        c.executemany('INSERT INTO members VALUES(?,?)',[(ident,k) for k in records])
        c.execute('INSERT INTO searches VALUES(?,?)',(ident,json.dumps(report)))
    return result(ident)

def result(ident):
    with connect() as c:
        r=c.execute('SELECT payload FROM searches WHERE id=?',(ident,)).fetchone()
        if not r:raise ValueError('Saved history not found.')
        rows=[json.loads(v[0]) for v in c.execute('SELECT r.payload FROM records r JOIN members m ON r.id=m.record WHERE m.search=?',(ident,))]
    d=json.loads(r[0]);d['rows']=sorted([describe(o) for o in rows if not o.get('mtFlag')],key=lambda o:(o['mjd'] is None,o['mjd'] or 0,o['id']))
    d['moving_excluded']=len(rows)-len(d['rows']);return d

def saved():
    with connect() as c:return [json.loads(r[0]) for r in c.execute('SELECT payload FROM searches ORDER BY rowid DESC LIMIT 30')]

def compatible(a,b):
    reasons=[]
    for key,label in [('obs_collection','telescope'),('instrument_name','instrument'),('filters','filter')]:
        if not a.get(key) or not b.get(key) or a[key]!=b[key]:reasons.append('Different or unknown '+label)
    if a.get('mtFlag') or b.get('mtFlag'):reasons.append('Moving target')
    if a.get('dataURL')==b.get('dataURL'):reasons.append('Same underlying product')
    ta,tb=remote.number(a.get('t_min')),remote.number(b.get('t_min'));ea,eb=remote.number(a.get('t_max')),remote.number(b.get('t_max'))
    if ta is None or tb is None:reasons.append('Unknown observation date')
    elif ta==tb or (ea is not None and eb is not None and max(ta,tb)<=min(ea,eb)):reasons.append('Overlapping observing intervals; exposures may not be independent')
    return reasons
