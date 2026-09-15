import asyncio
import json
from pathlib import Path

import numpy as np
import pytest
from astropy.table import MaskedColumn,Table
from astropy import units as u

import recent_archive as recent
import webb_gallery as gallery
import photometry

@pytest.fixture
def archive(tmp_path,monkeypatch):
    monkeypatch.setattr(recent,'PATH',tmp_path/'archive.sqlite3')
    monkeypatch.setattr(recent,'_coordinates',None)
    monkeypatch.setattr(recent,'_task',None)
    return recent

def observation(objid,obsid=100,mission='JWST',ra=0,dec=0):
    return {'objID':objid,'obsid':obsid,'obs_id':'example','obs_collection':mission,'s_ra':ra,'s_dec':dec,'t_min':61000,'target_name':'target','filters':'F200W'}

def test_all_pages_and_distinct_caom_rows(archive,monkeypatch):
    seen=[]
    async def fetch(client,mission,end,page):
        seen.append((mission,page))
        # Different CAOM records can share the product-group obsid.
        rows=[observation((1 if mission=='JWST' else 10)+page,mission=mission)]
        return {'data':rows,'paging':{'rowsFiltered':2,'pagesFiltered':2}}
    monkeypatch.setattr(archive,'fetch_page',fetch)
    job={'generation':'g','end_mjd':61297,'missions':{},'state':'running'}
    asyncio.run(archive.synchronize(job))
    assert seen==[('JWST',1),('JWST',2),('HST',1),('HST',2)]
    assert job['state']=='complete'
    assert archive.status()['total']==4
    assert archive.observation('2')['obsid']==100

def test_failed_update_preserves_previous_complete_index(archive,monkeypatch):
    archive.store_page('old',[observation(1)])
    with archive.connect() as c:archive.put(c,'complete',{'generation':'old'})
    async def fetch(client,mission,end,page):
        if page==2:raise ValueError('network failed')
        return {'data':[observation(2)],'paging':{'rowsFiltered':2,'pagesFiltered':2}}
    monkeypatch.setattr(archive,'fetch_page',fetch)
    job={'generation':'new','end_mjd':61297,'missions':{},'state':'running'}
    asyncio.run(archive.synchronize(job))
    assert job['state']=='failed'
    assert archive.status()['generation']=='old'
    assert archive.status()['total']==1

def test_map_groups_preserve_every_row_and_ra_wrap(archive):
    rows=[observation(n,ra=(359.99 if n%2 else .01),dec=0,mission='HST' if n%3 else 'JWST') for n in range(1,601)]
    archive.store_page('g',rows)
    with archive.connect() as c:archive.put(c,'complete',{'generation':'g'})
    result=archive.map_points(0,0,.1,.15)
    assert result['total']==600
    assert sum(p['count'] for p in result['rows'])==600
    assert sum(p['webb'] for p in result['rows'])==200
    assert archive.listing(0,0,.1)['total']==600
    assert archive.map_points(180,0,.1,1)['total']==0

def test_flickr_sparse_public_page_is_not_assumed_complete():
    raw={'main':{'set-models':[{'data':{'photoPageList':{'data':{'totalItems':103,'_data':[None]*100+[{'data':{'_flickrModelRegistry':'photo-models','id':'123','title':'M31'},'exportMetaType':'model'}]},'exportMetaType':'pojo'}},'exportMetaType':'model'}]}}
    rows,total=gallery.parse_listing('<script>modelExport: '+json.dumps(raw)+', next: true</script>')
    assert total==103 and len(rows)==1 and rows[0]['id']=='123'

def test_gallery_location_is_not_flickr_earth_geotag():
    p=gallery.normalize({'id':'123','title':'Southern Ring Nebula','description':'NASA image','latitude':50,'longitude':15,'sizes':{}})
    assert p['ra'] is None and p['location'] is None
    assert gallery.target_name(p)=='NGC 3132'
    p['title']='NGC 3324';assert gallery.target_name(p)=='NGC 3324'
    assert gallery.image_kind("Exoplanet (Artist's Concept)",'')=='Illustration / simulation'

def test_photometry_converts_units_preserves_uncertainty_and_negative_flux():
    import io
    t=Table()
    t['sed_freq']=[1e12,2e12]*u.Hz
    t['sed_flux']=[1000,-200]*u.mJy
    t['sed_eflux']=MaskedColumn([50.,0.],mask=[False,True],unit=u.mJy)
    t['_tabname']=['II/246/out','II/246/out'];t['_ID']=['star-1','star-2']
    buf=io.BytesIO();t.write(buf,format='votable')
    content=buf.getvalue().replace(b'name="sed_',b'name="_sed_')
    result=photometry.parse_sed(content)
    assert result['rows'][0]['frequency_ghz']==pytest.approx(1000)
    assert result['rows'][0]['flux_jy']==1
    assert result['rows'][0]['error_jy']==.05
    assert result['rows'][1]['flux_jy']==-.2
    assert result['rows'][1]['error_jy'] is None
    assert result['rows'][0]['wavelength_um']==pytest.approx(299.792458)
    json.dumps(result,allow_nan=False)

def test_photometry_rejects_html_and_path_escape():
    with pytest.raises(ValueError):photometry.parse_sed(b'<html>Service unavailable</html>')
    with pytest.raises(ValueError):photometry.votable('../notebook')
