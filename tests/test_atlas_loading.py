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
    monkeypatch.setattr(atlas,'TILE_PREFERRED',{})
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
    def fetch(url,**kwargs):
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
    def fetch(url,**kwargs):
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
    calls=[]
    def missing(url,**kwargs):
        calls.append(url)
        response=httpx.Response(404,request=httpx.Request('GET',url));response.raise_for_status()
    monkeypatch.setattr(atlas,'read_remote',missing)
    with TestClient(app) as client:
        r=client.get('/api/atlas/surveys/optical/Norder1/Dir0/Npix1.jpg')
    assert r.status_code==404 and 'no tile' in r.json()['detail']
    assert atlas.TILE_PENDING=={}
    assert len(calls)==1  # Genuine missing coverage must not become a mirror retry.


def test_tls_failure_recovers_identical_survey_tile_and_remembers_mirror(isolated_cache,monkeypatch,caplog):
    calls=[];canonical=atlas.SURVEYS['optical']['url'];mirror=atlas.TILE_MIRRORS[canonical][0]
    part='Norder9/Dir1200000/Npix1201512.jpg';primary_healthy=False
    def fetch(url,**kwargs):
        calls.append(url)
        assert kwargs['timeout'].connect==4 and kwargs['timeout'].read==18
        if url.startswith(canonical) and not primary_healthy:
            raise httpx.ConnectTimeout('TLS handshake timed out; private diagnostic')
        return b'same-publisher-jpeg','image/jpeg'
    monkeypatch.setattr(atlas,'read_remote',fetch)
    response=atlas.survey_tile('optical',part)
    assert calls==[canonical+'/'+part,mirror+'/'+part]
    assert response.body==b'same-publisher-jpeg'
    assert response.headers['X-Atlas-Retrieval-URL']==mirror+'/'+part
    cached=cache.get(cache.key('tile:'+canonical+'/'+part))
    assert cached['metadata']['source_url']==canonical+'/'+part
    assert cached['metadata']['retrieval_url']==mirror+'/'+part
    assert cached['path'].read_bytes()==b'same-publisher-jpeg'
    assert cache.get(cache.key('tile:'+mirror+'/'+part)) is None
    assert 'host=alasky.cds.unistra.fr error=ConnectTimeout' in caplog.text
    assert 'private diagnostic' not in caplog.text
    expiry=atlas.TILE_PREFERRED[canonical]['until']
    calls.clear();second=part.replace('1201512','1201513')
    assert atlas.survey_tile('optical',second).body==b'same-publisher-jpeg'
    assert calls==[mirror+'/'+second]
    assert atlas.TILE_PREFERRED[canonical]['until']==expiry  # Preference is temporary, not extended by every tile.
    atlas.TILE_PREFERRED[canonical]['until']=0;primary_healthy=True
    calls.clear();third=part.replace('1201512','1201514')
    assert atlas.survey_tile('optical',third).headers['X-Atlas-Retrieval-URL']==canonical+'/'+third
    assert calls==[canonical+'/'+third]
    assert canonical not in atlas.TILE_PREFERRED


def test_server_error_recovery_is_shared_by_simultaneous_tile_requests(isolated_cache,monkeypatch):
    started=threading.Event();release=threading.Event();calls=[]
    canonical=atlas.SURVEYS['optical']['url'];part='Norder9/Dir1200000/Npix1201512.jpg'
    def fetch(url,**kwargs):
        calls.append(url)
        if url.startswith(canonical):
            response=httpx.Response(503,request=httpx.Request('GET',url));response.raise_for_status()
        started.set();assert release.wait(5)
        return b'mirror-original-pixels','image/jpeg'
    monkeypatch.setattr(atlas,'read_remote',fetch)
    with ThreadPoolExecutor(max_workers=6) as workers:
        first=workers.submit(atlas.survey_tile,'optical',part)
        try:
            assert started.wait(3)
            duplicates=[workers.submit(atlas.survey_tile,'optical',part) for _ in range(4)]
        finally:release.set()
        assert all(result.result(timeout=3).body==b'mirror-original-pixels' for result in [first,*duplicates])
    assert len(calls)==2 and atlas.TILE_PENDING=={}


