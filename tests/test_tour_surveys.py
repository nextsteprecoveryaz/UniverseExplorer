"""One continuous survey per tour, with lossless saved routes and survey-only packs."""
from copy import deepcopy
import io
import json

from fastapi.testclient import TestClient
from PIL import Image
import pytest

from app import app
import atlas
import atlas_cache as cache
import cefca_tours
import expeditions as routes
import recent_archive as archive
import tour_surveys
import webb_gallery as gallery


@pytest.fixture
def isolated(tmp_path, monkeypatch):
    monkeypatch.setattr(routes, 'PATH', tmp_path/'routes.sqlite3')
    monkeypatch.setattr(archive, 'PATH', tmp_path/'archive.sqlite3')
    monkeypatch.setattr(gallery, 'PATH', tmp_path/'gallery.sqlite3')
    monkeypatch.setattr(cache, 'ROOT', tmp_path/'cache')
    monkeypatch.setattr(cache, 'LIMIT', 8*cache.GIB)
    monkeypatch.setattr(atlas, 'JOBS', {})
    monkeypatch.setattr(atlas, 'CACHED_ONLY', False)
    class Immediate:
        def submit(self, work):
            work()
    monkeypatch.setattr(atlas, 'DOWNLOADS', Immediate())
    return TestClient(app)


@pytest.mark.parametrize('source_survey', ['webb-color', 'hubble-color', 'cefca-virgo', 'sdss-color', 'oxygen', 'unknown', None])
def test_new_source_waypoints_default_to_optical_for_sparse_or_unknown_surveys(source_survey):
    media={'kind':'featured', 'id':'target', 'title':'Target', 'ra':12, 'dec':-30, 'survey':source_survey}
    stop=routes.stop_for(media)
    assert stop.survey=='optical'
    assert stop.source.model_dump()=={'kind':'featured','id':'target'}
    assert media['survey']==source_survey


@pytest.mark.parametrize('survey', tour_surveys.ALLOWED_SURVEYS)
def test_supported_waypoint_surveys_are_available_and_explicit_choice_wins(survey):
    media={'kind':'featured', 'id':'target', 'name':'Target', 'ra':12, 'dec':-30, 'survey':survey}
    assert routes.stop_for(media).survey==survey
    assert routes.stop_for({**media,'survey':'webb-color'},survey).survey==survey
    assert routes.View(ra=12,dec=-30,survey=survey).survey==survey


@pytest.mark.parametrize('field,kind', [('stops','waypoints'), ('track','recording')])
def test_route_snapshot_changes_only_camera_surveys_and_owns_its_nested_data(field,kind):
    original={'id':'route','revision':4,'title':'Personal route','kind':kind,
        'stops':[],'track':[], 'progress':{'revision':4,'elapsed':9,'origin':{'ra':8,'dec':-1,'fov':20,'survey':'hubble-color'}},
        'media':[{'survey':'cefca-virgo','narration':'Published story.','source_url':'https://www.cefca.es/divulgacion/tour_cumulo_virgo','story_sources':[{'url':'https://example.test/paper'}]}]}
    original[field]=[{'ra':1,'dec':2,'fov':.2,'roll':14,'projection':'TAN','survey':'webb-color',
                      'notes':'Keep my notes.','travel':4,'hold':31,'t':0,'source':{'kind':'cefca','id':'virgo-m87'}},
                     {'ra':3,'dec':4,'fov':.4,'survey':'cefca-virgo','t':15}]
    before=deepcopy(original)
    for survey in tour_surveys.ALLOWED_SURVEYS:
        snapshot=tour_surveys.clone_route(original,survey)
        assert all(view['survey']==survey for view in snapshot[field])
        assert snapshot['progress']['origin']['survey']==survey
        assert snapshot['media']==original['media']
        expected=deepcopy(before)
        for view in expected[field]:view['survey']=survey
        expected['progress']['origin']['survey']=survey
        assert snapshot==expected
        snapshot[field][0]['source']['id']='changed'
        snapshot['media'][0]['story_sources'][0]['url']='changed'
        assert original==before
    assert tour_surveys.clone_route(original)[field][0]['survey']=='optical'


