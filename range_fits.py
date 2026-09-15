"""Bounded HTTP byte-range reader for public, uncompressed MAST FITS products."""
import io
import re
import time
from collections import OrderedDict
from urllib.parse import quote
import httpx

class RangeFITS(io.RawIOBase):
    def __init__(self,uri,budget=96*1024*1024,block_size=256*1024,client=None):
        if not re.fullmatch(r'mast:(?:JWST|HST|HLA|HLSP)/[A-Za-z0-9_./+-]+\.fits',uri,re.I) or '..' in uri:raise ValueError('A public uncompressed MAST FITS identifier is required.')
        self.uri=uri;self.url='https://mast.stsci.edu/api/v0.1/Download/file?uri='+quote(uri,safe='')
        self.budget=budget;self.block_size=block_size;self.transferred=0;self.requests=0;self.position=0;self.size=None;self.cache=OrderedDict();self.deadline=time.monotonic()+150
        self.client=client or httpx.Client(timeout=httpx.Timeout(35,connect=12),follow_redirects=True);self.owns_client=client is None
        self.etag=None
    def readable(self):return True
    def seekable(self):return True
    def tell(self):return self.position
    def seek(self,offset,whence=0):
        if whence==2 and self.size is None:self._block(0)
        p=offset if whence==0 else self.position+offset if whence==1 else self.size+offset
        if p<0:raise ValueError('Invalid negative FITS seek.')
        self.position=int(p);return self.position
    def _block(self,n):
        if n in self.cache:self.cache.move_to_end(n);return self.cache[n]
        if time.monotonic()>self.deadline:raise ValueError('The archive cutout exceeded its time budget.')
        start=n*self.block_size;end=start+self.block_size-1
        if self.size is not None:
            if start>=self.size:return b''
            end=min(end,self.size-1)
        if self.transferred+end-start+1>self.budget:raise ValueError('The cutout reached its download budget. Zoom closer or choose another observation.')
        headers={'Range':f'bytes={start}-{end}','Accept-Encoding':'identity'}
        if self.etag:headers['If-Range']=self.etag
        with self.client.stream('GET',self.url,headers=headers) as response:
            response.raise_for_status()
            match=re.fullmatch(r'bytes (\d+)-(\d+)/(\d+)',response.headers.get('content-range',''))
            if response.status_code!=206 or not match:raise ValueError('This archive endpoint does not support safe partial downloads for this product.')
            a,b,total=map(int,match.groups())
            if a!=start or b>end or b!=min(end,total-1) or total<=b:raise ValueError('The archive returned an inconsistent byte range.')
            if self.size is not None and self.size!=total:raise ValueError('The archive product changed during the download.')
            etag=response.headers.get('etag')
            if self.etag and etag and etag!=self.etag:raise ValueError('The archive product changed during the download.')
            self.size=total;self.etag=etag or self.etag;data=bytearray()
            for chunk in response.iter_bytes():
                data.extend(chunk)
                if len(data)>b-a+1:raise ValueError('The archive sent more bytes than requested.')
            if len(data)!=b-a+1:raise ValueError('The archive range response was truncated.')
        self.transferred+=len(data);self.requests+=1;self.cache[n]=bytes(data)
        while len(self.cache)>64:self.cache.popitem(last=False)
        return self.cache[n]
    def read(self,size=-1):
        if size<0:
            if self.size is None:self._block(0)
            size=self.size-self.position
        if size>self.budget:raise ValueError('The requested FITS section exceeds the download budget.')
        chunks=[]
        while size>0:
            n,offset=divmod(self.position,self.block_size);data=self._block(n)
            if offset>=len(data):break
            chunk=data[offset:offset+size];chunks.append(chunk);self.position+=len(chunk);size-=len(chunk)
        return b''.join(chunks)
    def readinto(self,b):
        data=self.read(len(b));b[:len(data)]=data;return len(data)
    def close(self):
        if self.owns_client:self.client.close()
        self.cache.clear();super().close()
