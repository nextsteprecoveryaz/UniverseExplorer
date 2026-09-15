"""Loading guarantees: shared transfers, prompt cached reads, durable cache quotas."""
import threading
from concurrent.futures import ThreadPoolExecutor

import httpx
import pytest
from fastapi.testclient import TestClient

import atlas
import atlas_cache as cache
from app import app


@pytest.fixture
def isolated_cache(tmp_path,monkeypatch):
    monkeypatch.setattr(cache,'ROOT',tmp_path/'cache')
    monkeypatch.setattr(cache,'LIMIT',8*cache.GIB)
    monkeypatch.setattr(atlas,'CACHED_ONLY',False)
    monkeypatch.setattr(atlas,'TILE_PENDING',{})
    monkeypatch.setattr(atlas,'TILE_REFRESHING',set())
    with ThreadPoolExecutor(max_workers=2) as workers:
        monkeypatch.setattr(atlas,'TILE_REFRESH',workers)
        yield workers


def test_remote_client_reused_and_transfer_limit_enforced(monkeypatch):
    clients=[]
    original=httpx.Client
    def factory(**kwargs):
        client=original(transport=httpx.MockTransport(lambda r:httpx.Response(200,content=b'tile-data',headers={'content-type':'image/png'})),**kwargs)
        clients.append(client)
        return client
    monkeypatch.setattr(atlas,'REMOTE_CLIENT',None)
    monkeypatch.setattr(atlas,'CACHED_ONLY',False)
    monkeypatch.setattr(atlas.httpx,'Client',factory)
    try:
        assert atlas.read_remote('https://example.test/one')==(b'tile-data','image/png')
        assert atlas.read_remote('https://example.test/two')==(b'tile-data','image/png')
        with pytest.raises(ValueError,match='transfer limit'):atlas.read_remote('https://example.test/three',max_bytes=3)
        assert len(clients)==1
    finally:atlas.close_remote_client()
    assert clients[0].is_closed


def test_simultaneous_requests_share_tile_and_distinct_tiles_can_load(isolated_cache,monkeypatch):
    started=threading.Event();release=threading.Event();calls=[]
    def fetch(url):
        calls.append(url)
        if url.endswith('Npix1.jpg'):
            started.set();assert release.wait(5)
        return b'unchanged-original-tile','image/jpeg'
    monkeypatch.setattr(atlas,'read_remote',fetch)
    with ThreadPoolExecutor(max_workers=8) as requests:
        first=requests.submit(atlas.survey_tile,'optical','Norder1/Dir0/Npix1.jpg')
        try:
            assert started.wait(3)
            duplicates=[requests.submit(atlas.survey_tile,'optical','Norder1/Dir0/Npix1.jpg') for _ in range(5)]
            unrelated=requests.submit(atlas.survey_tile,'optical','Norder1/Dir0/Npix2.jpg')
            assert unrelated.result(timeout=3).body==b'unchanged-original-tile'
        finally:release.set()
        assert all(f.result(timeout=3).body==b'unchanged-original-tile' for f in [first,*duplicates])
    assert len(calls)==2
    assert atlas.TILE_PENDING=={}


def test_stale_tile_returns_immediately_and_refreshes_once(isolated_cache,monkeypatch):
    started=threading.Event();release=threading.Event();calls=[]
    part='Norder1/Dir0/Npix1.jpg';url=atlas.SURVEYS['optical']['url']+'/'+part
    ident=cache.key('tile:'+url);old='2000-01-01T00:00:00+00:00'
    cache.put(ident,b'old','image/jpeg',{'created_at':old,'source_url':url})
    def fetch(url):
        calls.append(url);started.set();assert release.wait(5)
        return b'new','image/jpeg'
    monkeypatch.setattr(atlas,'read_remote',fetch)
    try:
        response=atlas.survey_tile('optical',part)
        assert started.wait(3)
        assert response.body==b'old' and response.headers['X-Atlas-Cache']=='stale'
        assert response.headers['X-Atlas-Retrieved']==old
        assert atlas.survey_tile('optical',part).body==b'old'
        assert len(calls)==1
    finally:
        release.set()
        isolated_cache.shutdown(wait=True)
    response=atlas.survey_tile('optical',part)
    assert response.body==b'new' and response.headers['X-Atlas-Cache']=='hit'
    assert response.headers['X-Atlas-Retrieved']!=old
    assert atlas.TILE_REFRESHING==set()


def test_offline_stale_tile_never_refreshes(isolated_cache,monkeypatch):
    url=atlas.SURVEYS['optical']['url']+'/properties'
    cache.put(cache.key('tile:'+url),b'hips_order=9','text/plain',{'created_at':'2000-01-01T00:00:00+00:00'})
    monkeypatch.setattr(atlas,'CACHED_ONLY',True)
    monkeypatch.setattr(atlas,'read_remote',lambda *a,**kw:pytest.fail('Offline mode must not fetch'))
    assert atlas.survey_tile('optical','properties').body==b'hips_order=9'
    assert atlas.TILE_REFRESHING==set()


def test_missing_upstream_tile_reports_no_coverage(isolated_cache,monkeypatch):
    def missing(url):
        response=httpx.Response(404,request=httpx.Request('GET',url));response.raise_for_status()
    monkeypatch.setattr(atlas,'read_remote',missing)
    with TestClient(app) as client:
        r=client.get('/api/atlas/surveys/optical/Norder1/Dir0/Npix1.jpg')
    assert r.status_code==404 and 'no tile' in r.json()['detail']
    assert atlas.TILE_PENDING=={}


def test_cache_size_persists_without_allocating_or_deleting(isolated_cache):
    ident=cache.key('saved');cache.put(ident,b'saved-original','image/png',pin='tour')
    with TestClient(app) as client:
        response=client.post('/api/atlas/cache-settings',json={'limit_gib':16})
        assert response.status_code==200
        assert response.json()['limit_bytes']==16*cache.GIB
        assert response.json()['bytes']==len(b'saved-original')
        assert client.post('/api/atlas/cache-settings',json={'limit_gib':65}).status_code==422
    assert cache.read_limit()==16*cache.GIB
    assert cache.get(ident)['path'].read_bytes()==b'saved-original'
    assert cache.status()['pinned_bytes']==len(b'saved-original')


def test_cache_size_reduction_refuses_to_delete_existing_files(isolated_cache,monkeypatch):
    ident=cache.key('saved');cache.put(ident,b'1234567890','image/png',pin='tour')
    monkeypatch.setattr(cache,'GIB',8)  # Exercise quota behavior without creating gigabytes of test data.
    with pytest.raises(ValueError,match='already stored'):cache.set_limit(1)
    assert cache.get(ident)['path'].read_bytes()==b'1234567890'
    assert not (cache.ROOT/'settings.json').exists()
