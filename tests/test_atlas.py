import io
import json
import re
import httpx
import numpy as np
import pytest
from astropy.io import fits
from astropy.wcs import WCS, Sip
from fastapi.testclient import TestClient
from app import app
import atlas
import atlas_cache as cache
import coverage_index as spatial
import recent_archive as archive
from range_fits import RangeFITS
from sky_cutout import reproject_section, view_header

def range_client(content,mutate=None):
    def handle(request):
        start,end=map(int,re.fullmatch(r'bytes=(\d+)-(\d+)',request.headers['range']).groups());end=min(end,len(content)-1)
        headers={'content-range':f'bytes {start}-{end}/{len(content)}','etag':'"fixed"'}
        status,body=206,content[start:end+1]
        if mutate:status,headers,body=mutate(start,end,headers,body)
        return httpx.Response(status,headers=headers,content=body)
    return httpx.Client(transport=httpx.MockTransport(handle))

def test_range_seek_readinto_and_cache():
    data=bytes(range(256))*100
    with range_client(data) as client,RangeFITS('mast:JWST/product/test.fits',block_size=1024,client=client) as f:
        f.seek(1010);assert f.read(40)==data[1010:1050];assert f.requests==2
        f.seek(1010);b=bytearray(40);assert f.readinto(b)==40;assert bytes(b)==data[1010:1050];assert f.requests==2
        f.seek(-10,2);assert f.read(100)==data[-10:];assert f.read(10)==b''

@pytest.mark.parametrize('change',[
    lambda a,b,h,d:(200,{},d),
    lambda a,b,h,d:(206,{**h,'content-range':f'bytes {a+1}-{b}/4096'},d),
    lambda a,b,h,d:(206,h,d[:-1]),
    lambda a,b,h,d:(206,h,d+b'extra'),
])
def test_range_rejects_unsafe_responses(change):
    with range_client(b'x'*4096,change) as client,RangeFITS('mast:HST/product/test.fits',block_size=1024,client=client) as f:
        with pytest.raises(ValueError):f.read(2)

def test_range_budget_and_changed_product():
    with range_client(b'x'*4096) as client,RangeFITS('mast:HST/product/test.fits',block_size=1024,budget=1024,client=client) as f:
        f.read(1024)
        with pytest.raises(ValueError,match='budget'):f.read(1)
    mutate=lambda a,b,h,d:(206,{**h,'etag':'"changed"' if a else '"fixed"'},d)
    with range_client(b'x'*4096,mutate) as client,RangeFITS('mast:HST/product/test.fits',block_size=1024,client=client) as f:
        f.read(1024)
        with pytest.raises(ValueError,match='changed'):f.read(1)

@pytest.mark.parametrize('uri',['https://example.com/evil.fits','mast:JWST/product/../secret.fits','mast:OTHER/a.fits','mast:JWST/product/x.fits.gz'])
def test_range_rejects_untrusted_identifiers(uri):
    with pytest.raises(ValueError):RangeFITS(uri)

def test_registered_cutout_preserves_stars_and_missing_pixels():
    w=WCS(view_header(359.999,70,.015,512));y,x=np.mgrid[:512,:512]
    raw=np.exp(-((x-266)**2+(y-245)**2)/8).astype(np.float32);raw[100:160,100:160]=np.nan
    original=raw.copy();hdu=fits.ImageHDU(raw,header=w.to_header(),name='SCI')
    source=io.BytesIO();fits.HDUList([fits.PrimaryHDU(),hdu]).writeto(source);source.seek(0)
    with fits.open(source) as source_hdus:body,m=reproject_section(source_hdus['SCI'],w,359.999,70,.015)
    with fits.open(io.BytesIO(body)) as hdus:
        out=hdus[0].data;neww=WCS(hdus[0].header)
        peak=np.unravel_index(np.nanargmax(out),out.shape)
        source_star=w.pixel_to_world(266,245);dest_star=neww.pixel_to_world(peak[1],peak[0])
        assert source_star.separation(dest_star).arcsec<.01
        assert np.isnan(out[125,125]);assert hdus[0].header['VISONLY'] is True
        assert np.nanmax(out)==pytest.approx(1,rel=.005)
    np.testing.assert_equal(raw,original);assert m['wcs_roundtrip_pixels']<1e-5