@pytest.mark.parametrize('survey', ['webb-color','hubble-color','cefca-virgo','sdss-color','https://example.test/hips','',None])
def test_explicit_unsupported_tour_choice_is_rejected_instead_of_silently_substituted(survey):
    with pytest.raises(ValueError,match='continuous-sky'):
        tour_surveys.clone_route({'stops':[],'track':[]},survey)


def test_all_new_templates_use_optical_even_when_sources_reference_other_surveys(isolated):
    photo={'id':'release1','title':'Galaxy and nebula','posted':1,'kind':'Published image',
           'ra':10,'dec':20,'description':'A published target.','image_url':'https://live.staticflickr.com/source.jpg','source_url':'https://example.test/release'}
    with gallery.connect() as c:
        c.execute('INSERT INTO photos VALUES(?,?,?,?,?,?,?)',('release1',photo['title'],1,photo['kind'],10,20,json.dumps(photo)))
    archive.store_page('sample',[{'objID':number,'obsid':number,'obs_id':'field'+str(number),'obs_collection':mission,
        's_ra':20+number,'s_dec':10,'t_min':61000,'target_name':'Field','jpegURL':'mast:'+mission+'/product/preview.jpg'}
        for number,mission in [(1,'HST'),(2,'JWST')]])
    with archive.connect() as c:archive.put(c,'complete',{'generation':'sample'})
    result=isolated.get('/api/navigation/templates')
    assert result.status_code==200
    templates=result.json()['rows']
    assert {'grand-tour','cefca-virgo','webb-galaxies','webb-nebulae','webb-releases','recent-hst','recent-jwst'}<={row['id'] for row in templates}
    assert all(stop['survey']=='optical' for row in templates for stop in row['stops'])
    cefca=next(row for row in templates if row['id']=='cefca-virgo')
    assert cefca['media'][0]['survey']=='cefca-virgo'
    assert cefca['media'][0]['narration']==cefca_tours.source('virgo-m87')['narration']
    assert cefca['stops'][0]['source']=={'kind':'cefca','id':'virgo-m87'}


def mixed_route():
    return {'title':'My historical route','kind':'waypoints','description':'Keep this description.',
        'stops':[{'title':'First','ra':1,'dec':2,'fov':.2,'survey':'webb-color','notes':'My note','travel':5,'hold':31},
                 {'title':'Second','ra':3,'dec':4,'fov':.3,'survey':'cefca-virgo'},
                 {'title':'Third','ra':5,'dec':6,'fov':.4,'survey':'hubble-color'}]}


def test_saved_route_read_export_and_database_remain_unchanged_after_pack_selection(isolated,monkeypatch):
    created=isolated.post('/api/navigation/routes',json=mixed_route()).json()
    ident=created['id']
    progress={'revision':1,'elapsed':12,'origin':{'ra':42,'dec':-4,'fov':30,'survey':'webb-200'}}
    assert isolated.put(f'/api/navigation/routes/{ident}/progress',json=progress).status_code==200
    original=isolated.get('/api/navigation/routes/'+ident).json()
    with routes.connect() as c:
        stored=c.execute('SELECT * FROM routes WHERE id=?',(ident,)).fetchone()
        before_route=tuple(stored)
        before_progress=c.execute('SELECT payload FROM progress WHERE route_id=?',(ident,)).fetchone()[0]
    monkeypatch.setattr(atlas,'survey_view',lambda view,pin:{'id':str(view['ra']),'url':'/saved','survey':view['survey']})
    response=isolated.post('/api/atlas/packs/'+ident+'?survey=2mass')
    assert response.status_code==200
    pack=response.json()['result']
    assert pack['survey']=='2mass'
    assert {stop['survey'] for stop in pack['route']['stops']}=={'2mass'}
    assert pack['route']['progress']['origin']['survey']=='2mass'
    assert pack['route']['stops'][0]['notes']=='My note' and pack['route']['stops'][0]['hold']==31
    assert isolated.get('/api/navigation/routes/'+ident).json()==original
    exported=isolated.get('/api/navigation/routes/'+ident+'/export').json()['route']
    assert [stop['survey'] for stop in exported['stops']]==['webb-color','cefca-virgo','hubble-color']
    imported=isolated.post('/api/navigation/import',json={'schema':'universe-explorer-route','version':1,'route':exported}).json()
    assert imported['stops']==original['stops']
    with routes.connect() as c:
        assert tuple(c.execute('SELECT * FROM routes WHERE id=?',(ident,)).fetchone())==before_route
        assert c.execute('SELECT payload FROM progress WHERE route_id=?',(ident,)).fetchone()[0]==before_progress


