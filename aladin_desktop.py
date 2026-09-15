"""Launch the complete CDS Aladin distribution and exchange local data via SAMP."""
import json
import re
import subprocess
import threading
import time
import warnings
from pathlib import Path
from urllib.parse import unquote, urlsplit

from astropy.utils.exceptions import AstropyDeprecationWarning
with warnings.catch_warnings():
    warnings.simplefilter('ignore',AstropyDeprecationWarning)
    from astropy.samp import SAMPIntegratedClient

ROOT=Path(__file__).parent
PACKAGE=ROOT/'vendor'/'aladin'
_process=None
_lock=threading.Lock()

def runtime():
    return next((PACKAGE/'runtime').glob('*/bin/javaw.exe'),None)

def connection():
    c=SAMPIntegratedClient(name='Universe Explorer',description='Local astronomy explorer',addr='127.0.0.1',callable=False)
    try:
        c.connect()
        clients=[]
        for cid in c.get_registered_clients():
            metadata=c.get_metadata(cid)
            if 'aladin' in metadata.get('samp.name','').lower():clients.append((cid,metadata))
        return c,clients
    except Exception:
        if c.is_connected:c.disconnect()
        raise

def status():
    clients=[]
    try:
        c,found=connection()
        try:clients=[{'name':m.get('samp.name'),'version':m.get('aladin.version') or m.get('samp.description.text','')} for _,m in found]
        finally:c.disconnect()
    except Exception:pass
    return {'installed':bool(runtime() and (PACKAGE/'Aladin.jar').exists()),'version':'12.060',
            'connected':bool(clients),'clients':clients,'package_path':str(PACKAGE),
            'source':'https://aladin.cds.unistra.fr/java/nph-aladin.pl?frame=downloading',
            'license':'GNU GPL v3; original source archive and license included',
            'tools':'Complete Aladin Desktop: FITS and cubes, catalogs, cross-matching, image arithmetic, photometry, mosaics, MOCs, HiPS generation, SAMP, scripts and plugins.'}

def launch():
    global _process
    if status()['connected']:return {**status(),'launched':False}
    java=runtime();jar=PACKAGE/'Aladin.jar'
    if not java or not jar.exists():raise ValueError('Aladin Desktop is not installed. Run setup_aladin.py first.')
    if _process is not None and _process.poll() is None:return {**status(),'launched':False,'starting':True}
    (ROOT/'logs').mkdir(exist_ok=True)
    log=(ROOT/'logs'/'aladin-desktop.log').open('ab')
    try:
        _process=subprocess.Popen([str(java),'-Xmx4g','-jar',str(jar),'-noreleasetest','-nolog','-theme=dark','-script=get hips(P/DSS2/color)'],cwd=str(PACKAGE),stdin=subprocess.DEVNULL,stdout=log,stderr=log,close_fds=True,creationflags=getattr(subprocess,'CREATE_NEW_PROCESS_GROUP',0))
    finally:log.close()
    (ROOT/'logs'/'aladin-desktop.pid').write_text(str(_process.pid))
    return {**status(),'launched':True,'pid':_process.pid,'starting':True}

def loaded_images(c,cid,url):
    """Verify real image planes, including MEF children whose parent never replies."""
    reply=c.call_and_wait(cid,{'samp.mtype':'script.aladin.send','samp.params':{'script':'status'}},'5')
    if reply.get('samp.status')!='samp.ok':return []
    def canonical(value):
        parts=urlsplit(value)
        return (parts.scheme,parts.netloc,unquote(parts.path).lstrip('/').casefold() if parts.scheme=='file' else parts.path)
    found=[]
    for block in re.split(r'(?m)^PlaneID ',reply.get('samp.result',{}).get('script.result',''))[1:]:
        fields={}
        for line in block.splitlines()[1:]:
            pair=line.split(None,1)
            if len(pair)==2:fields[pair[0]]=pair[1].strip()
        if fields.get('Type')!='Image' or canonical(fields.get('Url',''))!=canonical(url):continue
        try:width,height=int(fields.get('Width','0')),int(fields.get('Height','0'))
        except ValueError:continue
        if width>0 and height>0 and fields.get('Status') in ('shown','hidden'):
            found.append({'name':block.splitlines()[0].strip('"'),'width':width,'height':height})
    return found


def send(kind,params):
    with _lock:
        launch()
        deadline=time.monotonic()+35
        # Retry connection readiness only. Once dispatched, never resend on a timeout.
        while time.monotonic()<deadline:
            c=None
            try:
                c,clients=connection()
            except Exception:pass
            else:
                if clients:break
                c.disconnect();c=None
            time.sleep(.5)
        else:
            raise ValueError('Aladin opened but its SAMP connection is not ready. Finish any first-run dialog in Aladin, enable SAMP in its Interop menu, then retry.')
        try:
            cid,_=clients[0]
            result={'sent':True,'application':'Aladin Desktop','message_type':kind}
            try:
                reply=c.call_and_wait(cid,{'samp.mtype':kind,'samp.params':params},'20')
            except Exception as error:
                if kind=='image.load.fits':
                    try:planes=loaded_images(c,cid,params['url'])
                    except Exception:planes=[]
                    if planes:return {**result,'response':'loaded-verified','image_planes':planes}
                raise ValueError('Aladin did not confirm completion. The request was sent once; check its layer stack before retrying.') from error
            if reply.get('samp.status') not in ('samp.ok','samp.warning'):
                raise ValueError('Aladin did not accept the data: '+str(reply.get('samp.error',{}).get('samp.errortxt','Unknown error')))
            return {**result,'response':reply.get('samp.status')}
        finally:
            if c is not None and c.is_connected:c.disconnect()

def point(ra,dec):
    return send('coord.pointAt.sky',{'ra':str(ra),'dec':str(dec)})

def send_file(path,kind,name):
    path=Path(path).resolve()
    if not path.is_relative_to((ROOT/'data').resolve()) or not path.exists():raise ValueError('Only saved Universe Explorer data can be sent to Aladin.')
    if kind=='image.load.fits' or kind=='table.load.votable':
        return send(kind,{'url':path.as_uri(),'name':str(name)[:200]})
    # Aladin's standard script is used only with an app-generated local URI.
    return send('script.aladin.send',{'script':'load '+path.as_uri()})