@pytest.mark.parametrize('prefer_mirror',[False,True])
def test_closed_keepalive_retries_same_source_once(isolated_cache,monkeypatch,caplog,prefer_mirror):
    canonical=atlas.SURVEYS['sdss-color']['url'];mirror=atlas.TILE_MIRRORS[canonical][0]
    part='Norder3/Dir0/Npix152.jpg';source=mirror if prefer_mirror else canonical;calls=[]
    if prefer_mirror:
        atlas.TILE_PREFERRED[canonical]={'base':mirror,'until':atlas.time.monotonic()+120}
    def fetch(url,**kwargs):
        calls.append(url)
        assert url==source+'/'+part
        if len(calls)==1:raise httpx.RemoteProtocolError('private connection details')
        return b'original-sdss-pixels','image/jpeg'
    monkeypatch.setattr(atlas,'read_remote',fetch)
    response=atlas.survey_tile('sdss-color',part)
    assert calls==[source+'/'+part,source+'/'+part]
    assert response.body==b'original-sdss-pixels'
    assert response.headers['X-Atlas-Retrieval-URL']==source+'/'+part
    assert 'error=RemoteProtocolError retry_same_host=True' in caplog.text
    assert 'private connection details' not in caplog.text


def test_repeated_protocol_failure_falls_back_after_one_same_host_retry(isolated_cache,monkeypatch):
    canonical=atlas.SURVEYS['sdss-color']['url'];mirror=atlas.TILE_MIRRORS[canonical][0]
    part='Norder3/Dir0/Npix141.jpg';calls=[]
    def fetch(url,**kwargs):
        calls.append(url)
        if url.startswith(canonical+'/'):raise httpx.RemoteProtocolError('connection closed')
        return b'mirror-sdss-pixels','image/jpeg'
    monkeypatch.setattr(atlas,'read_remote',fetch)
    assert atlas.survey_tile('sdss-color',part).body==b'mirror-sdss-pixels'
    assert calls==[canonical+'/'+part,canonical+'/'+part,mirror+'/'+part]


def test_protocol_retries_are_bounded_when_all_sources_fail(isolated_cache,monkeypatch):
    canonical=atlas.SURVEYS['sdss-color']['url'];mirror=atlas.TILE_MIRRORS[canonical][0]
    part='Norder3/Dir0/Npix141.jpg';calls=[]
    def fetch(url,**kwargs):
        calls.append(url);raise httpx.RemoteProtocolError('connection closed')
    monkeypatch.setattr(atlas,'read_remote',fetch)
    with TestClient(app) as client:
        response=client.get('/api/atlas/surveys/sdss-color/'+part)
    assert response.status_code==503
    assert calls==[canonical+'/'+part,canonical+'/'+part,mirror+'/'+part,mirror+'/'+part]
    assert atlas.TILE_PENDING=={} and cache.status()['files']==0


@pytest.mark.parametrize('failure',[httpx.ConnectTimeout,httpx.ReadTimeout])
def test_timeouts_do_not_gain_extra_same_host_retries(isolated_cache,monkeypatch,failure):
    calls=[]
    def fetch(url,**kwargs):
        calls.append(url);raise failure('timeout')
    monkeypatch.setattr(atlas,'read_remote',fetch)
    with pytest.raises(failure):
        atlas.read_tile_remote(atlas.SURVEYS['sdss-color']['url']+'/Norder3/Dir0/Npix141.jpg')
    assert len(calls)==2 and calls[0]!=calls[1]


def test_failed_primary_and_mirror_are_bounded_and_later_request_can_recover(isolated_cache,monkeypatch):
    calls=[];healthy=False
    def fetch(url,**kwargs):
        calls.append(url)
        if not healthy:raise httpx.ReadTimeout('temporarily unavailable')
        return b'recovered','image/jpeg'
    monkeypatch.setattr(atlas,'read_remote',fetch)
    with TestClient(app) as client:
        path='/api/atlas/surveys/optical/Norder9/Dir1200000/Npix1201512.jpg'
        assert client.get(path).status_code==503
        assert len(calls)==2 and atlas.TILE_PENDING=={}
        assert cache.status()['files']==0
        healthy=True
        result=client.get(path)
        assert result.status_code==200 and result.content==b'recovered'
        assert len(calls)==3 and cache.status()['files']==1


@pytest.mark.parametrize('status',[401,403,404,429])
def test_non_transient_status_does_not_switch_to_another_server(isolated_cache,monkeypatch,status):
    calls=[]
    def fetch(url,**kwargs):
        calls.append(url)
        response=httpx.Response(status,request=httpx.Request('GET',url));response.raise_for_status()
    monkeypatch.setattr(atlas,'read_remote',fetch)
    with pytest.raises(httpx.HTTPStatusError):
        atlas.read_tile_remote(atlas.SURVEYS['optical']['url']+'/Norder1/Dir0/Npix1.jpg')
    assert len(calls)==1 and not atlas.TILE_PREFERRED


def test_unverified_survey_has_no_invented_mirror_and_pool_timeout_is_not_host_failure(isolated_cache,monkeypatch):
    calls=[]
    def fetch(url,**kwargs):
        calls.append(url);raise httpx.PoolTimeout('local pool occupied')
    monkeypatch.setattr(atlas,'read_remote',fetch)
    with pytest.raises(httpx.PoolTimeout):
        atlas.read_tile_remote(atlas.SURVEYS['optical']['url']+'/properties')
    assert len(calls)==1
    calls.clear()
    def disconnected(url,**kwargs):
        calls.append(url);raise httpx.ConnectError('unavailable')
    monkeypatch.setattr(atlas,'read_remote',disconnected)
    with pytest.raises(httpx.ConnectError):
        atlas.read_tile_remote('https://example.test/custom-survey/Norder1/Dir0/Npix1.jpg')
    assert len(calls)==1


