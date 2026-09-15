"""Persistent spherical-cap R-tree over every available archive footprint."""
import json
import math
import os
import sqlite3
import threading
from pathlib import Path
import numpy as np
import recent_archive as archive
from integrations import now

PATH=Path(__file__).parent/'data'/'coverage-index.sqlite3'
VERSION=1
_lock=threading.Lock()
_thread=None
_progress={'state':'not built','processed':0}
_table=None

def generation():
    with archive.connect() as c:return archive.active(c)

def status():
    info={}
    if PATH.exists():
        try:
            with sqlite3.connect(PATH) as c:info=json.loads(c.execute('SELECT payload FROM metadata').fetchone()[0])
        except (sqlite3.Error,TypeError):pass
    return {**info,'build':dict(_progress),'ready':info.get('generation')==generation() and info.get('version')==VERSION}

def build():
    global _progress,_table
    import coverage_guide as geometry
    with _lock:
        if status()['ready']:return status()
        gen=generation();tmp=PATH.with_suffix('.building.sqlite3')
        # A build creates only its own derived, disposable database.
        if tmp.exists():tmp.unlink()
        _progress={'state':'building','processed':0,'started_at':now()}
        try:
            c=sqlite3.connect(tmp)
            c.executescript('CREATE TABLE metadata(payload TEXT); CREATE TABLE points(n INTEGER PRIMARY KEY,id TEXT UNIQUE,ra REAL,dec REAL,webb INTEGER,moving INTEGER,supported INTEGER); CREATE VIRTUAL TABLE bounds USING rtree(n,x0,x1,y0,y1,z0,z1);')
            supported=0;moving=0;count=0
            with archive.connect() as source:
                rows=source.execute('SELECT obsid,ra,dec,mission,payload FROM observations WHERE generation=? AND ra IS NOT NULL AND dec IS NOT NULL',(gen,))
                for count,row in enumerate(rows,1):
                    o=json.loads(row['payload']);shape=geometry.footprint(o.get('s_region'));is_moving=bool(o.get('mtFlag'))
                    c.execute('INSERT INTO points VALUES(?,?,?,?,?,?,?)',(count,row['obsid'],row['ra'],row['dec'],row['mission']=='JWST',is_moving,shape is not None))
                    moving+=is_moving
                    if shape and not is_moving:
                        # The sphere's chord ball encloses every point of the cap.
                        # Outward-rounded SQLite R-tree bounds remain conservative.
                        center=shape['center'];reach=2*math.sin(math.radians(shape['radius'])/2)+1e-10
                        limits=[v for x in center for v in (max(-1.,float(x)-reach),min(1.,float(x)+reach))]
                        c.execute('INSERT INTO bounds VALUES(?,?,?,?,?,?,?)',(count,*limits));supported+=1
                    if count%2000==0:_progress['processed']=count
            if generation()!=gen:raise ValueError('The archive changed during indexing. A fresh build will run on the next request.')
            info={'version':VERSION,'generation':gen,'indexed':count,'supported_footprints':supported,'moving_targets':moving,'built_at':now()}
            c.execute('INSERT INTO metadata VALUES(?)',(json.dumps(info),));c.commit();c.close()
            os.replace(tmp,PATH);_table=None;_progress={'state':'complete','processed':count,'completed_at':now()}
        except Exception as e:
            try:c.close()
            except Exception:pass
            _progress={'state':'failed','processed':_progress.get('processed',0),'error':str(e)}
            raise
    return status()

def ensure_async():
    global _thread
    if status()['ready']:return
    if _thread and _thread.is_alive():return
    def run():
        try:build()
        except Exception:pass
    _thread=threading.Thread(target=run,name='coverage-index',daemon=True);_thread.start()

def table():
    global _table
    info=status()
    if not info['ready']:ensure_async();return None
    key=(str(PATH),info['generation'])
    if _table and _table[0]==key:return _table[1]
    with sqlite3.connect(PATH) as c:rows=c.execute('SELECT id,ra,dec,webb,moving,supported FROM points ORDER BY n').fetchall()
    values=np.asarray([r[1:] for r in rows],dtype=float).reshape(-1,5)
    data={'generation':info['generation'],'ids':np.array([r[0] for r in rows]),'coords':values[:,:2],'webb':values[:,2].astype(bool),'moving':values[:,3].astype(bool),'supported':values[:,4].astype(bool)}
    _table=(key,data);return data

