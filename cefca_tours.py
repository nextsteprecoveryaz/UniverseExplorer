"""Trusted waypoint facts from CEFCA's published Virgo Cluster tour.

Snapshot checked 2026-09-15 against SOURCE_URL. Coordinates (ICRS degrees),
field sizes and stop order follow the 23 positioned slides in the official
tour. Its two introductory slides have no coordinates and are represented by
the route overview, not invented waypoints. Researched English stories live in
tour_content, with primary-source links for each stop. No Tour Navigator code
or Spanish prose is bundled. The image survey is credited to CEFCA Foundation.
"""
from copy import deepcopy
import json
from pathlib import Path

TOUR_ID = 'cefca-virgo'
SURVEY_ID = 'cefca-virgo'
SOURCE_URL = 'https://www.cefca.es/divulgacion/tour_cumulo_virgo'
SURVEY_URL = 'https://www.cefca.es/img/aladin/VirgoCluster/'
CREDIT = 'CEFCA Foundation · JAST80 / T80Cam'


def _load_stories():
    rows = []
    for name in ('cefca_virgo_01_08.json', 'cefca_virgo_09_15.json', 'cefca_virgo_16_23.json'):
        rows.extend(json.loads((Path(__file__).parent / 'tour_content' / name).read_text(encoding='utf-8')))
    stories = {row['id']: row for row in rows}
    if len(stories) != len(rows) or set(stories) != {row[0] for row in WAYPOINTS}:
        raise ValueError('CEFCA stories must cover each published waypoint exactly once.')
    for row in rows:
        if not row['narration'].strip() or len(row['narration']) > 3500 or not row['sources']:
            raise ValueError('Every CEFCA story needs narration and research sources.')
    return stories

# Stable source id, English title, RA, Dec, horizontal field of view, our notes.
# Keep these published positions and their order independent of live web pages.
WAYPOINTS = (
    ('virgo-m87', 'M87', 187.7059304, 12.3911231, .2,
     'Start with the broad, smooth glow of M87. Compare its shape with the galaxies that follow.'),
    ('virgo-m86', 'M86', 186.5489285, 12.9462217, .2,
     'Move to M86 and look at how its light fades outward from the bright center.'),
    ('virgo-m88', 'M88', 187.996503, 14.420387, .2,
     'Inspect the tilted disk of M88 and trace the structure around its center.'),
    ('virgo-m90', 'M90', 189.20747, 13.16294, .2,
     'Compare the elongated outline of M90 with the spiral galaxy at the previous stop.'),
    ('virgo-m91', 'M91', 188.86022, 14.49634, .2,
     'Look for the central bar and the surrounding spiral structure in M91.'),
    ('virgo-m58', 'M58', 189.4313417, 11.81811939, .2,
     'Visit another barred spiral and compare its bright center with its outer disk.'),
    ('virgo-ngc4298-ngc4302', 'NGC 4298 / NGC 4302', 185.3865, 14.606167, .2,
     'Compare two nearby galaxy outlines: a broader disk and a thin galaxy seen nearly edge-on.'),
    ('virgo-ngc4440', 'NGC 4440', 186.973197, 12.293282, .2,
     'Center on NGC 4440 and examine the shape of its inner light distribution.'),
    ('virgo-ngc4452', 'NGC 4452', 187.180455, 11.755032, .2,
     'Find the narrow profile of NGC 4452, a galaxy viewed nearly along the plane of its disk.'),
    ('virgo-ngc4567-ngc4568', 'NGC 4567 / NGC 4568', 189.136292, 11.258, .2,
     'Inspect the two spiral disks together and follow their overlapping outlines.'),
    ('virgo-m89', 'M89', 188.9158637, 12.5563414, .2,
     'Return to a smooth elliptical galaxy and compare its outline with the preceding spiral pair.'),
    ('virgo-m84', 'M84', 186.2655971, 12.8869831, .2,
     'Examine M84 and compare its concentrated glow with M87 and M86.'),
    ('virgo-ngc4425', 'NGC 4425', 186.8055508, 12.7347234, .2,
     'Look at the elongated lens-shaped body of NGC 4425 and its bright center.'),
    ('virgo-ngc4429', 'NGC 4429', 186.86045, 11.10771, .2,
     'Explore NGC 4429, paying attention to structure around its central region.'),
    ('virgo-ic3476', 'IC 3476', 188.17452, 14.05044, .2,
     'Compare this irregular galaxy with the smoother and more symmetric systems visited earlier.'),
    ('virgo-vcc846', 'VCC 846', 186.460486, 13.197644, .04,
     'Use this closer view to compare the compact nucleus with the faint surrounding galaxy.'),
    ('virgo-vcc1413', 'VCC 1413', 188.032241, 12.434051, .04,
     'Search the center of the field for a diffuse dwarf galaxy and compare it with VCC 846.'),
    ('virgo-ngc4438', 'NGC 4438', 186.9399741, 13.0088263, .2,
     'Look for the uneven outline of NGC 4438 and its neighboring galaxy NGC 4435.'),
    ('virgo-viii-zw186', 'VIII Zw 186', 186.11917, 13.38583, .05,
     'Inspect the small galaxy pair in this narrower field and compare its apparent size with earlier targets.'),
    ('virgo-vpc0880', 'VPC 0880', 188.173607, 14.539521, .09,
     'Explore the unusual outline of VPC 0880 in its surrounding field.'),
    ('virgo-distant-galaxy-cluster', 'Background galaxy cluster', 185.915691, 13.053627, .02,
     'Look for the small, faint galaxies grouped in the center of this close view.'),
    ('virgo-more-distant-galaxy-cluster', 'Another background galaxy cluster', 185.47625, 14.97194, .02,
     'Compare a second compact background field with the preceding group of faint galaxies.'),
    ('virgo-sdss-j122359-112800', 'Quasar SDSS J122359.35+112800.0', 185.997291666, 11.4666666, .02,
     'Finish at the quasar position. Its compact appearance contrasts with the extended galaxies along the route.'),
)

STORIES = _load_stories()


def source(ident):
    """Resolve only a bundled source id; user input never selects a URL."""
    try:
        _, title, ra, dec, fov, navigation_note = next(row for row in WAYPOINTS if row[0] == ident)
    except StopIteration as exc:
        raise ValueError('Unknown CEFCA waypoint.') from exc
    story = STORIES[ident]
    return {
        'id': ident, 'kind': 'cefca', 'title': title,
        'ra': ra, 'dec': dec, 'fov': fov, 'survey': SURVEY_ID,
        'description': story['narration'], 'narration': story['narration'],
        'story_sources': deepcopy(story['sources']), 'story_verified_on': story['verified_on'],
        'navigation_note': navigation_note, 'available': True, 'preview_url': None,
        'source_url': SOURCE_URL, 'source_language': 'es', 'credit': CREDIT,
        'location_note': 'Published CEFCA tour position. Researched English story by Universe Explorer; references under Story sources.',
    }


def media_items():
    return [source(row[0]) for row in WAYPOINTS]


def template_metadata():
    return {
        'id': TOUR_ID, 'title': 'Virgo Cluster with CEFCA',
        'description': 'Discover the stories behind 23 CEFCA sky stops: giant black holes, colliding galaxies, stripped gas and distant quasars. Explore their positions on your chosen full-sky survey with researched English narration and sources for every stop. The journey waits until each story finishes.',
        'collection': 'cefca', 'source_url': SOURCE_URL, 'source_language': 'es',
        'credit': CREDIT, 'cover_url': '/assets/cefca-virgo.jpg',
    }