def test_fast_tile_timeouts_leave_unmirrored_lenses_and_science_unchanged(isolated_cache,monkeypatch):
    requests=[]
    def respond(request):
        requests.append(request)
        return httpx.Response(200,content=b'pixels',headers={'content-type':'image/jpeg'})
    with httpx.Client(transport=httpx.MockTransport(respond),timeout=httpx.Timeout(90,connect=12,pool=15)) as client:
        monkeypatch.setattr(atlas,'remote_client',lambda:client)
        atlas.read_tile_remote(atlas.SURVEYS['optical']['url']+'/Norder1/Dir0/Npix1.jpg')
        atlas.read_tile_remote('https://example.test/custom-survey/Norder1/Dir0/Npix1.jpg')
        atlas.read_remote('https://example.test/science-cutout',{'fov':.1})
    assert requests[0].extensions['timeout']=={'connect':4,'read':18,'write':18,'pool':5}
    assert requests[1].extensions['timeout']=={'connect':12,'read':90,'write':90,'pool':15}
    assert requests[2].extensions['timeout']=={'connect':12,'read':90,'write':90,'pool':15}


@pytest.mark.parametrize('survey_id,part',[
    ('sdss-color','Norder8/Dir170000/Npix176429.jpg'),
    ('sdss-g','Norder10/Dir4640000/Npix4643549.png'),
    ('sdss-r','Norder10/Dir4640000/Npix4643549.png'),
    ('sdss-i','Norder10/Dir4640000/Npix4643549.png'),
    ('2mass','Norder9/Dir2110000/Npix2118624.jpg'),
])
def test_sdss_and_near_infrared_recover_exact_selected_survey(isolated_cache,monkeypatch,survey_id,part):
    canonical=atlas.SURVEYS[survey_id]['url'];mirror=atlas.TILE_MIRRORS[canonical][0];calls=[]
    def fetch(url,**kwargs):
        calls.append(url)
        if url==canonical+'/'+part:raise httpx.ConnectTimeout('primary unavailable')
        assert url==mirror+'/'+part
        return b'original-selected-survey-pixels','image/png' if part.endswith('.png') else 'image/jpeg'
    monkeypatch.setattr(atlas,'read_remote',fetch)
    response=atlas.survey_tile(survey_id,part)
    assert calls==[canonical+'/'+part,mirror+'/'+part]
    assert response.body==b'original-selected-survey-pixels'
    assert response.headers['X-Atlas-Retrieval-URL']==mirror+'/'+part
    item=cache.get(cache.key('tile:'+canonical+'/'+part))
    assert item['metadata']['source_url']==canonical+'/'+part
    assert item['metadata']['retrieval_url']==mirror+'/'+part


def test_sdss_mirror_missing_coverage_is_not_a_connection_failure(isolated_cache,monkeypatch):
    canonical=atlas.SURVEYS['sdss-color']['url'];mirror=atlas.TILE_MIRRORS[canonical][0];calls=[]
    def fetch(url,**kwargs):
        calls.append(url)
        if url.startswith(canonical+'/'):raise httpx.ConnectTimeout('primary unavailable')
        response=httpx.Response(404,request=httpx.Request('GET',url));response.raise_for_status()
    monkeypatch.setattr(atlas,'read_remote',fetch)
    with TestClient(app) as client:
        first=client.get('/api/atlas/surveys/sdss-color/Norder10/Dir8470000/Npix8474377.jpg')
        assert first.status_code==404 and 'no tile' in first.json()['detail']
        assert len(calls)==2
        expiry=atlas.TILE_PREFERRED[canonical]['until']
        second=client.get('/api/atlas/surveys/sdss-color/Norder10/Dir8470000/Npix8474378.jpg')
        assert second.status_code==404
    assert len(calls)==3 and calls[-1].startswith(mirror+'/')
    assert atlas.TILE_PREFERRED[canonical]['until']==expiry
    assert atlas.TILE_PENDING=={} and cache.status()['files']==0


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


CEFCA_LEGACY=(b'processingDate = 22/06/15 12:21:43\ncoordsys = C\nisColored = true\n'
              b'HiPSBuilder = Aladin/HipsGen v8.040\nlabel = web_in\nmaxOrder = 10\nformat = jpeg\n')


def parsed_properties(raw):
    return {k.strip():v.strip() for line in raw.decode().splitlines()
            if '=' in line for k,v in [line.split('=',1)]}


