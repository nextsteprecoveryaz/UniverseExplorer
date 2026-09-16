"""Space Telescope Live coordinate and schedule-navigation contract checks."""
import asyncio

import pytest

import integrations as remote


CURRENT = '01M24ACAVPMVMZ2E745JVDSG5S'
PREVIOUS = '01KZ9JBN56C0RDJ0HFX4QBXJVT'
NEXT = '01M24ACAWMJREP0WPY9Y01MA94'


def observation(**updates):
    row = {'id': CURRENT, 'targetName': 'Example target',
           'targetRightAscensionInDegrees': '308.8648333333333',
           'targetDeclinationInDegrees': '60.13563611111111',
           'scheduledStartTime': '2026-09-13T19:33:20-04:00',
           'scheduledEndTime': '2026-09-14T03:13:36-04:00',
           'proposal': {'proposalID': '7648', 'title': 'Example program'}}
    row.update(updates)
    return {'data': row, '_pagination': {
        'previousRecord': {'id': PREVIOUS, 'startTime': '2026-09-13T17:25:52-04:00'},
        'nextRecord': {'id': NEXT, 'startTime': '2026-09-14T03:13:37-04:00'},
    }, '_meta': {'code': 200, 'message': 'OK'}}


def test_navigation_uses_outer_pagination_and_preserves_official_source_link():
    result = remote.normalize_live(observation(), 'webb')
    assert result['previous_id'] == PREVIOUS
    assert result['next_id'] == NEXT
    assert result['source_url'] == f'https://spacetelescopelive.org/webb?obsId={CURRENT}'


def test_nested_pagination_is_supported_and_missing_neighbors_are_null():
    payload = observation()
    payload['data']['_pagination'] = {'previousRecord': None, 'nextRecord': {'id': NEXT}}
    result = remote.normalize_live(payload, 'hubble')
    assert result['previous_id'] is None
    assert result['next_id'] == NEXT
    assert result['source_url'].startswith('https://spacetelescopelive.org/hubble?')


def test_invalid_neighbor_ids_are_not_offered_as_navigation_targets():
    payload = observation()
    payload['_pagination'] = {'previousRecord': {'id': '../../bad'}, 'nextRecord': 'malformed'}
    result = remote.normalize_live(payload, 'webb')
    assert result['previous_id'] is None
    assert result['next_id'] is None


def test_zero_coordinates_and_official_coordinate_precedence_are_preserved():
    payload = observation(targetRightAscensionInDegrees=0, targetDeclinationInDegrees=0,
                          targets=[{'rightAscensionInDegrees': 20, 'declinationInDegrees': 30}],
                          boreSightRightAscensionInDegrees=40, boreSightDeclinationInDegrees=50)
    result = remote.normalize_live(payload, 'hubble')
    assert result['ra'] == 0
    assert result['dec'] == 0


def test_webb_nested_coordinates_keep_zero_and_take_priority_over_boresight():
    payload = observation(targetRightAscensionInDegrees=None, targetDeclinationInDegrees=None,
                          targets=[{'rightAscensionInDegrees': 0, 'declinationInDegrees': 0}],
                          boreSightRightAscensionInDegrees=40, boreSightDeclinationInDegrees=50)
    result = remote.normalize_live(payload, 'webb')
    assert result['ra'] == 0
    assert result['dec'] == 0


def test_missing_target_coordinates_fall_back_to_boresight_but_not_nan():
    payload = observation(targetRightAscensionInDegrees='NaN', targetDeclinationInDegrees=None,
                          boreSightRightAscensionInDegrees=12.5, boreSightDeclinationInDegrees=-3.5)
    result = remote.normalize_live(payload, 'webb')
    assert result['ra'] == 12.5
    assert result['dec'] == -3.5


@pytest.mark.parametrize('updates', [
    {'isMovingTarget': True},
    {'isMovingTarget': False, 'targets': [{'type': 'MOVING'}]},
])
def test_moving_targets_are_marked_for_both_observatory_schemas(updates):
    assert remote.normalize_live(observation(**updates), 'webb')['moving_target'] is True


def test_schedule_times_remain_distinct_from_later_reported_execution():
    result = remote.normalize_live(observation(executedStartTime='2026-09-14T13:12:21-04:00',
                                              executedEndTime='2026-09-14T21:03:39-04:00'), 'webb')
    assert result['scheduled_start'] == '2026-09-13T19:33:20-04:00'
    assert result['start'] == '2026-09-14T13:12:21-04:00'
    assert result['status'] == 'Execution reported'


def test_date_lookup_converts_offset_to_utc_and_preserves_cache_provenance(monkeypatch):
    calls = []
    async def fake_json(url, **options):
        calls.append((url, options))
        return {'data': observation(), 'fetched_at': '2026-09-15T00:00:00Z',
                'stale': True, 'cached': True, 'warning': 'Showing saved data.'}
    monkeypatch.setattr(remote, 'remote_json', fake_json)
    result = asyncio.run(remote.live_at_time('webb', '2026-09-13T17:00:00-07:00'))
    assert calls == [('https://spacetelescopelive.org/api/get/webb', {
        'headers': {'endpoint': 'startTime/2026-09-14T00:00:00Z'}, 'ttl': 300})]
    assert result['requested_at'] == '2026-09-14T00:00:00Z'
    assert result['previous_id'] == PREVIOUS
    assert result['cached'] is True and result['stale'] is True
    assert result['warning'] == 'Showing saved data.'
    assert 'Actual execution times can differ' in result['lookup_note']


@pytest.mark.parametrize('telescope,at', [
    ('other', '2026-09-14T00:00:00Z'),
    ('webb', '2026-09-14'),
    ('hubble', '2026-09-14T00:00:00'),
    ('webb', '2026-02-31T00:00:00Z'),
    ('webb', 'current\r\nX-Other: value'),
    ('webb', None),
])
def test_invalid_schedule_inputs_are_rejected_before_network(monkeypatch, telescope, at):
    async def forbidden(*args, **kwargs):
        pytest.fail('Invalid input reached the network adapter')
    monkeypatch.setattr(remote, 'remote_json', forbidden)
    with pytest.raises(ValueError):
        asyncio.run(remote.live_at_time(telescope, at))


def test_current_lookup_retains_existing_endpoint_and_navigation(monkeypatch):
    calls = []
    async def fake_json(url, **options):
        calls.append(options)
        return {'data': observation(), 'fetched_at': 'now', 'stale': False, 'cached': False}
    monkeypatch.setattr(remote, 'remote_json', fake_json)
    result = asyncio.run(remote.live_observation('hubble'))
    assert calls[0]['headers'] == {'endpoint': 'current'}
    assert calls[0]['ttl'] == 60
    assert result['next_id'] == NEXT
