import re
from destination_catalog import DESTINATIONS,VIDEO_CATALOG


def test_all_fifty_destinations_have_multiple_verified_youtube_choices():
    assert set(VIDEO_CATALOG['destinations'])=={d['id'] for d in DESTINATIONS}
    for destination in DESTINATIONS:
        videos=destination['videos']
        assert 2<=len(videos)<=4
        assert len({v['id'] for v in videos})==len(videos)
        for video in videos:
            assert video['provider']=='youtube' and re.fullmatch(r'[A-Za-z0-9_-]{11}',video['id'])
            assert video['url']=='https://www.youtube.com/watch?v='+video['id']
            assert video['title'] and video['channel'] and video['checked_at']
            assert video['channel_url'].startswith('https://www.youtube.com/')


def test_related_regions_do_not_replace_their_specific_catalog_destinations():
    rows={d['id']:d['videos'] for d in DESTINATIONS}
    assert any('M22' in v['title'] for v in rows['sagittarius-cluster'])
    assert any('M87' in v['title'] for v in rows['m87'])
    assert any('4945' in v['title'] for v in rows['ngc4945'])
    assert any('83' in v['title'] for v in rows['southern-pinwheel'])
