"""Curated DSS2 shortcuts with catalog-verified ICRS anchors."""
import json
from pathlib import Path

CATALOG=json.loads((Path(__file__).parent/'resources'/'dss2-destinations.json').read_text(encoding='utf-8'))
VIDEO_CATALOG=json.loads((Path(__file__).parent/'resources'/'destination-videos.json').read_text(encoding='utf-8'))
DESTINATIONS=[{**d,'videos':VIDEO_CATALOG['destinations'].get(d['id'],[])} for d in CATALOG['destinations']]

# Reuse the exact catalog identity so biographies, recordings and videos stay
# shared with DSS2. Only the displayed survey and camera framing differ.
SDSS_CATALOG=json.loads((Path(__file__).parent/'resources'/'sdss-destinations.json').read_text(encoding='utf-8'))
_by_id={d['id']:d for d in DESTINATIONS}
SDSS_DESTINATIONS=[{
    **_by_id[d['id']], 'survey':'sdss-color', 'fov':d['fov'],
    'view_label':d.get('view_label',''),
    'description':f"Explore {_by_id[d['id']]['name']}"+(' — central region' if d.get('view_label') else '')+
                  ' in the SDSS DR9 optical color map. Saved object research and narration are shared with DSS2.'
} for d in SDSS_CATALOG['destinations']]