def test_pack_downloads_only_selected_survey_views_and_preserves_legacy_pack_files(isolated,monkeypatch):
    route={'id':'saved','revision':7,**mixed_route(),'media':[
        {'kind':'mast','id':'123','preview_url':'/api/archive-preview?uri=mast:JWST/product/preview.jpg'},
        {'kind':'gallery','id':'456','preview_url':'https://live.staticflickr.com/preview.jpg'},
        {'kind':'cefca','id':'virgo-m87','preview_url':None,'narration':'Keep this story.'}]}
    before=deepcopy(route)
    monkeypatch.setattr(routes,'read',lambda _:route)
    monkeypatch.setattr(archive,'observation',lambda *a:pytest.fail('Tour packs must never resolve archive previews'))
    output=io.BytesIO();Image.new('RGB',(768,768),(31,44,55)).save(output,format='PNG')
    calls=[]
    def fetch(url,params=None,max_bytes=None):
        assert url=='https://alasky.cds.unistra.fr/hips-image-services/hips2fits'
        calls.append(params)
        return output.getvalue(),'image/png'
    monkeypatch.setattr(atlas,'read_remote',fetch)
    legacy_id=cache.key('pack:saved:7');legacy_file=cache.key('legacy-preview')
    cache.put(legacy_file,b'old-photo-bytes','image/jpeg',{'source_url':'https://example.test/old'},legacy_id)
    legacy={'id':legacy_id,'route_id':'saved','state':'complete','route':deepcopy(route),'views':[{'preview_url':'/api/atlas/files/'+legacy_file}]}
    cache.save_pack(legacy)
    new_ids=[]
    for survey in tour_surveys.ALLOWED_SURVEYS:
        result=isolated.post('/api/atlas/packs/saved?survey='+survey)
        assert result.status_code==200
        pack=result.json()['result'];new_ids.append(pack['id'])
        assert pack['state']=='complete' and pack['survey']==survey
        assert {view['view']['survey'] for view in pack['views']}=={survey}
        assert all(set(view)=={'index','view'} for view in pack['views'])
        assert all(params['hips']==atlas.SURVEYS[survey]['url'] for params in calls[-3:])
        assert pack['route']['media']==route['media']
    assert len(set(new_ids))==4 and legacy_id not in new_ids
    assert len(calls)==12
    assert route==before
    assert cache.get(legacy_file)['path'].read_bytes()==b'old-photo-bytes'
    assert next(pack for pack in cache.packs() if pack['id']==legacy_id)==legacy
    default=isolated.post('/api/atlas/packs/saved').json()['result']
    assert default['survey']=='optical' and default['id']==new_ids[0]
    assert len(calls)==12  # The same survey snapshot reuses its saved view cache.


@pytest.mark.parametrize('survey',['webb-color','cefca-virgo','sdss-color','bogus','https://example.test/hips'])
def test_pack_rejects_unsupported_query_before_route_lookup_or_queueing(isolated,monkeypatch,survey):
    monkeypatch.setattr(routes,'read',lambda *a:pytest.fail('Unsupported selections must fail before route access'))
    monkeypatch.setattr(atlas,'begin',lambda *a:pytest.fail('Unsupported selections must not enqueue downloads'))
    assert isolated.post('/api/atlas/packs/saved',params={'survey':survey}).status_code==422


def test_pack_respects_render_capability_of_selected_survey_before_queueing(isolated,monkeypatch):
    monkeypatch.setattr(routes,'read',lambda _:{'id':'saved','revision':1,**mixed_route()})
    monkeypatch.setitem(atlas.SURVEYS,'2mass',{**atlas.SURVEYS['2mass'],'rendered_views':False})
    monkeypatch.setattr(atlas,'begin',lambda *a:pytest.fail('Unavailable rendered views must not be queued'))
    response=isolated.post('/api/atlas/packs/saved?survey=2mass')
    assert response.status_code==409
    assert 'Interactive survey tiles remain available' in response.json()['detail']
