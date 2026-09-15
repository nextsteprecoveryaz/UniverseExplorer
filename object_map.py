"""Featured object stories plus a bounded, live SIMBAD cone search."""
import math
from urllib.parse import quote
import integrations as remote

FEATURED=[
 {'id':'pillars','name':'Pillars of Creation','ra':274.730583,'dec':-13.844944,'fov':.073,'survey':'webb-color','type':'Star-forming region',
  'summary':'These dense towers of gas and dust are part of the Eagle Nebula. Infrared observations reveal young stars around and within the clouds. Compare Webb and Hubble views to see how wavelength changes the structures visible to us.',
  'source_url':'https://esawebb.org/images/weic2216a/','video_title':'Zoom into the Pillars of Creation','video_kind':'Image-based zoom through astronomical observations',
  'video_url':'https://cdn.esawebb.org/archives/videos/medium_podcast/weic2216d.mp4','video_page':'https://esawebb.org/videos/weic2216d/'},
 {'id':'carina','name':'Carina · Cosmic Cliffs','ra':159.216,'dec':-58.621,'fov':.15,'survey':'webb-color','type':'Stellar nursery',
  'summary':'The Cosmic Cliffs trace the edge of a star-forming cloud in NGC 3324. Webb reveals young stars and outflows obscured by dust. Molecular-hydrogen emission helps researchers locate jets from forming stars.',
  'source_url':'https://esawebb.org/videos/carina_revisit_pan/','video_title':'Diving into the Cosmic Cliffs','video_kind':'Annotated tour of Webb observations',
  'video_url':'https://cdn.esawebb.org/archives/videos/medium_podcast/carina_revisit_pan.mp4','video_page':'https://esawebb.org/videos/carina_revisit_pan/'},
 {'id':'orion','name':'Orion Nebula','ra':83.82208,'dec':-5.39111,'fov':1.2,'survey':'optical','type':'Star-forming nebula',
  'summary':'Orion is a nearby laboratory for studying star formation. Young stars illuminate the surrounding gas, while dense clouds hide other forming stars. The accompanying journey interprets telescope data as a three-dimensional visualization.',
  'source_url':'https://esahubble.org/videos/orion-nebula-journey/','video_title':'Orion Nebula journey','video_kind':'3D scientific visualization based on telescope data',
  'video_url':'https://cdn.esahubble.org/archives/videos/dome_preview/orion-nebula-journey.mp4','video_page':'https://esahubble.org/videos/orion-nebula-journey/'},
 {'id':'quintet','name':'Stephan’s Quintet','ra':339.01,'dec':33.958,'fov':.15,'survey':'webb-color','type':'Galaxy grouping',
  'summary':'Five galaxies appear close together in this field. Four form an interacting group; the fifth is a foreground galaxy. Webb infrared views reveal dust, star formation, and structures shaped by galaxy interactions.',
  'source_url':'https://esawebb.org/videos/weic2208b/','video_title':'Stephan’s Quintet in mid-infrared light','video_kind':'Pan across a Webb MIRI observation',
  'video_url':'https://cdn.esawebb.org/archives/videos/medium_podcast/weic2208b.mp4','video_page':'https://esawebb.org/videos/weic2208b/'},
 {'id':'andromeda','name':'Andromeda Galaxy','ra':10.68471,'dec':41.26875,'fov':3,'survey':'optical','type':'Spiral galaxy · M31',
  'summary':'Andromeda is a neighboring spiral galaxy. Hubble’s panoramic observations resolve crowded stellar fields, clusters, and dust across its disk. Individual patches in the archive offer a closer look at this galaxy’s stellar population.',
  'source_url':'https://esahubble.org/videos/heic2501a/','video_title':'Tour of Hubble’s Andromeda panorama','video_kind':'Tour of a telescope-image mosaic',
  'video_url':'https://cdn.esahubble.org/archives/videos/hd_1080p25_screen/heic2501a.mp4','video_page':'https://esahubble.org/videos/heic2501a/'},
 {'id':'trappist','name':'TRAPPIST-1','ra':346.622,'dec':-5.041,'fov':.2,'survey':'optical','type':'Ultracool dwarf · known planet host',
  'summary':'Seven known planets orbit this small, cool star. Their transits let astronomers study planet sizes and orbital periods. The sky map shows the stellar field; the planets and their surfaces in the video are artist’s impressions.',
  'source_url':'https://www.eso.org/public/videos/eso1706d/','video_title':'A tour of the TRAPPIST-1 system','video_kind':'Artist’s impression — not resolved planet imagery',
  'video_url':'https://cdn.eso.org/videos/medium_podcast/eso1706d.mp4','video_page':'https://www.eso.org/public/videos/eso1706d/'},
]
for obj in FEATURED:
 obj.update(catalog='Featured guide',featured=True,credit='Full observing, visualization, and music credits are on the linked publisher page.')

