import hashlib
import io
import json

import numpy as np
import httpx
import pytest
from astropy.io import fits
from astropy.wcs import WCS
from fastapi.testclient import TestClient
from PIL import Image

from app import app, SURVEYS
import atlas
import atlas_cache as cache
import expeditions
import science
import sdss


@pytest.fixture
def isolated(tmp_path,monkeypatch):
    monkeypatch.setattr(cache,'ROOT',tmp_path/'cache')
    monkeypatch.setattr(cache,'LIMIT',32*1024*1024)
    monkeypatch.setattr(atlas,'CACHED_ONLY',False)
    monkeypatch.setattr(science,'IMAGES',tmp_path/'images');science.IMAGES.mkdir()


def map_data(value=None):
    return {'value':value if value is not None else [[1.,2.,3.],[4.,5.,6.],[7.,8.,9.]],
            'ivar':np.ones((3,3)).tolist(),'mask':np.zeros((3,3),dtype=int).tolist(),'unit':'test flux'}


def metadata():
    w=WCS(naxis=2);w.wcs.crpix=[2,2];w.wcs.crval=[359.99,75];w.wcs.cdelt=[-.5/3600,.5/3600];w.wcs.ctype=['RA---TAN','DEC--TAN']
    hdr=fits.Header({'PLATEIFU':'8485-1901','DAPQUAL':0,'VERSDAP':'3.1.0','VERSDRP3':'v3_1_1'})
    return {'plateifu':'8485-1901','bintype':sdss.BINTYPE,'template':sdss.TEMPLATE,'shape':[3,3],'header':hdr.tostring(),'wcs':w.to_header().tostring()}


def test_color_cutout_keeps_original_bytes_and_imports_as_display(isolated,monkeypatch):
    out=io.BytesIO();Image.new('RGB',(2048,2048),(35,50,80)).save(out,format='JPEG');raw=out.getvalue();calls=[]
    def fetch(url,params,max_bytes):calls.append((url,params));return raw,'image/jpeg'
    monkeypatch.setattr(atlas,'read_remote',fetch)
    d=sdss.color_cutout(sdss.Cutout(ra=202.469575,dec=47.1952583,fov=.23))
    assert calls[0][1]['scale']==pytest.approx(.23*3600/2048)
    assert d['sha256']==hashlib.sha256(raw).hexdigest()
    assert 'dr20' in d['source']['source_url'] and 'legacy' in d['processing']
    monkeypatch.setattr(atlas,'CACHED_ONLY',True)
    assert sdss.color_cutout(sdss.Cutout(ra=202.469575,dec=47.1952583,fov=.23))['sha256']==d['sha256']
    assert len(calls)==1
    m=sdss.import_display(sdss.ImportRequest(ident=d['id']))
    assert not m['scientific'] and m['width']==2048
    assert m['sha256']==d['sha256'] and m['extra']['source']==d['source']


def test_wrong_size_error_images_and_failed_json_are_not_cached(isolated,monkeypatch):
    out=io.BytesIO();Image.new('RGB',(100,100)).save(out,format='JPEG')
    monkeypatch.setattr(atlas,'read_remote',lambda *a,**kw:(out.getvalue(),'image/jpeg'))
    with pytest.raises(ValueError,match='unexpected dimensions'):sdss.color_cutout(sdss.Cutout(ra=0,dec=0))
    assert cache.status()['files']==0
    monkeypatch.setattr(atlas,'read_remote',lambda *a,**kw:(b'{"status":-1,"error":"missing"}','application/json'))
    with pytest.raises(ValueError,match='unavailable'):sdss.manga_data('8485-1901','ha')
    assert cache.status()['files']==0

def test_temporary_upstream_error_retries_once_then_caches_valid_data(isolated,monkeypatch):
    calls=[]
    def fetch(url,**kwargs):
        calls.append(url)
        if len(calls)==1:httpx.Response(502,request=httpx.Request('GET',url)).raise_for_status()
        return b'{"status":1,"data":{}}','application/json'
    monkeypatch.setattr(atlas,'read_remote',fetch);monkeypatch.setattr(sdss.time,'sleep',lambda _:None)
    d,_=sdss.remote_json('test','https://example.test/data',{})
    assert d['status']==1 and len(calls)==2
    sdss.remote_json('test','https://example.test/data',{})
    assert len(calls)==2


def test_quality_mask_and_snr_preserve_real_values():
    d=map_data([[1.,2.,3.],[4.,5.,6.],[7.,float('nan'),-9.]])
    d['mask'][1][0]=1;d['ivar'][1][1]=0
    value,ivar,mask,valid=sdss.valid_map(d,(3,3),snr=3,flux=True)
    assert valid.tolist()==[[False,False,True],[False,False,True],[True,False,False]]
    assert value[2,2]==-9 and np.isnan(value[2,1])
    with pytest.raises(ValueError,match='dimensions'):sdss.valid_map(d,(4,4))


