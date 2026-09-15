import hashlib
import io
import json

import numpy as np
import pytest
from astropy.io import fits
from astropy.wcs import WCS
from PIL import Image

import integrations
import science

@pytest.fixture(autouse=True)
def isolated_images(tmp_path,monkeypatch):
    monkeypatch.setattr(science,'IMAGES',tmp_path)

def star_field():
    rng=np.random.default_rng(314)
    arr=rng.normal(100,1,(160,160)).astype(np.float32)
    yy,xx=np.mgrid[:160,:160]
    for x,y,amplitude in [(45,63,80),(112,105,65)]:
        arr+=amplitude*np.exp(-((xx-x)**2+(yy-y)**2)/(2*1.5**2))
    w=WCS(naxis=2);w.wcs.crpix=[80,80];w.wcs.cdelt=[-.0001,.0001];w.wcs.crval=[83.8,-5.4];w.wcs.ctype=['RA---TAN','DEC--TAN']
    out=io.BytesIO();fits.PrimaryHDU(arr,header=w.to_header()).writeto(out)
    return out.getvalue()

def test_original_fits_and_world_coordinates_are_preserved():
    content=star_field();m=science.import_image(content,'field.fits')
    assert m['scientific'] and m['wcs']
    original=science.IMAGES/(m['id']+'.fits')
    assert original.read_bytes()==content
    result=science.detect_sources(m['id'],6)
    assert len(result['rows'])==2
    assert {(r['x'],r['y']) for r in result['rows']}=={(45,63),(112,105)}
    assert all(r['ra'] is not None and r['dec'] is not None for r in result['rows'])
    assert result['rows'][0]['display_y']==159-result['rows'][0]['y']
    for mode in ['asinh','linear','log']:
        assert science.render(m['id'],mode).exists()
    assert hashlib.sha256(original.read_bytes()).hexdigest()==m['sha256']

def test_display_image_cannot_enter_scientific_detector():
    buf=io.BytesIO();Image.new('RGB',(48,48),'white').save(buf,format='PNG')
    m=science.import_image(buf.getvalue(),'display.png')
    with pytest.raises(ValueError,match='original 2D FITS'):
        science.detect_sources(m['id'])

def test_local_neural_enhancement_never_changes_science_results():
    m=science.import_image(star_field(),'field.fits')
    before=science.detect_sources(m['id'])
    enhanced=science.enhance(m['id'])
    assert enhanced['ai']['model']=='FSRCNN x2'
    assert enhanced['ai']['output_size']==[320,320]
    assert science.detect_sources(m['id'])==before
    im=Image.open(science.IMAGES/(m['id']+'-ai.png'))
    assert json.loads(im.info['Provenance'])['scientific_evidence'] is False

def test_bls_recovers_injected_period_not_just_any_peak():
    rng=np.random.default_rng(9);t=np.arange(0,20,.01)
    phase=((t-.23+1.7/2)%1.7)-1.7/2
    flux=1+rng.normal(0,.0005,len(t))-.02*(abs(phase)<.04)
    content=('time,flux\n'+'\n'.join(f'{x},{y}' for x,y in zip(t,flux))).encode()
    r=science.transit_search(content,'injected-test.csv',.5,5)
    assert abs(r['period_days']-1.7)<.01
    assert abs(r['depth']-.02)<.005
    assert r['samples']==2000

def test_rejects_path_traversal_and_unusable_data():
    with pytest.raises(ValueError):science.metadata('../outside')
    with pytest.raises(ValueError):science.import_image(b'not an image','bad.png')
    with pytest.raises(ValueError):science.stretch_array(np.full((10,10),np.nan))

def test_live_schedules_are_not_mislabeled_executed():
    o=integrations.normalize_live({'data':{'id':'abc','targetName':'Example','predictedStartTime':'2026-09-14T01:00:00Z','predictedEndTime':'2026-09-14T02:00:00Z','executed':False}},'hubble')
    assert o['status']=='Scheduled / execution unconfirmed'
    assert o['ra'] is None

def test_api_local_boundary_and_validation():
    from fastapi.testclient import TestClient
    from app import app
    c=TestClient(app)
    assert c.get('/api/health').status_code==200
    assert c.get('/api/archive?ra=999&dec=0').status_code==422
    assert c.post('/api/notes',headers={'Origin':'https://untrusted.example'},json={'title':'bad'}).status_code==403
    assert c.get('/api/health',headers={'Host':'untrusted.example'}).status_code==400

def test_oversized_archive_thumbnail_returns_controlled_error(monkeypatch):
    from fastapi.testclient import TestClient
    from app import app
    buf=io.BytesIO();Image.new('RGB',(100,100),'black').save(buf,format='JPEG')
    # A valid JPEG header advertising an excessive size must be rejected
    # before its compressed pixels are decoded or allocated.
    oversized=bytearray(buf.getvalue());frame=oversized.index(b'\xff\xc0')
    oversized[frame+5:frame+9]=b'\xff\xff\xff\xff'
    async def oversized_preview(*args,**kwargs):
        return bytes(oversized)
    monkeypatch.setattr(integrations,'download_mast',oversized_preview)
    response=TestClient(app).get('/api/archive-preview',params={'uri':'mast:HST/product/example.jpg'})
    assert response.status_code==413
    assert 'science products' in response.json()['detail']


def test_large_mast_jpeg_is_decoder_reduced_for_display(monkeypatch):
    from fastapi.testclient import TestClient
    from app import app
    buf=io.BytesIO()
    Image.new('RGB',(6000,4500),(30,70,110)).save(buf,format='JPEG')
    original=buf.getvalue()
    async def preview(*args,**kwargs):return original
    monkeypatch.setattr(integrations,'download_mast',preview)
    response=TestClient(app).get('/api/archive-preview',params={'uri':'mast:JWST/product/mosaic.jpg'})
    assert response.status_code==200
    with Image.open(io.BytesIO(response.content)) as image:
        assert image.size==(1200,900)
        assert abs(image.getpixel((600,450))[1]-70)<=2
    assert buf.getvalue()==original
