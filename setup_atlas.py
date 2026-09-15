"""Vendor the official Aladin Lite distribution for local/offline atlas startup."""
import hashlib
import json
from pathlib import Path
import httpx
root=Path(__file__).parent/'static'/'vendor';root.mkdir(exist_ok=True)
url='https://aladin.cds.unistra.fr/AladinLite/api/v3/3.8.2/aladin.js'
with httpx.Client(timeout=120,follow_redirects=True) as c:
    r=c.get(url);r.raise_for_status();content=r.content
    (root/'aladin.js').write_bytes(content)
    license_url='https://raw.githubusercontent.com/cds-astro/aladin-lite/master/COPYING'
    license_result=c.get(license_url)
    if license_result.is_success:(root/'ALADIN-LICENSE.txt').write_bytes(license_result.content)
    lesser=c.get('https://raw.githubusercontent.com/cds-astro/aladin-lite/master/LICENSE')
    lesser.raise_for_status();(root/'ALADIN-LGPL.txt').write_bytes(lesser.content)
manifest={'source':url,'resolved_url':str(r.url),'bytes':len(content),'sha256':hashlib.sha256(content).hexdigest(),'license':'LGPL-3.0','project':'https://github.com/cds-astro/aladin-lite'}
(root/'aladin-manifest.json').write_text(json.dumps(manifest,indent=2),encoding='utf-8')
print(json.dumps(manifest))