def test_distortion_is_reprojected_to_plain_tan():
    w=WCS(view_header(12,-60,.015,512));a=np.zeros((3,3));b=a.copy();a[2,0]=1e-5;b[0,2]=-2e-5
    w.sip=Sip(a,b,None,None,w.wcs.crpix);w.wcs.ctype=['RA---TAN-SIP','DEC--TAN-SIP']
    y,x=np.mgrid[:512,:512];raw=np.exp(-((x-350)**2+(y-370)**2)/10).astype(np.float32)
    source=io.BytesIO();fits.PrimaryHDU(raw).writeto(source);source.seek(0)
    with fits.open(source) as source_hdus:body,m=reproject_section(source_hdus[0],w,12,-60,.015)
    with fits.open(io.BytesIO(body)) as hdus:
        nw=WCS(hdus[0].header);yy,xx=np.unravel_index(np.nanargmax(hdus[0].data),hdus[0].data.shape)
        assert nw.sip is None
        assert nw.pixel_to_world(xx,yy).separation(w.pixel_to_world(350,370)).arcsec<m['native_pixel_scale_arcsec']

def test_range_astropy_science_section():
    data=np.arange(256*256,dtype=np.float32).reshape(256,256);out=io.BytesIO()
    fits.HDUList([fits.PrimaryHDU(),fits.ImageHDU(data,name='SCI')]).writeto(out)
    with range_client(out.getvalue()) as client,RangeFITS('mast:HST/product/test.fits',block_size=4096,client=client) as f:
        with fits.open(f,memmap=False) as hdus:np.testing.assert_equal(hdus['SCI'].section[80:90,100:110],data[80:90,100:110])
        assert f.transferred<len(out.getvalue())/4

def test_cache_lru_pins_and_quota(tmp_path,monkeypatch):
    monkeypatch.setattr(cache,'ROOT',tmp_path/'cache');monkeypatch.setattr(cache,'LIMIT',24)
    a,b,c=[cache.key(x) for x in ('a','b','c')]
    cache.put(a,b'1'*10,'image/png',pin='pack');cache.put(b,b'2'*10,'image/png');cache.put(c,b'3'*10,'image/png')
    assert cache.get(a) and cache.get(c);assert cache.get(b) is None
    cache.pin('pack',c)
    with pytest.raises(ValueError,match='full'):cache.put(b,b'4'*10,'image/png')
    assert cache.status()['bytes']==20
    cache.remove_pack('pack');cache.put(b,b'4'*10,'image/png');assert cache.status()['bytes']<=24
    with pytest.raises(ValueError):cache.path('../secret')

def test_full_spatial_index_finds_footprint_beyond_nearest_1500(tmp_path,monkeypatch):
    monkeypatch.setattr(archive,'PATH',tmp_path/'archive.sqlite3');monkeypatch.setattr(archive,'_coordinates',None)
    monkeypatch.setattr(spatial,'PATH',tmp_path/'spatial.sqlite3');monkeypatch.setattr(spatial,'_table',None)
    observations=[{'objID':i+1,'obsid':i+1,'obs_collection':'JWST','s_ra':.001+i*.00001,'s_dec':0,'s_region':'CIRCLE 10 0 .001','mtFlag':False} for i in range(1600)]
    observations.append({'objID':9999,'obsid':9999,'obs_collection':'HST','s_ra':5,'s_dec':0,'s_region':'POLYGON ICRS 359 -1 6 -1 6 1 359 1','mtFlag':False})
    observations.append({'objID':9998,'obsid':9998,'obs_collection':'HST','s_ra':0,'s_dec':0,'s_region':'CIRCLE 0 0 1','mtFlag':True})
    for o in observations:o['obs_id']='test-'+str(o['obsid'])
    archive.store_page('g',observations)
    with archive.connect() as c:archive.put(c,'complete',{'generation':'g'})
    assert spatial.build()['indexed']==1602
    result=spatial.nearby_candidates(0,0,'both',.1,2)
    assert result['ready'];assert result['rows'][0][2]['record_id']=='9999';assert result['rows'][0][0] is True
    assert result['rows'][0][1]==pytest.approx(5)
    assert '9998' not in spatial.possible_containment(0,0)
    assert spatial.possible_containment(0,0,'webb')==[]
    with archive.connect() as c:archive.put(c,'complete',{'generation':'new'})
    assert spatial.status()['ready'] is False

