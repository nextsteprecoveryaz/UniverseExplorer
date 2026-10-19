import asyncio
import io
import json
import sqlite3
import pytest
from fastapi.testclient import TestClient
from PIL import Image
from app import app
import discovery_notebook as notebook
import expeditions
import science


@pytest.fixture
def client(tmp_path,monkeypatch):
    async def no_details(name):return None
    monkeypatch.setattr(notebook.object_facts,'lookup',no_details)
    monkeypatch.setattr(notebook,'PATH',tmp_path/'notes.sqlite3')
    monkeypatch.setattr(expeditions,'PATH',tmp_path/'routes.sqlite3')
    images=tmp_path/'images';images.mkdir();monkeypatch.setattr(science,'IMAGES',images)
    monkeypatch.setattr(notebook,'PENDING',{})
    tasks=[]
    class Pool:
        def submit(self,*args):tasks.append(args)
    monkeypatch.setattr(notebook,'POOL',Pool())
    c=TestClient(app);c.tasks=tasks;return c


def add(client,**kw):
    response=client.post('/api/notes',json={'title':'My sky discovery','ra':10.68471,'dec':41.26875,'provenance':{'fov':.5,'search_radius_arcsec':15},'research_on_save':False,**kw})
    assert response.status_code==200,response.text
    return response.json()


def candidate(**kw):
    return {'id':'simbad:M 31','name':'M 31','ra':10.68471,'dec':41.26875,'type':'Galaxy','type_code':'G','catalog':'SIMBAD','source_url':'https://simbad.cds.unistra.fr/simbad/sim-id?Ident=M31',**kw}


def researched(client,**kw):
    note=add(client,**kw);result={'catalog_available':True,'candidates':[{**candidate(),'separation_arcsec':0}]}
    return notebook.write_research(note['id'],notebook.compose(note,result))


def test_schema_migration_preserves_legacy_notes_and_creates_backup(client):
    with sqlite3.connect(notebook.PATH) as c:
        c.execute('CREATE TABLE notes (id TEXT PRIMARY KEY,created_at TEXT,title TEXT,body TEXT,ra REAL,dec REAL,survey TEXT,kind TEXT,provenance TEXT)')
        c.execute('INSERT INTO notes VALUES(?,?,?,?,?,?,?,?,?)',('a'*32,'2026-01-01','Legacy','Keep this',0,0,'optical','field','{"fov":1}'))
    notes=client.get('/api/notes').json()['rows'];assert notes[0]['body']=='Keep this' and notes[0]['revision']==1
    assert notes[0]['provenance']=={'fov':1} and notes[0]['research']=={}
    assert len(list(notebook.PATH.parent.glob('*-before-stories-*.sqlite3')))==1
    client.get('/api/notes');assert len(list(notebook.PATH.parent.glob('*-before-stories-*.sqlite3')))==1


def test_save_queues_research_once_and_returns_immediately(client,monkeypatch):
    async def objects(*args):return {'rows':[candidate()],'catalog_available':True,'stale':False}
    monkeypatch.setattr(notebook.object_map,'objects',objects)
    note=add(client,research_on_save=True);assert note['research']['status']=='queued' and len(client.tasks)==1
    assert client.post('/api/notebook/'+note['id']+'/research').status_code==202 and len(client.tasks)==1
    fn,*args=client.tasks.pop();fn(*args)
    saved=client.get('/api/notebook/'+note['id']).json()
    assert saved['research']['status']=='ready' and 'M 31' in saved['research']['story']
    assert len(saved['research']['sources'])==2 and saved['id'] not in notebook.PENDING


def test_no_coordinates_do_not_trigger_research(client):
    note=add(client,ra=None,dec=None,research_on_save=True)
    assert not client.tasks
    assert client.post('/api/notebook/'+note['id']+'/research').status_code==422


def test_catalog_matching_uses_clicked_position_not_map_center_and_handles_wrap(client):
    n=add(client,ra=359.999,dec=0,provenance={'view':{'ra':40,'dec':50},'search_radius_arcsec':15})
    rows=notebook.candidates_for(n,{'rows':[candidate(id='near',ra=.001,dec=0),candidate(id='far',ra=40,dec=50)]})
    assert [r['id'] for r in rows]==['near'] and rows[0]['separation_arcsec']==pytest.approx(7.2)


