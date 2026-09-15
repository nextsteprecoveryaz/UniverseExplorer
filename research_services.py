"""Public catalog adapters, automatic TESS retrieval and a persistent field watchlist."""
import asyncio,hashlib,io,json,math,re,sqlite3,uuid
from pathlib import Path
from threading import RLock
from urllib.parse import quote
from astropy.io import fits
import integrations as remote
import field_history as history
import recent_archive
import coverage_guide
import object_map
import science
import atlas_cache as cache

PATH=Path(__file__).parent/'data'/'research.sqlite3'
GAIA='https://gea.esac.esa.int/tap-server/tap/sync'
WATCH_LOCK=RLock()

def connect():
    c=sqlite3.connect(PATH,timeout=25);c.row_factory=sqlite3.Row
    c.executescript('''CREATE TABLE IF NOT EXISTS watches(id TEXT PRIMARY KEY,payload TEXT);
    CREATE TABLE IF NOT EXISTS seen(watch TEXT,record TEXT,PRIMARY KEY(watch,record));
    CREATE TABLE IF NOT EXISTS notices(id TEXT PRIMARY KEY,watch TEXT,payload TEXT,read INTEGER DEFAULT 0);
    CREATE TABLE IF NOT EXISTS tess(id TEXT PRIMARY KEY,payload TEXT);''')
    return c

def parse_tap(d):
    keys=[m['name'].lower() for m in d['metadata']]
    return [dict(zip(keys,v)) for v in d['data']]

def space_row(r):
    p,e=remote.number(r.get('parallax')),remote.number(r.get('parallax_error'))
    if p is None or e is None or e<=0 or p/e<10 or p<=0:return None
    distance=1000/p;ra,dec=map(math.radians,(r['ra'],r['dec']))
    return {**r,'source_id':str(r['source_id']),'distance_pc':distance,'distance_error_pc':1000*e/p**2,'distance_interval_pc':[1000/(p+e),1000/(p-e)],'xyz_pc':[distance*math.cos(dec)*math.cos(ra),distance*math.cos(dec)*math.sin(ra),distance*math.sin(dec)],'source_url':'https://gea.esac.esa.int/archive/?target=Gaia%20DR3%20'+str(r['source_id'])}

async def neighborhood(radius=25):
    query=f'SELECT TOP 5001 source_id,ra,dec,parallax,parallax_error,parallax_over_error,pmra,pmdec,phot_g_mean_mag,bp_rp,ruwe FROM gaiadr3.gaia_source WHERE parallax>={1000/radius:.8f} AND parallax_over_error>=10 AND ruwe<1.4 ORDER BY parallax DESC'
    result=await remote.remote_json(GAIA,params={'REQUEST':'doQuery','LANG':'ADQL','FORMAT':'json','QUERY':query},ttl=7*86400)
    records=parse_tap(result['data']);rows=[space_row(r) for r in records[:5000]]
    return {'rows':[r for r in rows if r],'radius_pc':radius,'truncated':len(records)>5000,'fetched_at':result['fetched_at'],'stale':result['stale'],'epoch':2016.0,'query':query,'source_url':'https://www.cosmos.esa.int/web/gaia/dr3','note':'Selected Gaia DR3 stars with positive parallax, parallax/error >= 10 and RUWE < 1.4. Inverse-parallax distances and approximate 1-sigma statistical intervals, without zero-point correction or covariance. ICRS positions at epoch 2016.0; Sun at origin. Incomplete nearby-star sample, capped at 5,000 nearest qualifying sources. Star sizes and colors are display symbols.'}

