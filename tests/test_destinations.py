import math
from fastapi.testclient import TestClient
from app import app
from destination_catalog import CATALOG,DESTINATIONS
from object_research import Target,object_id


def test_fifty_unique_catalog_anchored_destinations_all_use_visible_dss2():
    assert len(DESTINATIONS)==50
    assert len({d['id'] for d in DESTINATIONS})==len({d['object_id'] for d in DESTINATIONS})==50
    assert {d['category'] for d in DESTINATIONS}=={'Nebulae','Galaxies','Star clusters','Stellar remnants','Stars & planets'}
    assert CATALOG['coordinate_frame']=='ICRS' and CATALOG['coordinate_source']=='CDS SIMBAD TAP'
    for d in DESTINATIONS:
        assert d['survey']=='optical' and 0<=d['ra']<360 and -90<=d['dec']<=90 and .05<=d['fov']<=6
        assert d['source_url'].startswith('https://simbad.cds.unistra.fr/simbad/sim-id?Ident=')
        assert d['research_name'] and d['description'] and d['object_id'].startswith('simbad:')


def test_original_favorites_remain_and_use_useful_optical_framing():
    entries={d['id']:d for d in DESTINATIONS}
    assert {'pillars','carina','orion','quintet','andromeda','trappist'}<=entries.keys()
    assert entries['andromeda']['fov']>=4 and entries['ring']['fov']<.2
    assert math.isclose(entries['orion']['ra'],83.8201,abs_tol=.0001)
    assert math.isclose(entries['orion']['dec'],-5.3876,abs_tol=.0001)
    assert 'not resolved' in entries['trappist']['description']


def test_shortcuts_share_research_identity_with_live_simbad_markers():
    for d in DESTINATIONS:
        target=Target(id=d['object_id'],name=d['research_name'],catalog=d['catalog'],ra=d['ra'],dec=d['dec'])
        marker=target.model_copy(update={'id':' '.join(d['object_id'].split()),'name':d['object_id'][7:]})
        assert object_id(target)==object_id(marker)


def test_app_serves_catalog_without_generating_research_or_audio():
    response=TestClient(app).get('/api/config');assert response.status_code==200
    config=response.json();assert config['destinations']==DESTINATIONS
    optical=next(s for s in config['surveys'] if s['id']=='optical')
    assert optical['url']=='https://alasky.cds.unistra.fr/DSS/DSSColor' and 'DSS2' in optical['name']