def possible_containment(ra,dec,mission='both'):
    import coverage_guide as geometry
    if not status()['ready']:return []
    x,y,z=geometry.vector(ra,dec)
    clause='' if mission=='both' else ' AND p.webb='+('1' if mission=='webb' else '0')
    with sqlite3.connect(PATH) as c:
        return [r[0] for r in c.execute('SELECT p.id FROM bounds b JOIN points p ON p.n=b.n WHERE b.x0<=? AND b.x1>=? AND b.y0<=? AND b.y1>=? AND b.z0<=? AND b.z1>=?'+clause,(x,x,y,y,z,z))]

def nearby_candidates(ra,dec,mission,radius,limit):
    """All supported footprint matches, followed by full-index nearest regions."""
    import coverage_guide as geometry
    data=table()
    if data is None:
        gen,ids,coords,webb=archive.coordinate_table();moving=np.zeros(len(ids),dtype=bool)
    else:
        gen,ids,coords,webb,moving=[data[k] for k in ('generation','ids','coords','webb','moving')]
    r,d=np.radians(coords[:,0]),np.radians(coords[:,1]);v=np.column_stack((np.cos(d)*np.cos(r),np.cos(d)*np.sin(r),np.sin(d)));target=geometry.vector(ra,dec)
    distances=np.degrees(np.arctan2(np.linalg.norm(np.cross(v,target),axis=1),v@target))
    mission_mask=np.ones(len(ids),dtype=bool) if mission=='both' else webb if mission=='webb' else ~webb
    total=int(np.count_nonzero((distances<=radius)&mission_mask))
    indices=np.flatnonzero((distances<=radius)&mission_mask&~moving)
    lookup={str(ident):i for i,ident in enumerate(ids)}
    inside=[];tested=0
    def payloads(keys):
        result=[]
        with archive.connect() as c:
            for start in range(0,len(keys),400):
                batch=keys[start:start+400]
                result.extend(json.loads(row[0]) for row in c.execute('SELECT payload FROM observations WHERE generation=? AND obsid IN ('+','.join('?'*len(batch))+')',[gen,*batch]))
        return result
    for o in payloads(possible_containment(ra,dec,mission)):
        shape=geometry.footprint(o.get('s_region'));tested+=1
        if geometry.contains(shape,ra,dec):
            ident=str(o.get('record_id') or o.get('objID') or o['obsid'])
            if ident in lookup:inside.append((True,float(distances[lookup[ident]]),o))
    inside.sort(key=lambda t:(t[1],-(t[2].get('t_min') or 0)))
    selected=[]
    def add(entry):
        o=entry[2]
        if o.get('mtFlag') or any(geometry.separation(o['s_ra'],o['s_dec'],q[2]['s_ra'],q[2]['s_dec'])<.012 for q in selected):return
        selected.append(entry)
    for entry in inside:
        add(entry)
        if len(selected)>=limit:break
    # Vectorize exclusion around each chosen region before hydrating more rows.
    ordered=indices[np.argsort(distances[indices],kind='stable')]
    while len(selected)<limit and len(ordered):
        if selected:
            keep=np.ones(len(ordered),dtype=bool)
            for _,_,o in selected:keep&=v[ordered]@geometry.vector(o['s_ra'],o['s_dec'])<math.cos(math.radians(.012))
            ordered=ordered[keep]
        if not len(ordered):break
        batch=ordered[:64];ordered=ordered[64:]
        rows=payloads([str(ids[i]) for i in batch]);byid={str(o.get('record_id') or o.get('objID') or o['obsid']):o for o in rows}
        for i in batch:
            o=byid.get(str(ids[i]))
            if o:
                shape=geometry.footprint(o.get('s_region'));add((geometry.contains(shape,ra,dec),float(distances[i]),o))
            if len(selected)>=limit:break
    return {'rows':selected,'total':total,'tested':tested,'containing':len(inside),'ready':data is not None,'generation':gen}

if __name__=='__main__':print(json.dumps(build(),indent=2))