TYPE_NAMES={'*':'Star','**':'Double or multiple star','Y*O':'Young stellar object','Y*?':'Young stellar object candidate','TT*':'T Tauri star','Em*':'Emission-line star','IR':'Infrared source','G':'Galaxy','GiG':'Galaxy in a group','GPair':'Galaxy pair','HII':'Ionized hydrogen region','H2O':'Molecular cloud','Cl*':'Star cluster','OpC':'Open star cluster','PN':'Planetary nebula','SNR':'Supernova remnant','QSO':'Quasar','Pl':'Planet','PM*':'High proper-motion star','V*':'Variable star','V*?':'Variable star candidate','SB*':'Spectroscopic binary','EB*':'Eclipsing binary','X':'X-ray source','Radio':'Radio source','RNe':'Reflection nebula','DNe':'Dark nebula'}

def separation(ra,dec,other_ra,other_dec):
 r,d,r2,d2=map(math.radians,(ra,dec,other_ra,other_dec))
 a=math.sin((d2-d)/2)**2+math.cos(d)*math.cos(d2)*math.sin((r2-r)/2)**2
 return math.degrees(2*math.asin(math.sqrt(min(1,max(0,a)))))

# Preserve unknown catalog classifications verbatim instead of guessing their meaning.
TYPE_NAMES.pop('H2O',None)
TYPE_NAMES.update({'Rad':'Radio source','smm':'Submillimeter source'})

async def objects(ra,dec,radius):
 ra,dec,radius=round(ra,6),round(dec,6),round(radius,4)
 featured=[o for o in FEATURED if separation(ra,dec,o['ra'],o['dec'])<=radius]
 query=f"SELECT TOP 121 main_id,ra,dec,otype,DISTANCE(POINT('ICRS',ra,dec),POINT('ICRS',{ra},{dec})) AS angular_sep FROM basic WHERE 1=CONTAINS(POINT('ICRS',ra,dec),CIRCLE('ICRS',{ra},{dec},{radius})) ORDER BY angular_sep"
 try:
  data=await remote.remote_json('https://simbad.cds.unistra.fr/simbad/sim-tap/sync',params={'request':'doQuery','lang':'adql','format':'json','query':query},ttl=86400)
  rows=data['data']['data']; names=[m['name'] for m in data['data']['metadata']]
  result=[]
  for values in rows[:120]:
   r=dict(zip(names,values));name=r['main_id'];kind=TYPE_NAMES.get(r['otype'],'Catalog object')
   url='https://simbad.cds.unistra.fr/simbad/sim-id?Ident='+quote(name,safe='')
   result.append({'id':'simbad:'+name,'name':name,'ra':r['ra'],'dec':r['dec'],'type':kind,'type_code':r['otype'],'catalog':'SIMBAD','featured':False,'source_url':url,
    'summary':f"SIMBAD lists {name} as {kind.lower()} (classification {r['otype']}). This marker uses its catalog position, which may differ from an image taken at another epoch. Open the catalog record for measurements, aliases, and published references. A catalog entry does not mean this particular image resolves the object.",
    'fetched_at':data['fetched_at'],'stale':data['stale']})
  return {'rows':featured+result,'radius':radius,'truncated':len(rows)>120,'fetched_at':data['fetched_at'],'stale':data['stale'],'catalog_available':True}
 except (ValueError,KeyError,TypeError) as exc:
  return {'rows':featured,'radius':radius,'truncated':False,'catalog_available':False,'stale':False,'warning':'SIMBAD could not be reached. Featured guide objects remain available.'}