def test_crowded_galaxy_nucleus_prefers_its_close_published_field_guide(client):
    note=add(client)
    galaxy=next(o for o in notebook.object_map.FEATURED if o['id']=='andromeda')
    research={'catalog_available':True,'candidates':[{**candidate(id='nucleus-part'),'separation_arcsec':.8},{**galaxy,'separation_arcsec':1.8}]}
    result=notebook.compose(note,research)
    assert result['selected_id']=='andromeda' and 'Several catalog entries' in result['message']
    assert 'Andromeda' in result['story']
    assert notebook.compose(note,research,'nucleus-part')['selected_id']=='nucleus-part'


@pytest.mark.parametrize('available,status',[(True,'unidentified'),(False,'unavailable')])
def test_unmatched_or_offline_field_never_claims_new_object(client,available,status):
    note=add(client);result=notebook.compose(note,{'candidates':[],'catalog_available':available})
    assert result['status']==status and result['selected_id'] is None
    assert 'No object identity was established' in result['story'] and 'does not mean' in result['story']


def test_failure_keeps_previous_story_and_original_note(client,monkeypatch):
    note=researched(client,body='My observation')
    async def broken(*args):raise TimeoutError('offline')
    monkeypatch.setattr(notebook.object_map,'objects',broken)
    notebook.start_research(note['id']);fn,*args=client.tasks.pop();fn(*args)
    saved=notebook.read(note['id']);assert saved['research']['status']=='failed'
    assert saved['body']=='My observation' and saved['research']['story']==note['research']['story']


def test_edited_narration_survives_new_research_and_conflicts_are_explicit(client,monkeypatch):
    note=researched(client);path='/api/notebook/'+note['id']+'/story'
    response=client.put(path,json={'revision':note['revision'],'narration':'My carefully edited narration.'});assert response.status_code==200
    assert client.put(path,json={'revision':note['revision'],'narration':'Stale text'}).status_code==409
    async def objects(*args):return {'rows':[candidate()],'catalog_available':True}
    monkeypatch.setattr(notebook.object_map,'objects',objects)
    notebook.start_research(note['id']);assert client.put(path,json={'revision':response.json()['revision'],'narration':'Busy edit'}).status_code==409
    fn,*args=client.tasks.pop();fn(*args)
    assert notebook.read(note['id'])['research']['edited_narration']=='My carefully edited narration.'


def test_match_selection_only_accepts_returned_candidates_and_keeps_coordinates(client):
    note=researched(client);r=note['research'];r['candidates'].append({**candidate(id='second',name='Second source'),'separation_arcsec':5})
    note=notebook.write_research(note['id'],r);url='/api/notebook/'+note['id']+'/identify'
    assert client.put(url,json={'revision':note['revision'],'candidate_id':'invented'}).status_code==422
    changed=client.put(url,json={'revision':note['revision'],'candidate_id':'second'}).json()
    assert changed['research']['selected_id']=='second' and changed['ra']==note['ra'] and changed['dec']==note['dec']


def test_deleted_note_is_not_resurrected_by_background_research(client):
    note=add(client,research_on_save=True);client.delete('/api/notes/'+note['id'])
    fn,*args=client.tasks.pop();fn(*args)
    assert client.get('/api/notebook/'+note['id']).status_code==404 and not notebook.PENDING


def test_restart_reports_interrupted_research_and_can_retry(client):
    note=add(client,research_on_save=True);notebook.PENDING.clear()
    assert notebook.read(note['id'])['research']['status']=='interrupted'
    assert client.post('/api/notebook/'+note['id']+'/research').json()['research']['status']=='queued'


