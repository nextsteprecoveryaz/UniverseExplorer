"""VizieR SED measurements with original units, uncertainties, and provenance."""
import hashlib
import io
import json
import time
from pathlib import Path
from urllib.parse import urlencode

import httpx
import numpy as np
from astropy import units as u
from astropy.io.votable import parse

from integrations import now,number

DIRECTORY=Path(__file__).parent/'data'/'photometry'
ENDPOINTS=['https://vizier.cds.unistra.fr/viz-bin/sed','https://vizier.cfa.harvard.edu/viz-bin/sed']
NOTE='These are catalog measurements within the search radius. They can include different objects, apertures and epochs; they are not automatically a single-object spectrum. No extinction correction is applied by this app.'

def parse_sed(content):
    if b'<VOTABLE' not in content[:5000].upper():raise ValueError('VizieR returned a web page instead of a VOTable.')
    document=parse(io.BytesIO(content),verify='warn')
    infos=list(document.infos)
    for resource in document.resources:infos.extend(resource.infos)
    errors=[str(v.content or v.value) for v in infos if v.name and v.name.upper()=='QUERY_STATUS' and str(v.value).upper()=='ERROR']
    if errors:raise ValueError('VizieR query failed: '+'; '.join(errors))
    tables=list(document.iter_tables())
    if not tables:return {'rows':[],'columns':[],'truncated':False,'catalogs':[]}
    rows=[];columns=[]
    for table in tables:
        # VizieR FIELD IDs are sed_freq/sed_flux; human names may have an extra
        # underscore. The documented API uses IDs (Astropy's default).
        t=table.to_table(use_names_over_ids=False)
        if not {'sed_freq','sed_flux'} <= set(t.colnames):continue
        if not columns:columns=[{'name':n,'unit':str(t[n].unit or ''),'description':t[n].description or ''} for n in t.colnames]
        def value(row,name):
            if name not in t.colnames or np.ma.is_masked(row[name]):return None
            v=row[name]
            if isinstance(v,bytes):return v.decode('utf-8',errors='replace')
            v=v.item() if isinstance(v,np.generic) else v
            return None if isinstance(v,float) and not np.isfinite(v) else v
        for row in t:
            def converted(name,unit):
                n=number(value(row,name))
                if n is None:return None
                original=t[name].unit
                return float((n*(original or unit)).to_value(unit))
            catalog=str(value(row,'_tabname') or '')
            item={'frequency_ghz':converted('sed_freq',u.GHz),'flux_jy':converted('sed_flux',u.Jy),
                  'error_jy':converted('sed_eflux',u.Jy) if 'sed_eflux' in t.colnames else None,
                  'filter':str(value(row,'sed_filter') or ''),'catalog':catalog,'identifier':str(value(row,'_ID') or ''),
                  'ra':number(value(row,'_RAJ2000')),'dec':number(value(row,'_DEJ2000')),
                  'time_jd':number(value(row,'_time')),'catalog_url':'https://vizier.cds.unistra.fr/viz-bin/VizieR?'+urlencode({'-source':catalog}),
                  'raw':{name:value(row,name) for name in t.colnames}}
            item['wavelength_um']=299792.458/item['frequency_ghz'] if item['frequency_ghz'] and item['frequency_ghz']>0 else None
            rows.append(item)
    if not columns:raise ValueError('The VOTable did not contain the expected VizieR photometry columns.')
    truncated=any(str(v.value).upper()=='OVERFLOW' for v in infos)
    return {'rows':rows,'columns':columns,'truncated':truncated,'catalogs':sorted(set(r['catalog'] for r in rows))}

async def query(target,radius,refresh=False):
    DIRECTORY.mkdir(parents=True,exist_ok=True)
    target=target.strip()
    if not target:raise ValueError('Enter a target name or sky coordinates.')
    key=hashlib.sha256(json.dumps([target,float(radius)]).encode()).hexdigest()
    raw_path=DIRECTORY/(key+'.vot');json_path=DIRECTORY/(key+'.json')
    cached=json.loads(json_path.read_text(encoding='utf-8')) if json_path.exists() else None
    if cached and not refresh and time.time()-json_path.stat().st_mtime<86400:return {**cached,'cached':True,'stale':False}
    attempts=[]
    for endpoint in ENDPOINTS:
        try:
            params={'-c':target,'-c.rs':radius}
            buf=bytearray()
            async with httpx.AsyncClient(timeout=httpx.Timeout(100,connect=15),follow_redirects=True) as client:
                async with client.stream('GET',endpoint,params=params) as response:
                    response.raise_for_status()
                    async for chunk in response.aiter_bytes():
                        buf.extend(chunk)
                        if len(buf)>20*1024*1024:raise ValueError('Photometry response exceeds 20 MB. Reduce the search radius.')
            content=bytes(buf)
            data=parse_sed(content)
            result={**data,'target':target,'radius_arcsec':radius,'fetched_at':now(),'source_url':endpoint+'?'+urlencode(params),'source':'VizieR / CDS'+(' · Harvard mirror' if 'harvard' in endpoint else ''),
                    'cached':False,'stale':False,'fallback':bool(attempts),'key':key,'votable_url':'/api/photometry/files/'+key+'.vot','note':NOTE}
            temp=raw_path.with_suffix('.vot.tmp');temp.write_bytes(content);temp.replace(raw_path)
            temp=json_path.with_suffix('.json.tmp');temp.write_text(json.dumps(result,allow_nan=False),encoding='utf-8');temp.replace(json_path)
            return result
        except (httpx.HTTPError,ValueError) as e:attempts.append(str(e))
    if cached:return {**cached,'cached':True,'stale':True,'warning':'VizieR refresh failed. Showing the previous saved measurements.'}
    raise ValueError('VizieR photometry could not be retrieved from CDS or its Harvard mirror. Try again or use a smaller radius. '+attempts[-1])

def votable(key):
    if len(key)!=64 or any(c not in '0123456789abcdef' for c in key):raise ValueError('Invalid photometry record.')
    path=DIRECTORY/(key+'.vot')
    if not path.exists():raise ValueError('Query photometry before exporting its VOTable.')
    return path
