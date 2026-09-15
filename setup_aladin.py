"""Download the official complete Aladin Desktop distribution into this app."""
import hashlib
import json
import zipfile
from pathlib import Path
import httpx

root=Path(__file__).parent/'vendor'/'aladin'
root.mkdir(parents=True,exist_ok=True)
manifest={}
with httpx.Client(timeout=180,follow_redirects=True) as client:
    for name,url in [('Aladin.jar','https://aladin.cds.unistra.fr/java/Aladin.jar'),('Aladin.msi','https://aladin.cds.unistra.fr/java/Aladin.msi'),('AladinSrc.jar','https://aladin.cds.unistra.fr/java/AladinSrc.jar'),('COPYING','https://aladin.cds.unistra.fr/COPYING')]:
        path=root/name
        if not path.exists():
            with client.stream('GET',url) as r:
                r.raise_for_status()
                with path.with_suffix(path.suffix+'.download').open('wb') as f:
                    for chunk in r.iter_bytes():f.write(chunk)
            path.with_suffix(path.suffix+'.download').replace(path)
        manifest[name]={'source':url,'bytes':path.stat().st_size,'sha256':hashlib.sha256(path.read_bytes()).hexdigest()}
        print(name,json.dumps(manifest[name]),flush=True)
    if not list((root/'runtime').glob('*/bin/javaw.exe')):
        metadata=client.get('https://api.adoptium.net/v3/assets/latest/21/hotspot',params={'architecture':'x64','image_type':'jre','os':'windows'})
        metadata.raise_for_status();release=metadata.json()[0];package=release['binary']['package']
        archive=root/package['name']
        if not archive.exists():
            with client.stream('GET',package['link']) as r:
                r.raise_for_status()
                with archive.open('wb') as f:
                    for chunk in r.iter_bytes():f.write(chunk)
        sha=hashlib.sha256(archive.read_bytes()).hexdigest()
        if sha!=package['checksum']:raise RuntimeError('Java runtime checksum mismatch')
        destination=(root/'runtime').resolve();destination.mkdir(exist_ok=True)
        with zipfile.ZipFile(archive) as z:
            for info in z.infolist():
                if not (destination/info.filename).resolve().is_relative_to(destination):raise RuntimeError('Unsafe runtime archive path')
            z.extractall(destination)
        manifest['runtime']={'source':package['link'],'sha256':sha,'version':release['version']['semver'],'vendor':'Eclipse Temurin','verified_against':'Adoptium API package checksum'}
        (root/'runtime-manifest.json').write_text(json.dumps(manifest['runtime'],indent=2),encoding='utf-8')
        print('runtime',json.dumps(manifest['runtime']),flush=True)
(root/'download-manifest.json').write_text(json.dumps(manifest,indent=2),encoding='utf-8')