def test_tour_keeps_selection_order_stories_sources_and_images_after_note_deletion(client):
    buf=io.BytesIO();Image.new('RGB',(60,40),'red').save(buf,format='PNG');image=science.import_image(buf.getvalue(),'saved-sky.png')
    first=researched(client,title='First discovery',provenance={'fov':.8,'image_id':image['id'],'snapshot_credit':'DSS / CDS'})
    second=researched(client,title='Second discovery',ra=20,dec=-30)
    selections=[{'id':n['id'],'revision':n['revision']} for n in [second,first]]
    response=client.post('/api/notebook/tour',json={'title':'My discoveries','narrator':'browser','entries':selections});assert response.status_code==200,response.text
    route=response.json();assert [s['title'] for s in route['stops']]==['Second discovery','First discovery']
    assert route['media'][1]['preview_url']==image['preview_url'] and route['media'][1]['narrator']=='browser'
    saved_story=route['media'][0]['narration'];client.delete('/api/notes/'+second['id'])
    assert client.get('/api/navigation/routes/'+route['id']).json()['media'][0]['narration']==saved_story
    bundle=client.get('/api/navigation/routes/'+route['id']+'/export').json()
    copied=client.post('/api/navigation/import',json=bundle);assert copied.status_code==200
    assert copied.json()['media'][0]['story_sources']==route['media'][0]['story_sources']
    assert copied.json()['stops'][1]['guide']['image_sha256']==image['sha256']


def test_tour_rejects_stale_duplicate_unresearched_or_unlocated_selections(client):
    note=researched(client);entry={'id':note['id'],'revision':note['revision']}
    assert client.post('/api/notebook/tour',json={'title':'T','entries':[entry,entry]}).status_code==422
    assert client.post('/api/notebook/tour',json={'title':'T','entries':[{**entry,'revision':1}]}).status_code==409
    unready=add(client);assert client.post('/api/notebook/tour',json={'title':'T','entries':[{'id':unready['id'],'revision':unready['revision']}]}).status_code==409
    assert client.post('/api/notebook/tour',json={'title':'T','entries':[]}).status_code==422


def test_imported_tour_cannot_inject_script_sources_or_arbitrary_file_paths(client):
    note=researched(client);route=client.post('/api/notebook/tour',json={'title':'T','entries':[{'id':note['id'],'revision':note['revision']}]}).json()
    bundle=client.get('/api/navigation/routes/'+route['id']+'/export').json();guide=bundle['route']['stops'][0]['guide']
    guide['sources']=[{'title':'bad','url':'javascript:alert(1)'}]
    assert client.post('/api/navigation/import',json=bundle).status_code==422
    guide['sources']=[];guide['image_id']='../../private'
    assert client.post('/api/navigation/import',json=bundle).status_code==422


def test_missing_local_snapshot_does_not_break_portable_tour_story(client):
    note=researched(client);guide={'note_id':note['id'],'note_revision':note['revision'],'narration':'Saved story','description':'Saved story','image_id':'f'*32,'image_sha256':'a'*64,'sources':[],'identity_label':'Field'}
    media=expeditions.resolve_notebook({'title':'Test','ra':0,'dec':0,'guide':guide})
    assert media['available'] and media['snapshot_missing'] and media['preview_url'] is None and media['narration']=='Saved story'


def test_hidden_field_labels_resolve_outside_tiny_click_radius(client,monkeypatch):
    note=add(client,ra=70.0314,dec=-.5449,provenance={'view':{'ra':70.0328,'dec':-.5475,'fov':.04},'search_radius_arcsec':3})
    galaxy=candidate(id='simbad:NGC  1635',name='NGC 1635',ra=70.0328375,dec=-.5475611,type_code='EmG',type='Emission-line galaxy')
    calls=[]
    async def objects(ra,dec,radius):
        calls.append((ra,dec,radius))
        return {'rows':[galaxy] if radius>.001 else [],'catalog_available':True}
    monkeypatch.setattr(notebook.object_map,'objects',objects)
    result=asyncio.run(notebook.investigate(note))
    assert len(calls)==2 and result['selected_id']==galaxy['id']
    assert result['candidates'][0]['match_scope']=='field' and 'wider field' in result['message']
    assert result['identity_label'].startswith('NGC 1635 · in the saved field')
    assert notebook.read(note['id'])['ra']==70.0314