async def tess_search(ra,dec,radius=10):
    rows={};page=1;expected=None;stale=False;received=0
    filters=[{'paramName':'obs_collection','values':['TESS']},{'paramName':'dataproduct_type','values':['timeseries']},{'paramName':'dataRights','values':['PUBLIC']}]
    while True:
        r=await remote.mast('Mast.Caom.Filtered.Position',{'columns':'*','filters':filters,'position':f'{ra:.8f}, {dec:.8f}, {radius/3600:.8f}'},page=page,pagesize=500)
        raw=r['data'];p=raw.get('paging',{});total=int(p.get('rowsFiltered',len(raw.get('data',[]))));stale|=r['stale']
        if total>2000:raise ValueError('Too many TESS records. Choose a specific star or a smaller search radius.')
        if expected is not None and total!=expected:raise ValueError('TESS results changed during retrieval. Please retry.')
        expected=total
        received+=len(raw.get('data',[]))
        for o in raw.get('data',[]):
            ident=str(o['obsid']);rows[ident]=o
        if page>=int(p.get('pagesFiltered',1)):break
        if not raw.get('data'):raise ValueError('Incomplete TESS response.')
        page+=1
    if received!=expected:raise ValueError('Incomplete TESS result set. Retry the search.')
    # CAOM can return multiple product rows for one observation; preserve unique obsids.
    with connect() as c:c.executemany('INSERT OR REPLACE INTO tess VALUES(?,?)',[(k,json.dumps(v)) for k,v in rows.items()])
    result=[]
    for ident,o in rows.items():
        result.append({'id':ident,'observation':o['obs_id'],'target':o.get('target_name'),'ra':o.get('s_ra'),'dec':o.get('s_dec'),'sector':o.get('sequence_number'),'start_mjd':o.get('t_min'),'end_mjd':o.get('t_max'),'cadence_seconds':o.get('t_exptime'),'distance_arcsec':coverage_guide.separation(ra,dec,o['s_ra'],o['s_dec'])*3600,'provider':o.get('provenance_name'),'lightcurve_product':bool(re.search(r'[-_](?:lc|lcf)\.fits$',o.get('dataURL') or '',re.I))})
    return {'rows':sorted(result,key=lambda x:(x['distance_arcsec'],x['start_mjd'] or 0)),'archive_rows':expected,'complete':True,'radius_arcsec':radius,'fetched_at':remote.now(),'stale':stale,'note':'Public TESS mission time-series observations in this cone. Select the intended star by target, position and sector. Some observations lack a supported light-curve product; other HLSP collections are outside this search.'}

async def tess_analyze(ident,min_period=.5,max_period=15):
    with connect() as c:r=c.execute('SELECT payload FROM tess WHERE id=?',(ident,)).fetchone()
    if not r:raise ValueError('Search this star in TESS first.')
    observation=json.loads(r[0]);products=await remote.products(ident)
    choices=[p for p in products['rows'] if re.search(r'[-_](?:lc|lcf)\.fits$',p['productFilename'],re.I) and (p.get('size') or 0)<=100*1024*1024]
    if not choices:raise ValueError('No supported light-curve FITS under 100 MB was returned for this observation. Inspect its MAST products.')
    chosen=sorted(choices,key=lambda p:('_fast' in p['productFilename'],p['productFilename']))[0]
    uri=chosen['dataURI'];key=cache.key('tess-original:'+uri);item=cache.get(key)
    content=item['path'].read_bytes() if item else await remote.download_mast(uri)
    if not item:cache.put(key,content,'application/fits',{'source_uri':uri,'filename':chosen['productFilename']})
    with fits.open(io.BytesIO(content),memmap=False) as hdus:
        h=next((h for h in hdus if getattr(h,'columns',None) is not None and 'TIME' in h.columns.names),None)
        if h is None:raise ValueError('This product does not contain a supported TESS light curve.')
        info={k:remote.number(h.header.get(k,hdus[0].header.get(k))) for k in ['SECTOR','TICID','CROWDSAP','FLFRCSAP','BJDREFI','BJDREFF','TIMEDEL']}
    result=await asyncio.to_thread(science.transit_search,content,chosen['productFilename'],min_period,max_period)
    result['tess']={'obsid':ident,'observation':observation['obs_id'],'target':observation.get('target_name'),'source_uri':uri,'original_url':'/api/atlas/files/'+key,'sha256':hashlib.sha256(content).hexdigest(),'header':info,'product_list_truncated':int(products.get('paging',{}).get('pagesFiltered',1))>1,'note':'CROWDSAP estimates target flux / total aperture flux; FLFRCSAP is the fraction of target flux in the aperture. They do not rule out blends or false positives. Analyze other sectors independently; periods may be aliases.'}
    return result

