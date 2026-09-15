"""Nearby real archive pointings and conservative spherical footprint checks."""
import functools
import json
import math
import re
from urllib.parse import quote

import numpy as np
from astropy.time import Time
import recent_archive as archive
import webb_gallery as gallery


def vector(ra,dec):
    r,d=np.radians([ra,dec]);return np.array([math.cos(d)*math.cos(r),math.cos(d)*math.sin(r),math.sin(d)])


def separation(ra,dec,other_ra,other_dec):
    a=vector(ra,dec);b=vector(other_ra,other_dec)
    return math.degrees(math.atan2(np.linalg.norm(np.cross(a,b)),np.dot(a,b)))


@functools.lru_cache(maxsize=4096)
def footprint(region):
    """MAST s_region is ICRS degrees; do not guess other coordinate frames."""
    tokens=(region or '').strip().split()
    if not tokens:return None
    kind=tokens.pop(0).upper()
    if tokens and tokens[0].upper()=='ICRS':tokens.pop(0)
    try:values=np.array([float(v) for v in tokens])
    except ValueError:return None
    if not np.all(np.isfinite(values)):return None
    if kind=='CIRCLE' and len(values)==3:
        ra,dec,radius=values
        if not(0<=ra<=360 and -90<=dec<=90 and 0<radius<=180):return None
        return {'kind':'circle','center':vector(ra,dec),'ra':float(ra%360),'dec':float(dec),'radius':float(radius)}
    if kind!='POLYGON' or len(values)<6 or len(values)%2:return None
    positions=values.reshape(-1,2)
    if np.any((positions[:,0]<0)|(positions[:,0]>360)|(positions[:,1]<-90)|(positions[:,1]>90)):return None
    if np.allclose(positions[0],positions[-1],rtol=0,atol=1e-12):positions=positions[:-1]
    if len(positions)<3:return None
    verts=np.array([vector(r,d) for r,d in positions]);center=verts.mean(axis=0)
    if np.linalg.norm(center)<1e-8:return None
    center/=np.linalg.norm(center)
    dots=verts@center
    # Gnomonic projection preserves great-circle edges. Ambiguous, very large
    # polygons are explicitly unsupported, never interpreted as small images.
    if np.min(dots)<math.cos(math.radians(80)):return None
    east=np.cross([0,0,1] if abs(center[2])<.99 else [1,0,0],center);east/=np.linalg.norm(east)
    north=np.cross(center,east)
    xy=np.column_stack((verts@east/dots,verts@north/dots))
    area=np.sum(xy[:,0]*np.roll(xy[:,1],-1)-xy[:,1]*np.roll(xy[:,0],-1))
    if abs(area)<1e-16:return None
    return {'kind':'polygon','center':center,'east':east,'north':north,'xy':xy,
            'ra':float(math.degrees(math.atan2(center[1],center[0]))%360),'dec':float(math.degrees(math.asin(center[2]))),
            'radius':float(np.degrees(np.arccos(np.clip(dots,-1,1))).max())}


def contains(shape,ra,dec):
    if shape is None:return None
    v=vector(ra,dec)
    if shape['kind']=='circle':return bool(np.dot(v,shape['center'])>=math.cos(math.radians(shape['radius']))-1e-13)
    z=np.dot(v,shape['center'])
    if z<=0:return False
    x,y=np.dot(v,shape['east'])/z,np.dot(v,shape['north'])/z
    inside=False
    poly=shape['xy']
    for (ax,ay),(bx,by) in zip(poly,np.roll(poly,-1,axis=0)):
        dx,dy=bx-ax,by-ay
        length=math.hypot(dx,dy)
        if length and abs((x-ax)*dy-(y-ay)*dx)/length<1e-10 and min(ax,bx)-1e-10<=x<=max(ax,bx)+1e-10 and min(ay,by)-1e-10<=y<=max(ay,by)+1e-10:return True
        if (ay>y)!=(by>y) and x<(bx-ax)*(y-ay)/(by-ay)+ax:inside=not inside
    return inside