def test_explicit_named_label_beats_closer_star_and_rejects_off_field_name(client,monkeypatch):
    note=add(client,provenance={'object_hint':{'name':'M31'},'fov':.1,'search_radius_arcsec':3})
    star=candidate(id='star',name='Star',ra=note['ra']+.00001)
    named={**candidate(),'name':'M31','measurements':{},'distances':[],'constellation':'Andromeda'}
    async def objects(*args):return {'rows':[star],'catalog_available':True}
    async def lookup(name):return named if name in ('M31','M 31') else None
    monkeypatch.setattr(notebook.object_map,'objects',objects);monkeypatch.setattr(notebook.object_facts,'lookup',lookup)
    result=asyncio.run(notebook.investigate(note));assert result['selected_id']==named['id']
    named['ra']=50
    result=asyncio.run(notebook.investigate(note));assert result['selected_id']=='star'


def test_fact_refresh_keeps_manual_script_and_immutable_tour(client,monkeypatch):
    note=researched(client)
    note=client.put('/api/notebook/'+note['id']+'/story',json={'revision':note['revision'],'narration':'My original narration.'}).json()
    route=client.post('/api/notebook/tour',json={'title':'Keep my story','entries':[{'id':note['id'],'revision':note['revision']}]}).json()
    async def objects(*args):return {'rows':[candidate()],'catalog_available':True}
    async def lookup(name):return {**candidate(),'measurements':{},'distances':[],'constellation':'Andromeda'}
    monkeypatch.setattr(notebook.object_map,'objects',objects);monkeypatch.setattr(notebook.object_facts,'lookup',lookup)
    notebook.start_research(note['id']);fn,*args=client.tasks.pop();fn(*args)
    updated=notebook.read(note['id'])
    assert 'constellation Andromeda' in updated['research']['story']
    assert updated['research']['edited_narration']=='My original narration.'
    assert client.get('/api/navigation/routes/'+route['id']).json()['media'][0]['narration']=='My original narration.'


def test_failed_catalog_refresh_preserves_existing_draft(client,monkeypatch):
    note=researched(client)
    async def offline(*args):return {'rows':[],'catalog_available':False}
    monkeypatch.setattr(notebook.object_map,'objects',offline)
    notebook.start_research(note['id']);fn,*args=client.tasks.pop();fn(*args)
    updated=notebook.read(note['id'])
    assert updated['research']['status']=='failed' and updated['research']['story']==note['research']['story']


def test_switching_match_enriches_new_object_without_overwriting_concurrent_edit(client,monkeypatch):
    note=researched(client);other={**candidate(id='other',name='Other galaxy'),'separation_arcsec':1}
    r={**note['research'],'candidates':note['research']['candidates']+[other]}
    note=notebook.write_research(note['id'],r)
    async def lookup(name):
        notebook.write_research(note['id'],{**r,'edited_narration':'Concurrent change'})
        return None
    monkeypatch.setattr(notebook.object_facts,'lookup',lookup)
    response=client.put('/api/notebook/'+note['id']+'/identify',json={'revision':note['revision'],'candidate_id':'other'})
    assert response.status_code==409 and notebook.read(note['id'])['research']['edited_narration']=='Concurrent change'


@pytest.mark.parametrize('diameter,expected',[(2,'parent'),(.1,'supernova')])
def test_field_guide_prefers_named_galaxy_only_when_its_measured_extent_reaches_point(client,monkeypatch,diameter,expected):
    note=add(client,ra=10,dec=10,provenance={'fov':.1,'search_radius_arcsec':3})
    supernova=candidate(id='supernova',name='SN 1999cl',ra=10.006,dec=10)
    parent=candidate(id='parent',name='M 88',ra=10.01,dec=10)
    async def objects(*args):return {'rows':[supernova,parent],'catalog_available':True}
    async def lookup(name):
        if name!='M 88':return None
        return {**parent,'measurements':{'galdim_majaxis':diameter},'distances':[],'constellation':'Virgo'}
    monkeypatch.setattr(notebook.object_map,'objects',objects);monkeypatch.setattr(notebook.object_facts,'lookup',lookup)
    result=asyncio.run(notebook.investigate(note))
    assert result['selected_id']==expected
    note['research']={**result,'selected_id':'supernova','selection_method':'manual'}
    assert asyncio.run(notebook.investigate(note))['selected_id']=='supernova'
