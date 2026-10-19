"""Curated DSS2 shortcuts with catalog-verified ICRS anchors."""
import json
from pathlib import Path

CATALOG=json.loads((Path(__file__).parent/'resources'/'dss2-destinations.json').read_text(encoding='utf-8'))
VIDEO_CATALOG=json.loads((Path(__file__).parent/'resources'/'destination-videos.json').read_text(encoding='utf-8'))
DESTINATIONS=[{**d,'videos':VIDEO_CATALOG['destinations'].get(d['id'],[])} for d in CATALOG['destinations']]
