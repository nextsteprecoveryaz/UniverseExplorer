"""Bounded, local cache of derived atlas files; saved packs pin their files."""
import hashlib
import json
import os
import re
import sqlite3
import threading
import time
from pathlib import Path

ROOT=Path(__file__).parent/'data'/'atlas-cache'
LIMIT=1024*1024*1024
LOCK=threading.RLock()

def key(value):return hashlib.sha256(value.encode()).hexdigest()

def connect():
    ROOT.mkdir(parents=True,exist_ok=True)
    c=sqlite3.connect(ROOT/'cache.sqlite3',timeout=20);c.row_factory=sqlite3.Row
    c.executescript('''CREATE TABLE IF NOT EXISTS files(id TEXT PRIMARY KEY,size INTEGER,used REAL,mime TEXT,metadata TEXT);
    CREATE TABLE IF NOT EXISTS pins(pack TEXT,id TEXT,PRIMARY KEY(pack,id));
    CREATE TABLE IF NOT EXISTS packs(id TEXT PRIMARY KEY,payload TEXT);''')
    return c

def path(ident):
    if not re.fullmatch('[a-f0-9]{64}',ident):raise ValueError('Invalid cache identifier.')
    return ROOT/ident

def get(ident):
    p=path(ident)
    with LOCK,connect() as c:
        r=c.execute('SELECT * FROM files WHERE id=?',(ident,)).fetchone()
        if not r or not p.exists():return None
        c.execute('UPDATE files SET used=? WHERE id=?',(time.time(),ident))
        return {'id':ident,'size':r['size'],'mime':r['mime'],'metadata':json.loads(r['metadata']),'path':p}

def put(ident,data,mime,metadata=None,pin=None):
    p=path(ident)
    with LOCK,connect() as c:
        old=c.execute('SELECT size FROM files WHERE id=?',(ident,)).fetchone()
        total=c.execute('SELECT coalesce(sum(size),0) FROM files').fetchone()[0]-(old[0] if old else 0)
        victims=c.execute('SELECT id,size FROM files WHERE id!=? AND id NOT IN (SELECT id FROM pins) ORDER BY used',(ident,)).fetchall()
        if total+len(data)-sum(r['size'] for r in victims)>LIMIT:raise ValueError('The 1 GB atlas cache is full of saved downloads. Remove a download pack to free space.')
        for r in victims:
            if total+len(data)<=LIMIT:break
            path(r['id']).unlink(missing_ok=True);c.execute('DELETE FROM files WHERE id=?',(r['id'],));total-=r['size']
        tmp=p.with_suffix('.part');tmp.write_bytes(data);os.replace(tmp,p)
        c.execute('INSERT OR REPLACE INTO files VALUES(?,?,?,?,?)',(ident,len(data),time.time(),mime,json.dumps(metadata or {},allow_nan=False)))
        if pin:c.execute('INSERT OR IGNORE INTO pins VALUES(?,?)',(pin,ident))
    return get(ident)

def pin(pack,ident):
    with LOCK,connect() as c:
        if c.execute('SELECT 1 FROM files WHERE id=?',(ident,)).fetchone():c.execute('INSERT OR IGNORE INTO pins VALUES(?,?)',(pack,ident))

def save_pack(pack):
    with LOCK,connect() as c:c.execute('INSERT OR REPLACE INTO packs VALUES(?,?)',(pack['id'],json.dumps(pack,allow_nan=False)))

def packs():
    with LOCK,connect() as c:return [json.loads(r[0]) for r in c.execute('SELECT payload FROM packs ORDER BY rowid DESC')]

def remove_pack(ident):
    with LOCK,connect() as c:
        c.execute('DELETE FROM pins WHERE pack=?',(ident,));c.execute('DELETE FROM packs WHERE id=?',(ident,))

def status():
    with LOCK,connect() as c:
        total,count=c.execute('SELECT coalesce(sum(size),0),count(*) FROM files').fetchone()
        pinned=c.execute('SELECT coalesce(sum(size),0) FROM files WHERE id IN (SELECT id FROM pins)').fetchone()[0]
    return {'bytes':total,'files':count,'pinned_bytes':pinned,'limit_bytes':LIMIT,'packs':packs()}