async def catalogs(ra,dec):
    out=[]
    for name,call,url in [('Gaia DR3',remote.catalog_match(ra,dec),'https://gea.esac.esa.int/archive/'),('SIMBAD',object_map.objects(ra,dec,3/3600),'https://simbad.cds.unistra.fr/simbad/')]:
        try:
            result=await call
            out.append({'catalog':name,'available':result.get('catalog_available',True),'source_url':url,**result,'error':result.get('warning')})
        except Exception as e:out.append({'catalog':name,'available':False,'error':str(e),'rows':[],'source_url':url})
    try:
        r=await remote.mast('Mast.Catalogs.Tic.Cone',{'ra':ra,'dec':dec,'radius':3/3600},pagesize=50)
        fields=['ID','ra','dec','Tmag','GAIA','objType','pmRA','pmDEC']
        rows=[{k:(str(o[k]) if k in ('ID','GAIA') and o.get(k) is not None else o.get(k)) for k in fields} for o in r['data'].get('data',[])]
        out.append({'catalog':'TESS Input Catalog','available':True,'rows':rows,'source_url':'https://mast.stsci.edu/portal/Mashup/Clients/Mast/Portal.html','stale':r['stale'],'fetched_at':r['fetched_at']})
    except Exception as e:out.append({'catalog':'TESS Input Catalog','available':False,'rows':[],'error':str(e)})
    return {'catalogs':out,'ra':ra,'dec':dec,'radius_arcsec':3,'note':'Positional associations, not identifications. Proper motion is not propagated to image epochs. No match, a failed service or a flagged fit cannot establish novelty.'}

def watches():
    with connect() as c:
        rows=[json.loads(r[0]) for r in c.execute('SELECT payload FROM watches ORDER BY rowid DESC')]
        notices=[{**json.loads(r['payload']),'read':bool(r['read'])} for r in c.execute('SELECT * FROM notices ORDER BY rowid DESC LIMIT 200')]
    return {'rows':rows,'notices':notices,'note':'Checks nearby pointing centers and supported footprints containing the watched center in the local recent index while this app is open. Use Update images to pull new archive metadata, then Check now. Notifications mean newly seen archive records, not new discoveries or newly taken exposures. Unsupported footprints may be missed outside the pointing radius.'}

def add_watch(data):
    with WATCH_LOCK:return _add_watch(data)

def _add_watch(data):
    rows=history.local_rows(data['ra'],data['dec'],data['radius']);ident=uuid.uuid4().hex
    with recent_archive.connect() as c:gen=recent_archive.active(c)
    item={**data,'id':ident,'created_at':remote.now(),'checked_at':remote.now(),'generation':gen,'baseline':len(rows)}
    with connect() as c:
        if c.execute('SELECT count(*) FROM watches').fetchone()[0]>=100:raise ValueError('The watchlist holds up to 100 fields.')
        c.execute('INSERT INTO watches VALUES(?,?)',(ident,json.dumps(item)))
        c.executemany('INSERT INTO seen VALUES(?,?)',[(ident,str(o.get('record_id') or o.get('objID') or o['obsid'])) for o in rows])
    return item

def check_watches(force=False):
    with WATCH_LOCK:return _check_watches(force)

