import asyncio, json, re, sys
from pathlib import Path
from urllib.parse import urljoin
import httpx

PAGES={
 'pillars':'https://esawebb.org/videos/weic2216d/',
 'carina':'https://esawebb.org/videos/carina_revisit_pan/',
 'quintet':'https://esawebb.org/videos/weic2208b/',
 'orion':'https://esahubble.org/videos/orion-nebula-journey/',
 'andromeda':'https://esahubble.org/videos/heic2501a/',
 'trappist':'https://www.eso.org/public/videos/eso1706d/',
}
async def main():
 async with httpx.AsyncClient(timeout=35,follow_redirects=True) as c:
  async def page(key,url):
   r=await c.get(url);r.raise_for_status()
   urls=list(dict.fromkeys(urljoin(url,u) for u in re.findall(r'(?:href|src)=[\"\x27]([^\"\x27]+\.mp4)[\"\x27]',r.text)))
   chosen=next((u for u in urls if 'medium' in u),next((u for u in urls if 'hd720' in u),urls[0] if urls else None))
   result={'page':url,'video':chosen,'options':urls}
   if chosen:
    h=await c.head(chosen);result['status']=h.status_code;result['content_type']=h.headers.get('content-type')
   print(key,json.dumps(result))
   return key,result
  results=[] if '--catalog-only' in sys.argv else await asyncio.gather(*(page(k,u) for k,u in PAGES.items()),return_exceptions=True)
  valid=dict(r for r in results if not isinstance(r,Exception))
  for r in results:
   if isinstance(r,Exception):print(type(r).__name__,str(r))
  if valid:Path('data/research/mapping-media.json').write_text(json.dumps(valid,indent=2))
  q="SELECT TOP 121 main_id,ra,dec,otype,DISTANCE(POINT('ICRS',ra,dec),POINT('ICRS',274.730583,-13.844944)) AS angular_sep FROM basic WHERE 1=CONTAINS(POINT('ICRS',ra,dec),CIRCLE('ICRS',274.730583,-13.844944,0.0511)) ORDER BY angular_sep"
  r=await c.get('https://simbad.cds.unistra.fr/simbad/sim-tap/sync',params={'request':'doQuery','lang':'adql','format':'json','query':q})
  print('SIMBAD',r.status_code,r.text[:2400])
  if r.is_success:Path('data/research/simbad-mapping.json').write_text(r.text)
asyncio.run(main())
