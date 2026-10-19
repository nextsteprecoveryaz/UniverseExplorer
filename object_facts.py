"""Named SIMBAD measurements, with references kept separate from spoken prose."""
import re
from urllib.parse import quote
from astropy.coordinates import SkyCoord
import astropy.units as u
import integrations as remote
import object_map

TAP='https://simbad.cds.unistra.fr/simbad/sim-tap/sync'
CONSTELLATIONS='https://docs.astropy.org/en/stable/api/astropy.coordinates.get_constellation.html'
FIELDS='b.main_id,b.ra,b.dec,b.otype,b.morph_type,b.morph_bibcode,b.sp_type,b.sp_bibcode,b.rvz_redshift,b.rvz_bibcode,b.galdim_majaxis,b.galdim_minaxis,b.galdim_bibcode,b.plx_value,b.plx_err,b.plx_bibcode'


async def lookup(name):
    name=' '.join(str(name).split())
    if not name or len(name)>200:return None
    query=(f"SELECT TOP 32 {FIELDS},d.dist,d.unit,d.method,d.bibcode,d.minus_err,d.plus_err,d.qual "
           "FROM basic AS b JOIN ident AS i ON b.oid=i.oidref LEFT JOIN mesDistance AS d ON b.oid=d.oidref "
           "WHERE i.id='"+name.replace("'","''")+"' ORDER BY bibcode DESC")
    result=await remote.remote_json(TAP,params={'request':'doQuery','lang':'adql','format':'json','query':query},ttl=7*86400)
    keys=[m['name'].lower() for m in result['data']['metadata']]
    rows=[dict(zip(keys,row)) for row in result['data']['data']]
    if not rows:return None
    r=rows[0];identifier=r['main_id'];url='https://simbad.cds.unistra.fr/simbad/sim-id?Ident='+quote(identifier,safe='')
    measurements=[{k:x.get(k) for k in ('dist','unit','method','bibcode','minus_err','plus_err','qual')} for x in rows if remote.number(x.get('dist')) is not None]
    return {'id':'simbad:'+identifier,'name':' '.join(identifier.split()),'ra':r['ra'],'dec':r['dec'],
            'type':object_map.TYPE_NAMES.get(r['otype'],'Catalog object'),'type_code':r['otype'],'catalog':'SIMBAD','source_url':url,
            'measurements':r,'distances':measurements,'constellation':SkyCoord(r['ra']*u.deg,r['dec']*u.deg,frame='icrs').get_constellation(),
            'fetched_at':result['fetched_at'],'stale':result['stale']}


def morphology(code):
    """Translate only unambiguous common forms; preserve uncertain classifications."""
    c=str(code or '').upper().replace(' ','').replace('SO','S0')
    if not c:return None
    if ':' in c or '?' in c or '/' in c:return None
    if c.startswith(('S0-A','S0A','SA0/A','SAB0/A','SB0/A')):return 'a galaxy with a transitional lenticular-to-spiral classification'
    if c.startswith(('S0','SA0','SAB0','SB0')):return 'a lenticular galaxy'
    if re.match(r'^E[0-9]?$',c):return 'an elliptical galaxy'
    if re.match(r'^(S[AB]*)(\(.*\))?[ABCDM]',c):return 'a spiral galaxy'
    if c.startswith(('IRR','IM')):return 'an irregular galaxy'
    return None


def light_years(value):
    if value>=1e9:return f'{value/1e9:.2g} billion light-years'
    if value>=1e6:return f'{value/1e6:.3g} million light-years'
    return f'{value:,.0f} light-years'


def prose(detail):
    """Readable plain text only: no markup, URLs or bibliography read aloud."""
    r=detail['measurements'];sources=[{'title':detail['name']+' · SIMBAD measurements','url':detail['source_url']},
                                   {'title':'Constellation boundaries · Astropy / IAU','url':CONSTELLATIONS}]
    def cite(code,title):
        if code:sources.append({'title':title+' · '+code,'url':'https://ui.adsabs.harvard.edu/abs/'+quote(code,safe='')+'/abstract'})
    kind=morphology(r.get('morph_type'))
    identity=kind or ('an '+detail['type'].lower() if detail['type'][:1].lower() in 'aeiou' else 'a '+detail['type'].lower())
    paragraphs=[f"{detail['name']} is {identity} in the constellation {detail['constellation']}."]
    if r.get('morph_type'):
        cite(r.get('morph_bibcode'),'Morphology reference')
        if not kind:paragraphs.append(f"Its recorded morphological classification is {r['morph_type']}. Catalog qualifiers are retained because this classification is not more certain than its source.")
    valid=[d for d in detail.get('distances',[]) if str(d.get('unit') or '').strip() in ('pc','kpc','Mpc') and (remote.number(d.get('dist')) or 0)>0 and d.get('bibcode') and d.get('qual') not in ('<','>')]
    if valid:
        # Keep the literature's method and epoch, rather than silently presenting
        # one measurement as the unique or definitive distance.
        d=valid[0];ly=remote.number(d['dist'])*{'pc':1,'kpc':1e3,'Mpc':1e6}[d['unit'].strip()]*3.261563777
        method='redshift-based ' if 'redshift' in str(d.get('method','')).lower() else ''
        year=d['bibcode'][:4] if re.match(r'^\d{4}',d['bibcode']) else None
        paragraphs.append(f"A published {method}distance estimate"+(f" from {year}" if year else '')+f" places it at roughly {light_years(ly)}. Distance estimates can differ with the method and assumptions used.")
        cite(d['bibcode'],'Distance reference')
    if detail['type_code']=='EmG':paragraphs.append('It is also cataloged as an emission-line galaxy: its spectrum contains bright lines that help astronomers investigate emitting material. The catalog label alone does not tell us what powers those lines.')
    major=remote.number(r.get('galdim_majaxis'));minor=remote.number(r.get('galdim_minaxis'))
    if major and minor and major>0 and minor>0:
        paragraphs.append(f"Its cataloged apparent extent is about {major:.2g} by {minor:.2g} arcminutes. That is an angular size on the sky, and can vary with the wavelength and measurement method.")
        cite(r.get('galdim_bibcode'),'Angular size reference')
    if r.get('sp_type'):
        paragraphs.append(f"Its cataloged stellar spectral type is {r['sp_type']}. Spectral classifications describe patterns in the light and help astronomers compare stars.")
        cite(r.get('sp_bibcode'),'Spectral type reference')
    if kind and 'lenticular' in kind:
        paragraphs.append('Lenticular galaxies have a central bulge and a disk, with less prominent spiral structure than spiral galaxies. Compare the bright center with the faint outer light, then switch wavelengths to see how their contrast changes.')
        sources.append({'title':'NASA · Galaxy types','url':'https://science.nasa.gov/universe/galaxies/types/'})
    return '\n\n'.join(paragraphs),list({s['url']:s for s in sources}.values())
