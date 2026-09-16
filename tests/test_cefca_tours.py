import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app import app
import cefca_tours as cefca
import expeditions as routes
import recent_archive as archive
import webb_gallery as gallery


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(routes, 'PATH', tmp_path / 'routes.sqlite3')
    monkeypatch.setattr(archive, 'PATH', tmp_path / 'archive.sqlite3')
    monkeypatch.setattr(gallery, 'PATH', tmp_path / 'gallery.sqlite3')
    return TestClient(app)


def template(client):
    response = client.get('/api/navigation/templates')
    assert response.status_code == 200
    matches = [row for row in response.json()['rows'] if row.get('collection') == 'cefca']
    assert len(matches) == 1
    return matches[0]


def route_payload(tour):
    return {key: tour[key] for key in routes.Route.model_fields}


def test_published_waypoint_order_omits_unpositioned_intro_slides():
    expected_ids = [
        'm87', 'm86', 'm88', 'm90', 'm91', 'm58', 'ngc4298-ngc4302',
        'ngc4440', 'ngc4452', 'ngc4567-ngc4568', 'm89', 'm84',
        'ngc4425', 'ngc4429', 'ic3476', 'vcc846', 'vcc1413', 'ngc4438',
        'viii-zw186', 'vpc0880', 'distant-galaxy-cluster',
        'more-distant-galaxy-cluster', 'sdss-j122359-112800',
    ]
    items = cefca.media_items()
    assert [item['id'] for item in items] == ['virgo-' + ident for ident in expected_ids]
    assert len({item['id'] for item in items}) == 23
    for item in items:
        assert 185 < item['ra'] < 190 and 11 < item['dec'] < 15
        assert item['survey'] == 'cefca-virgo'
        assert item['preview_url'] is None
        assert routes.stop_for(item).source.kind == 'cefca'


@pytest.mark.parametrize('ident,position,fov', [
    ('virgo-m87', (187.7059304, 12.3911231), .2),
    ('virgo-m58', (189.4313417, 11.81811939), .2),
    ('virgo-vcc846', (186.460486, 13.197644), .04),
    ('virgo-viii-zw186', (186.11917, 13.38583), .05),
    ('virgo-vpc0880', (188.173607, 14.539521), .09),
    ('virgo-sdss-j122359-112800', (185.997291666, 11.4666666), .02),
])
def test_published_coordinates_and_field_sizes(ident, position, fov):
    item = cefca.source(ident)
    assert (item['ra'], item['dec']) == position
    assert item['fov'] == fov


def test_cefca_template_is_native_and_attributed(client):
    tour = template(client)
    assert tour['id'] == 'cefca-virgo'
    assert tour['source_url'] == cefca.SOURCE_URL
    assert tour['source_language'] == 'es'
    assert 'CEFCA Foundation' in tour['credit']
    assert tour['cover_url'] == '/assets/cefca-virgo.jpg'
    assert tour['kind'] == 'waypoints' and tour['track'] == []
    assert len(tour['stops']) == len(tour['media']) == 23
    assert tour['stops'][0]['title'] == 'M87'
    assert [stop['source']['id'] for stop in tour['stops']] == [item['id'] for item in tour['media']]
    assert routes.Route(**route_payload(tour)).stops[-1].fov == .02


def test_saved_exported_and_imported_routes_keep_source_credit(client):
    original = template(client)
    created = client.post('/api/navigation/routes', json=route_payload(original))
    assert created.status_code == 200
    saved = created.json()
    exported = client.get('/api/navigation/routes/' + saved['id'] + '/export')
    assert exported.status_code == 200
    bundle = exported.json()
    assert bundle['route']['stops'][0]['source'] == {'kind': 'cefca', 'id': 'virgo-m87'}
    imported = client.post('/api/navigation/import', json=bundle)
    assert imported.status_code == 200
    restored = imported.json()
    assert restored['id'] != saved['id']
    assert restored['stops'] == original['stops']
    for document in (saved, restored):
        for item in document['media']:
            assert item['source_url'] == cefca.SOURCE_URL
            assert item['credit'] == cefca.CREDIT
            assert item['description'] == cefca.source(item['id'])['description']
            assert item['available'] is True