def observation_media(o):
    shape=footprint(o.get('s_region'))
    date=Time(o['t_min'],format='mjd').utc.isot+'Z' if o.get('t_min') is not None else None
    return {'kind':'mast','id':str(o.get('record_id') or o.get('objID') or o['obsid']),
            'observation':o['obs_id'],
            'title':o.get('target_name') or o['obs_id'],'ra':o['s_ra'],'dec':o['s_dec'],
            'fov':min(15,max(.01,shape['radius']*2.8)) if shape else .1,'survey':'optical',
            'description':o.get('obs_title') or 'Public calibrated science image observation.',
            'preview_url':'/api/archive-preview?uri='+quote(o['jpegURL'],safe='') if o.get('jpegURL') else None,
            'source_url':'https://mast.stsci.edu/portal/Mashup/Clients/Mast/Portal.html?searchQuery='+quote(json.dumps({'service':'CAOM','inputText':str(o['obs_id'])}),safe=''),
            'mission':o['obs_collection'],'instrument':o.get('instrument_name'),'filters':o.get('filters'),'observed_at':date,
            'footprint':o.get('s_region'),'footprint_supported':shape is not None,'moving_target':bool(o.get('mtFlag')),
            'location_note':'Archive pointing in ICRS. The preview is shown separately; use original FITS to project calibrated pixels.',
            'credit':'MAST / NASA, ESA, CSA, STScI and the observing team. Retain the original product credit.',
            'available':True}


def gallery_media(p):
    return {'kind':'gallery','id':p['id'],'title':p['title'],'ra':p['ra'],'dec':p['dec'],'fov':.18,'survey':'optical',
            'description':p['description'],'preview_url':p['image_url'],'source_url':p['source_url'],'mission':'NASA Webb release',
            'published_at':p.get('posted'),'classification':p.get('kind'),'location_note':(p.get('location') or {}).get('note','Sky location unverified.'),
            'credit':'NASA Webb / Flickr. Publisher caption and reuse terms are retained in Image journeys.',
            'available':True}


def nearby(ra,dec,mission='both',radius=10,limit=8):
    import coverage_index
    result=coverage_index.nearby_candidates(ra,dec,mission,radius,limit)
    selected=[]
    for inside,distance,o in result['rows']:
        media=observation_media(o)
        media.update(distance_deg=distance,contains_view_center=inside,coverage_label='Inside archive footprint' if inside else 'Nearby pointing')
        selected.append(media)
    releases=[]
    if mission!='hubble':
        for p in gallery.map_points()['rows']:
            distance=separation(ra,dec,p['ra'],p['dec'])
            if distance<=radius:releases.append((distance,p))
        releases.sort(key=lambda v:v[0])
    gallery_rows=[]
    for distance,p in releases:
        if any(separation(p['ra'],p['dec'],m['ra'],m['dec'])<.012 for m in gallery_rows):continue
        m=gallery_media(gallery.photo(p['id']));m.update(distance_deg=distance,contains_view_center=None,coverage_label='Published target location')
        gallery_rows.append(m)
        if len(gallery_rows)>=3:break
    with archive.connect() as c:complete=archive.setting(c,'complete',{})
    return {'rows':selected,'releases':gallery_rows,'ra':ra,'dec':dec,'radius':radius,'mission':mission,'generation':result['generation'],
            'indexed_pointings_in_radius':result['total'],'candidate_records_checked':result['tested']+len(selected),'supported_footprints_checked':result['tested'],
            'containing_footprints_in_candidates':result['containing'],'sample_limited':False,'coverage_index_ready':result['ready'],'index_updated_at':complete.get('completed_at'),
            'note':('Full spatial index: all supported footprints are searched for containment, including observations whose pointing center lies outside the selected radius. Nearby pointings are ranked across the full local index. ' if result['ready'] else 'Full footprint index is building; nearest pointings use the full local index while coverage checks are limited to the returned rows. ')+
            'Moving targets are excluded. Footprints do not guarantee valid pixels or coverage in a displayed HiPS survey. Separate regions are shown at least 0.012 degrees apart.'}