def test_cached_only_never_fetches_and_bad_tile_paths(tmp_path,monkeypatch):
    monkeypatch.setattr(cache,'ROOT',tmp_path/'cache');monkeypatch.setattr(atlas,'CACHED_ONLY',True)
    with TestClient(app) as client:
        assert client.get('/api/atlas/surveys/optical/properties').status_code==503
        assert client.get('/api/atlas/surveys/unknown/properties').status_code==404
        assert client.get('/api/atlas/files/not-a-hash').status_code==400
        assert client.post('/api/atlas/prepare',json={'record_id':'123','ra':0,'dec':0,'fov':.1}).status_code==409
    for bad in ['../../x','Norder1/Dir0/Npix1.jpg?url=evil','Norder1/Dir0/Npix1.svg','Norder30/Allsky.png']:
        assert not atlas.tile_path(bad)

def test_saved_view_retains_exact_wcs_and_reuses_cache_offline(tmp_path,monkeypatch):
    from PIL import Image
    monkeypatch.setattr(cache,'ROOT',tmp_path/'cache')
    out=io.BytesIO();Image.new('RGB',(768,768),(20,30,50)).save(out,format='PNG')
    requests=[]
    def fetch(url,params,max_bytes):requests.append(params);return out.getvalue(),'image/png'
    monkeypatch.setattr(atlas,'read_remote',fetch)
    view={'ra':359.99,'dec':88.,'fov':.25,'survey':'optical'}
    result=atlas.survey_view(view,'pack')
    assert result['wcs']==json.loads(requests[0]['wcs'])
    assert requests[0]['hips']==atlas.SURVEYS['optical']['url']
    monkeypatch.setattr(atlas,'read_remote',lambda *a,**kw:pytest.fail('Offline view must use cache'))
    assert atlas.survey_view(view)['id']==result['id']
    assert cache.status()['pinned_bytes']>0

def test_failed_pack_keeps_successful_views_and_saved_revision(tmp_path,monkeypatch):
    monkeypatch.setattr(cache,'ROOT',tmp_path/'cache');monkeypatch.setattr(atlas,'JOBS',{});monkeypatch.setattr(atlas,'CACHED_ONLY',False)
    route={'id':'saved','revision':7,'title':'Tour','kind':'waypoints','stops':[{'ra':1},{'ra':2}],'media':[None,None]}
    monkeypatch.setattr(atlas.expeditions,'read',lambda _:route)
    class Immediate:
        def submit(self,fn):fn()
    monkeypatch.setattr(atlas,'DOWNLOADS',Immediate())
    def view(v,pin):
        if v['ra']==2:raise ValueError('Unavailable survey')
        return {'url':'/saved','id':'one'}
    monkeypatch.setattr(atlas,'survey_view',view)
    result=atlas.download_pack('saved')['result']
    assert result['state']=='partial' and len(result['errors'])==1
    assert result['route']['revision']==7 and result['views'][0]['view']['id']=='one'
    assert cache.packs()[0]['state']=='partial'

def test_expired_tile_falls_back_to_local_copy_when_network_is_unavailable(tmp_path,monkeypatch):
    monkeypatch.setattr(cache,'ROOT',tmp_path/'cache');monkeypatch.setattr(atlas,'CACHED_ONLY',False)
    url=atlas.SURVEYS['optical']['url']+'/properties'
    cache.put(cache.key('tile:'+url),b'hips_order=9','text/plain',{'created_at':'2000-01-01T00:00:00+00:00','source_url':url})
    def offline(*a,**kw):raise ValueError('Offline')
    monkeypatch.setattr(atlas,'read_remote',offline)
    response=atlas.survey_tile('optical','properties')
    assert response.status_code==200 and response.body==b'hips_order=9'
    assert response.headers['X-Atlas-Stale']=='true'