def test_velocity_keeps_zero_and_both_signs_and_masks_weak_gas():
    d=map_data([[-20.,0.,20.],[-10.,0.,10.],[-5.,0.,5.]])
    rgba,valid,limits,_,values,_,_=sdss.map_pixels(d,sdss.PRODUCTS['stellar_velocity'],(3,3),3)
    assert valid.all() and limits[0]==-limits[1]
    assert rgba[0,0,2]>rgba[0,0,0] and rgba[0,2,0]>rgba[0,2,2]
    assert rgba[0,1,:3].tolist()==[255,255,255]
    _,gas_good,*_=sdss.map_pixels(d,sdss.PRODUCTS['gas_velocity'],(3,3),3,map_data())
    assert not gas_good[0,0] and gas_good[0,2]
    assert values[0,0]==-20


@pytest.mark.parametrize('product',['ha','oiii','sii','gas_velocity','stellar_velocity','gas_rgb'])
def test_manga_maps_keep_wcs_masks_and_provenance_and_reuse_offline(isolated,monkeypatch,product):
    calls=[];meta=metadata()
    def fetch(plateifu,product=None):
        calls.append(product);return (map_data() if product else meta),{'source_url':'https://example.test/'+str(product),'created_at':'2026-09-14T00:00:00Z','sha256':'original'}
    monkeypatch.setattr(sdss,'manga_data',fetch)
    d=sdss.make_manga_map(sdss.MapRequest(plateifu='8485-1901',product=product,snr=3))
    assert d['release']=='DR17' and d['valid_pixels']>0 and d['pipeline']['dap']=='3.1.0'
    original_wcs=WCS(fits.Header.fromstring(meta['wcs'])).celestial
    out_wcs=WCS(fits.Header(d['wcs'])).celestial
    np.testing.assert_allclose(original_wcs.pixel_to_world_values(0,0),out_wcs.pixel_to_world_values(0,0),atol=1e-10)
    with Image.open(cache.get(d['image_id'])['path']) as image:
        assert image.size==(3,3) and 'Provenance' in image.info
        alpha=np.array(image)[:,:,3]
        np.testing.assert_array_equal(alpha,np.flipud(np.array(d['valid']))*255)
    original=json.loads(cache.get(d['data_id'])['path'].read_bytes())
    assert original['metadata']==meta and original['sources']==d['sources']
    monkeypatch.setattr(sdss,'manga_data',lambda *a,**kw:pytest.fail('Saved map should be reused'))
    assert sdss.make_manga_map(sdss.MapRequest(plateifu='8485-1901',product=product,snr=3))==d
    m=sdss.import_display(sdss.ImportRequest(ident=d['image_id']))
    assert not m['scientific'] and m['extra']['release']=='DR17'


def test_all_masked_map_is_not_fabricated(isolated,monkeypatch):
    data=map_data();data['mask']=np.ones((3,3),dtype=int).tolist()
    monkeypatch.setattr(sdss,'manga_data',lambda plateifu,product=None:(data if product else metadata(),{}))
    with pytest.raises(ValueError,match='No unflagged'):sdss.make_manga_map(sdss.MapRequest(plateifu='8485-1901'))


def test_nearby_query_uses_validated_spherical_distance_and_reports_cap(isolated,monkeypatch):
    calls=[]
    row={'plateifu':'8485-1901','objra':359.999,'objdec':89.9,'nsa_z':.03,'nsa_iauname':'test','distance_arcmin':1.2}
    def fetch(label,url,params):calls.append(params['cmd']);return [{'TableName':'Table1','Rows':[row]*25}],{'created_at':'now'}
    monkeypatch.setattr(sdss,'remote_json',fetch)
    d=sdss.manga_nearby(sdss.Cone(ra=.001,dec=89.9))
    assert 'fDistanceArcMinEq' in calls[0] and 'TOP 25' in calls[0]
    assert d['at_limit'] and d['rows'][0]['ra']==359.999


def test_api_rejects_invalid_parameters_and_sdss_lenses_can_be_saved():
    with TestClient(app) as client:
        for payload in [{'ra':'0; DROP TABLE stars','dec':0},{'ra':360,'dec':0},{'ra':0,'dec':91},{'ra':0,'dec':0,'size':8192},{'ra':0,'dec':0,'fov':.0001}]:
            assert client.post('/api/sdss/cutout',json=payload).status_code==422
        assert client.post('/api/sdss/manga/map',json={'plateifu':'../../secret'}).status_code==422
        assert client.post('/api/sdss/manga/map',json={'plateifu':'8485-1901','product':'made-up'}).status_code==422
    for survey in [s for s in SURVEYS if s['id'].startswith('sdss-')]:
        assert expeditions.View(ra=0,dec=0,survey=survey['id']).survey==survey['id']
