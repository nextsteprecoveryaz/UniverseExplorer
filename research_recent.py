import asyncio, json, re, sys, subprocess
from pathlib import Path
import httpx
from astropy.time import Time

async def main():
    out=Path('data/research'); out.mkdir(exist_ok=True,parents=True)
    async with httpx.AsyncClient(timeout=90,follow_redirects=True,headers={'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36'}) as c:
        async def mast(tel):
            filters=[{'paramName':k,'values':v} for k,v in [('obs_collection',[tel]),('dataproduct_type',['image']),('dataRights',['PUBLIC']),('calib_level',[2,3]),('intentType',['science']),('t_min',[{'min':float(Time('2022-01-01').mjd),'max':float(Time.now().mjd)}])]]
            from recent_archive import FIELDS
            req={'service':'Mast.Caom.Filtered','params':{'columns':FIELDS if '--columns' in sys.argv else '*','filters':filters},'format':'json','pagesize':2,'page':1}
            r=await c.get('https://mast.stsci.edu/api/v0/invoke',params={'request':json.dumps(req)})
            (out/f'recent-{tel}.json').write_text(r.text,encoding='utf-8')
            d=r.json(); print(tel,r.status_code,d.get('status'),d.get('paging'),json.dumps(d.get('data'))[:2300],flush=True)
        async def flickr():
            for name,url in [('flickr-album','https://www.flickr.com/photos/nasawebbtelescope/albums/72177720331299130/'),('flickr-extra','https://www.flickr.com/photos/nasawebbtelescope/albums/72177720332131144/'),('flickr-stream','https://www.flickr.com/photos/nasawebbtelescope/'),('flickr-photo','https://www.flickr.com/photos/nasawebbtelescope/52506574684/')]:
                r=await c.get(url);(out/f'{name}.html').write_text(r.text,encoding='utf-8')
                print(name,r.status_code,len(r.content),[(m.start(),r.text[max(0,m.start()-80):m.start()+220]) for m in list(re.finditer('modelExport|photoset|photoPage|totalItems|totalPages|pagination|modelData',r.text))[:15]],flush=True)
        if '--sed' in sys.argv:
            from astropy.table import Table
            import io
            r=await c.get('https://vizier.cfa.harvard.edu/viz-bin/sed',params={'-c':'HD100','-c.rs':5})
            (out/'photometry-HD100.xml').write_bytes(r.content)
            print('SED',r.status_code,len(r.content),r.text[:1200],flush=True)
            t=Table.read(io.BytesIO(r.content),format='votable');print(t.colnames,flush=True);print(t[:2],flush=True)
        elif '--last' in sys.argv:
            from webb_gallery import fetch_listing
            base='https://www.flickr.com/photos/nasawebbtelescope/'
            from integrations import now
            for url in [base+'page45/?refresh=20260914',base+'page45/?_='+now(),base+'with/4666225899/?refresh=20260914']:
                rows,total=await fetch_listing(url);print(url,'total',total,'rows',len(rows),'first',rows[0]['id'] if rows else None,flush=True)
                if rows:
                    full,count=await fetch_listing(base+'with/'+str(rows[0]['id'])+'/');print('WITH',count,len(full),flush=True)
        elif '--columns' in sys.argv: await mast('JWST')
        elif '--curl' in sys.argv or '--paging' in sys.argv or '--with' in sys.argv:
            urls=['https://www.flickr.com/photos/nasawebbtelescope/albums/72177720332131144/','https://flickr.com/photos/nasawebbtelescope/','https://www.flickr.com/photos/nasawebbtelescope/albums/72177720331299130/page1']
            if '--paging' in sys.argv:
                base='https://www.flickr.com/photos/nasawebbtelescope/albums/72177720331299130/'
                urls=[base+'page2',base+'?page=2&per_page=25',base+'page2/?per_page=25',base+'?per_page=100',base+'with/55380623885/']
            if '--with' in sys.argv:
                urls=['https://www.flickr.com/photos/nasawebbtelescope/albums/72177720332131144/page2/','https://www.flickr.com/photos/nasawebbtelescope/albums/72177720332131144/with/55254438042/','https://www.flickr.com/photos/nasawebbtelescope/with/52506574684/','https://www.flickr.com/photos/nasawebbtelescope/page2/']
            for url in urls:
                p=await asyncio.to_thread(subprocess.run,['curl.exe','-L','--max-time','45','-A','Mozilla/5.0',url],capture_output=True)
                print('CURL',url,p.returncode,len(p.stdout),p.stdout[:100],flush=True)
                if len(p.stdout)>10000:
                    d=json.JSONDecoder().raw_decode(p.stdout.decode().split('modelExport: ',1)[1])[0]
                    (out/('flickr-stream-models.json' if url.startswith('https://flickr.com/') else 'flickr-extra-models.json' if '32131144' in url else 'flickr-models.json')).write_text(json.dumps(d),encoding='utf-8')
                    def walk(v):
                        if isinstance(v,dict):
                            if 'totalItems' in v: print('LIST',v.keys(),v['totalItems'],len(v.get('_data',[])),str(v.get('_data',[])[0])[:130] if v.get('_data') else '',flush=True)
                            for x in v.values():walk(x)
                        elif isinstance(v,list):
                            for x in v:walk(x)
                    walk(d['main'])
        elif '--flickr' in sys.argv: await flickr()
        else: await asyncio.gather(mast('HST'),mast('JWST'),flickr())

asyncio.run(main())