def _check_watches(force=False):
    with recent_archive.connect() as c:gen=recent_archive.active(c)
    added=0
    for item in watches()['rows']:
        if not force and item.get('generation')==gen:continue
        rows=history.local_rows(item['ra'],item['dec'],item['radius'])
        with connect() as c:
            seen={r[0] for r in c.execute('SELECT record FROM seen WHERE watch=?',(item['id'],))}
            newer=[o for o in rows if str(o.get('record_id') or o.get('objID') or o['obsid']) not in seen]
            c.executemany('INSERT OR IGNORE INTO seen VALUES(?,?)',[(item['id'],str(o.get('record_id') or o.get('objID') or o['obsid'])) for o in rows])
            if newer:
                notice={'id':uuid.uuid4().hex,'watch_id':item['id'],'title':item['title'],'created_at':remote.now(),'count':len(newer),'observations':[history.describe(o) for o in sorted(newer,key=lambda o:o.get('t_min') or 0,reverse=True)[:50]],'listed_limit':50};added+=1
                c.execute('INSERT INTO notices VALUES(?,?,?,0)',(notice['id'],item['id'],json.dumps(notice)))
            item.update(generation=gen,checked_at=remote.now(),baseline=len(rows));c.execute('UPDATE watches SET payload=? WHERE id=?',(json.dumps(item),item['id']))
    return {**watches(),'added':added}

def remove_watch(ident):
    with WATCH_LOCK,connect() as c:
        c.execute('DELETE FROM watches WHERE id=?',(ident,));c.execute('DELETE FROM seen WHERE watch=?',(ident,));c.execute('DELETE FROM notices WHERE watch=?',(ident,))

def read_notice(ident):
    with connect() as c:c.execute('UPDATE notices SET read=1 WHERE id=?',(ident,))

async def guide(ra,dec,radius,question):
    nearby=await asyncio.to_thread(coverage_guide.nearby,ra,dec,'both',radius,8)
    objects=await object_map.objects(ra,dec,min(radius,.2))
    records=nearby['rows'];q=question.lower();claims=[]
    for o in objects.get('rows',[])[:6]:claims.append({'text':o['summary'],'source_title':o['name']+' · '+o['catalog'],'source_url':o['source_url']})
    for o in records[:5]:claims.append({'text':f"{o['mission']} observation {o.get('observation') or o['title']}, filter {o.get('filters') or 'not reported'}. {'Its reported footprint contains the view center.' if o.get('contains_view_center') else 'Its pointing is nearby; center coverage is not established.'}",'source_title':o['title']+' · MAST','source_url':o['source_url']})
    if any(k in q for k in ['new','discover','candidate','planet','change']):answer='These records cannot establish a new star or exoplanet. Check the original-data fit flags and uncertainty, detector masks, epoch-matched catalog associations and independent observations. A repeating transit signal also needs blend and false-positive checks.'
    elif any(k in q for k in ['cover','image','observ','filter']):answer=f"The local index returned {len(records)} nearby pointings, with {nearby.get('containing_footprints_in_candidates',0)} indexed footprints containing this position. The source records below identify actual telescope/filter combinations. Coverage does not guarantee finite science pixels."
    elif not q or any(k in q for k in ['looking','here','field','what']):answer='This field guide combines catalog descriptions and public archive records at your current sky position. Each statement below links to its source; unknown distance, composition or identity is left unresolved.'
    else:answer='This record-based guide cannot substantiate that question from the returned field metadata. Open the linked catalog references and original observation records for further research.'
    return {'answer':answer,'claims':claims,'observations':records,'objects':objects.get('rows',[]),'context':{'ra':ra,'dec':dec,'radius':radius},'fetched_at':remote.now(),'catalog_stale':objects.get('stale'),'catalog_available':objects.get('catalog_available'),'note':'Source-grounded record guide, generated locally without an LLM. It does not infer chemistry, physical distances or novelty from displayed pixels. Catalog records link to their literature references; unseen papers are not summarized.'}
