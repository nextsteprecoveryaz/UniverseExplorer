import json
import math
import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError
from app import app
import coverage_guide as coverage
import expeditions as routes
import recent_archive as archive
import webb_gallery as gallery
import coverage_index

@pytest.fixture
def client(tmp_path,monkeypatch):
    monkeypatch.setattr(routes,'PATH',tmp_path/'routes.sqlite3')
    monkeypatch.setattr(archive,'PATH',tmp_path/'archive.sqlite3')
    monkeypatch.setattr(archive,'_coordinates',None)
    monkeypatch.setattr(gallery,'PATH',tmp_path/'gallery.sqlite3')
    monkeypatch.setattr(coverage_index,'PATH',tmp_path/'coverage.sqlite3')
    monkeypatch.setattr(coverage_index,'_table',None)
    monkeypatch.setattr(coverage_index,'ensure_async',lambda:None)
    return TestClient(app)

def route():
    return {'title':'Observed route','kind':'waypoints','stops':[{'title':'At RA zero','ra':359.99,'dec':0,'fov':.1,'source':None}], 'track':[]}

def test_wrap_and_pole_footprints():
    poly=coverage.footprint('POLYGON ICRS 359.9 -0.1 0.1 -0.1 0.1 0.1 359.9 0.1')
    assert coverage.contains(poly,0,0) is True
    assert coverage.contains(poly,180,0) is False
    assert coverage.contains(poly,.2,0) is False
    polar=coverage.footprint('POLYGON 0 89 120 89 240 89')
    assert coverage.contains(polar,0,90) is True
    assert coverage.contains(polar,0,85) is False
    circle=coverage.footprint('CIRCLE 359.99 0 0.05')
    assert coverage.contains(circle,.01,0) is True
    assert coverage.contains(circle,.1,0) is False

@pytest.mark.parametrize('region',['POLYGON FK5 0 0 1 0 1 1','POLYGON 0 0 1 1','CIRCLE 0 0 NaN','UNION ICRS (CIRCLE 0 0 1)','POLYGON 0 0 180 0 0 89','CIRCLE 0 100 1'])
def test_unknown_or_invalid_regions_are_not_coverage(region):
    assert coverage.footprint(region) is None
    assert coverage.contains(coverage.footprint(region),0,0) is None

def test_nearby_uses_true_angular_distance_and_excludes_moving_targets(client):
    observations=[]
    for n,ra,flag,mission in [(1,359.99,False,'JWST'),(2,.03,False,'HST'),(3,.001,True,'JWST'),(4,180,False,'JWST')]:
        observations.append({'objID':n,'obsid':n,'obs_id':str(n),'obs_collection':mission,'s_ra':ra,'s_dec':0,'t_min':61000,'target_name':str(n),'filters':'F200W','s_region':f'CIRCLE {ra} 0 .02','mtFlag':flag})
    archive.store_page('g',observations)
    with archive.connect() as c:archive.put(c,'complete',{'generation':'g','completed_at':'2026-09-14T00:00:00Z'})
    d=client.get('/api/navigation/nearby?ra=0&dec=0&radius=1').json()
    assert d['indexed_pointings_in_radius']==3
    assert {r['id'] for r in d['rows']}=={'1','2'}
    assert d['rows'][0]['contains_view_center'] is True
    assert d['rows'][0]['distance_deg']==pytest.approx(.01)
    assert d['rows'][1]['contains_view_center'] is False
    webb=client.get('/api/navigation/nearby?ra=0&dec=0&radius=1&mission=webb').json()
    assert [r['id'] for r in webb['rows']]==['1']

def test_route_revision_progress_and_export_roundtrip(client):
    r=client.post('/api/navigation/routes',json=route());assert r.status_code==200
    saved=r.json();ident=saved['id'];assert saved['revision']==1
    progress={'revision':1,'elapsed':3,'origin':{'ra':0,'dec':0,'fov':30}}
    assert client.put(f'/api/navigation/routes/{ident}/progress',json=progress).status_code==200
    assert client.get(f'/api/navigation/routes/{ident}').json()['progress']['elapsed']==3
    updated=client.put(f'/api/navigation/routes/{ident}',json={**route(),'revision':1,'title':'Edited'}).json()
    assert updated['revision']==2 and updated['progress'] is None
    assert client.put(f'/api/navigation/routes/{ident}',json={**route(),'revision':1}).status_code==409
    bundle=client.get(f'/api/navigation/routes/{ident}/export').json()
    copy=client.post('/api/navigation/import',json=bundle).json()
    assert copy['id']!=ident and copy['stops']==updated['stops']
    assert client.delete(f'/api/navigation/routes/{ident}?revision=1').status_code==409
    assert client.delete(f'/api/navigation/routes/{ident}?revision=2').status_code==200
    assert client.get(f'/api/navigation/routes/{ident}').status_code==404

def test_missing_source_preserves_waypoint_but_never_fabricates_media(client):
    body=route();body['stops'][0]['source']={'kind':'mast','id':'99999'}
    saved=client.post('/api/navigation/routes',json=body).json()
    assert saved['media'][0]['available'] is False
    assert saved['stops'][0]['ra']==359.99
    assert 'preview_url' not in saved['media'][0]

def test_recording_validation_rejects_invalid_or_nonmonotonic_camera_samples(client):
    valid={'title':'Flight','kind':'recording','track':[{'t':0,'ra':0,'dec':0},{'t':.5,'ra':1,'dec':0}]}
    assert client.post('/api/navigation/routes',json=valid).status_code==200
    for bad in [[{'t':1,'ra':0,'dec':0}], [{'t':0,'ra':0,'dec':0},{'t':0,'ra':1,'dec':0}], [{'t':0,'ra':360,'dec':0}], [{'t':0,'ra':1,'dec':0,'survey':'https://evil.invalid'}]]:
        assert client.post('/api/navigation/routes',json={**valid,'track':bad}).status_code==422
    with pytest.raises(ValidationError):routes.View(ra=0,dec=0,roll=math.nan)

def test_import_rejects_untrusted_urls_and_unknown_schema(client):
    body=route();body['stops'][0]['source']={'kind':'mast','id':'../../../secret'}
    assert client.post('/api/navigation/routes',json=body).status_code==422
    assert client.post('/api/navigation/import',json={'schema':'other','version':1,'route':route()}).status_code==422
    body=route();body['stops'][0]['preview_url']='javascript:alert(1)'
    assert client.post('/api/navigation/routes',json=body).status_code==422
