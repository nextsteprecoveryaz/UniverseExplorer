"""Survey choices for continuous-sky tour playback and prepared tour packs.

This is a display policy, not a migration of users' saved camera paths. Provider
HiPS properties advertise full-sky coverage for these surveys; masks, native
resolution and individual missing measurements can still limit their pixels.
"""
from copy import deepcopy
from typing import Literal

DEFAULT_SURVEY = 'optical'
ALLOWED_SURVEYS = ('optical', '2mass', 'hydrogen', 'dust')
TourSurvey = Literal['optical', '2mass', 'hydrogen', 'dust']


def normalize_survey(survey):
    """Choose a safe default for a new waypoint sourced from any local catalog."""
    return survey if survey in ALLOWED_SURVEYS else DEFAULT_SURVEY


def clone_route(route, survey=DEFAULT_SURVEY):
    """Materialize one tour survey without changing the stored route or metadata."""
    if survey not in ALLOWED_SURVEYS:
        raise ValueError('Choose a continuous-sky tour survey: '+', '.join(ALLOWED_SURVEYS)+'.')
    result = deepcopy(route)
    for field in ('stops', 'track'):
        for view in result.get(field, []):
            view['survey'] = survey
    progress = result.get('progress')
    if progress and isinstance(progress.get('origin'), dict):
        progress['origin']['survey'] = survey
    return result