def test_missing_cefca_source_preserves_editable_waypoint(client, monkeypatch):
    def forbid_gallery_lookup(*args):
        raise AssertionError('CEFCA references must not resolve through the Webb gallery')
    monkeypatch.setattr(gallery, 'photo', forbid_gallery_lookup)
    body = {'title': 'Missing reference', 'stops': [{
        'ra': 187.7, 'dec': 12.3, 'survey': 'cefca-virgo',
        'source': {'kind': 'cefca', 'id': 'virgo-missing'},
    }]}
    response = client.post('/api/navigation/routes', json=body)
    assert response.status_code == 200
    saved = response.json()
    assert saved['stops'][0]['ra'] == 187.7
    assert saved['stops'][0]['survey'] == 'cefca-virgo'
    assert saved['media'][0]['available'] is False
    assert 'source_url' not in saved['media'][0]
    assert 'preview_url' not in saved['media'][0]


@pytest.mark.parametrize('source', [
    {'kind': 'cefca', 'id': 'https://evil.invalid/tour'},
    {'kind': 'cefca', 'id': '../../private'},
    {'kind': 'cefca', 'id': 'virgo-m87', 'source_url': 'https://evil.invalid'},
    {'kind': 'cefca', 'id': 'virgo-m87', 'credit': 'Untrusted attribution'},
])
def test_import_cannot_inject_source_urls_or_override_attribution(client, source):
    bundle = {'schema': 'universe-explorer-route', 'version': 1, 'route': {
        'title': 'Untrusted source', 'stops': [{'ra': 187, 'dec': 12, 'source': source}],
    }}
    assert client.post('/api/navigation/import', json=bundle).status_code == 422


def test_cefca_survey_must_use_registered_identifier():
    assert routes.View(ra=187, dec=12, survey='cefca-virgo').survey == 'cefca-virgo'
    with pytest.raises(ValidationError):
        routes.View(ra=187, dec=12, survey=cefca.SURVEY_URL)


def test_source_results_cannot_mutate_the_trusted_registry():
    item = cefca.source('virgo-m87')
    item.update(ra=0, source_url='https://evil.invalid', description='changed')
    fresh = cefca.source('virgo-m87')
    assert fresh['ra'] == 187.7059304
    assert fresh['source_url'] == cefca.SOURCE_URL
    assert fresh['description'] != 'changed'
    with pytest.raises(ValueError):
        cefca.source('https://www.cefca.es/arbitrary')


def test_all_stops_have_researched_stories_and_separate_source_credits():
    for item in cefca.media_items():
        assert 40 <= len(item['narration'].split()) <= 110
        assert item['description'] == item['narration'] != item['navigation_note']
        assert item['story_sources'] and item['story_verified_on']
        assert item['source_url'] == cefca.SOURCE_URL
        for reference in item['story_sources']:
            assert reference['url'].startswith('https://') and reference['title'].strip()
    item = cefca.source('virgo-m87')
    item['story_sources'][0]['url'] = 'https://evil.invalid'
    assert cefca.source('virgo-m87')['story_sources'][0]['url'] != 'https://evil.invalid'


def test_existing_saved_routes_get_updated_stories_without_changing_waypoints(client, monkeypatch):
    original = template(client)
    original['stops'][0].update(title='My M87 stop', notes='Return to this galaxy later.', hold=42)
    saved = client.post('/api/navigation/routes', json=route_payload(original)).json()
    replacement = {**cefca.STORIES['virgo-m87'], 'narration': 'A newly researched story.'}
    monkeypatch.setitem(cefca.STORIES, 'virgo-m87', replacement)
    refreshed = client.get('/api/navigation/routes/' + saved['id']).json()
    assert refreshed['stops'] == saved['stops']
    assert refreshed['media'][0]['narration'] == replacement['narration']
    assert refreshed['media'][0]['story_sources'] == replacement['sources']