def test_cefca_legacy_properties_are_compatible_without_inventing_higher_detail():
    result=parsed_properties(atlas.rewrite_survey_properties('cefca-virgo',CEFCA_LEGACY))
    assert result['hips_frame']=='equatorial'
    assert result['hips_order']=='10'  # The legacy web viewer incorrectly hardcodes order 11.
    assert result['hips_tile_format']=='jpeg'
    assert result['maxOrder']=='10' and result['coordsys']=='C'
    assert result['processingDate']=='22/06/15 12:21:43'
    assert result['hips_service_url']=='http://127.0.0.1:8765/api/atlas/surveys/cefca-virgo'
    assert result['obs_title']=='CEFCA Virgo Cluster'
    other=parsed_properties(atlas.rewrite_survey_properties('optical',CEFCA_LEGACY))
    assert 'hips_frame' not in other and 'hips_order' not in other


def test_cefca_modern_properties_are_preserved_and_remote_mirrors_cannot_bypass_cache():
    raw=CEFCA_LEGACY+(b'hips_frame = equatorial\nhips_order = 9\nhips_tile_format = png\n'
                      b'obs_title = Published updated title\n'
                      b'hips_service_url = https://www.cefca.es/img/aladin/VirgoCluster\n'
                      b'hips_service_url_1 = https://mirror.example.test\n')
    rewritten=atlas.rewrite_survey_properties('cefca-virgo',raw)
    result=parsed_properties(rewritten)
    assert result['hips_order']=='9' and result['hips_tile_format']=='png'
    assert result['obs_title']=='Published updated title'
    assert 'hips_service_url_1' not in result
    assert 'https://' not in result['hips_service_url']
    assert parsed_properties(atlas.rewrite_survey_properties('cefca-virgo',rewritten))==result


@pytest.mark.parametrize('raw',[
    CEFCA_LEGACY.replace(b'coordsys = C',b'coordsys = G'),
    CEFCA_LEGACY.replace(b'maxOrder = 10',b'maxOrder = 99'),
    CEFCA_LEGACY.replace(b'format = jpeg',b'format = svg'),
])
def test_invalid_cefca_legacy_metadata_is_not_silently_guessed(raw):
    with pytest.raises(ValueError):atlas.rewrite_survey_properties('cefca-virgo',raw)


def test_cefca_cached_legacy_properties_work_offline_without_rewriting_image_pixels(isolated_cache,monkeypatch):
    base='https://www.cefca.es/img/aladin/VirgoCluster'
    monkeypatch.setitem(atlas.SURVEYS,'cefca-virgo',{'id':'cefca-virgo','url':base,'name':'CEFCA Virgo Cluster','rendered_views':False})
    metadata={'created_at':'2000-01-01T00:00:00+00:00'}
    cache.put(cache.key('tile:'+base+'/properties'),CEFCA_LEGACY,'text/plain',metadata)
    tile='Norder10/Dir7100000/Npix7108082.jpg';pixels=b'publisher-jpeg-bytes'
    cache.put(cache.key('tile:'+base+'/'+tile),pixels,'image/jpeg',metadata)
    monkeypatch.setattr(atlas,'CACHED_ONLY',True)
    monkeypatch.setattr(atlas,'read_remote',lambda *a,**kw:pytest.fail('Cached-only mode must not fetch'))
    result=atlas.survey_tile('cefca-virgo','properties')
    assert parsed_properties(result.body)['hips_order']=='10'
    assert parsed_properties(result.body)['hips_frame']=='equatorial'
    assert result.headers['X-Atlas-Cache']=='stale'
    assert atlas.survey_tile('cefca-virgo',tile).body==pixels


def test_unsupported_individual_rendered_views_fail_before_queueing(isolated_cache,monkeypatch):
    survey={'id':'cefca-virgo','url':'https://www.cefca.es/img/aladin/VirgoCluster',
            'name':'CEFCA Virgo Cluster','rendered_views':False}
    monkeypatch.setitem(atlas.SURVEYS,'cefca-virgo',survey)
    monkeypatch.setattr(atlas.expeditions,'SURVEYS',atlas.expeditions.SURVEYS|{'cefca-virgo'})
    monkeypatch.setattr(atlas,'begin',lambda *a,**kw:pytest.fail('Unsupported downloads must not be queued'))
    monkeypatch.setattr(atlas,'read_remote',lambda *a,**kw:pytest.fail('Unsupported downloads must not fetch'))
    with TestClient(app) as client:
        response=client.post('/api/atlas/view',json={'ra':187.7,'dec':12.4,'fov':.2,'survey':'cefca-virgo'})
        assert response.status_code==409
        assert 'Interactive survey tiles remain available' in response.json()['detail']
    assert cache.status()['files']==0
