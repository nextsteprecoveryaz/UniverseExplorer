"""Curated DSS2 shortcuts with catalog-verified ICRS anchors."""
import json
from pathlib import Path

CATALOG=json.loads((Path(__file__).parent/'resources'/'dss2-destinations.json').read_text(encoding='utf-8'))
DESTINATIONS=CATALOG['destinations']
