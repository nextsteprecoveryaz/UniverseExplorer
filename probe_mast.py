import concurrent.futures
import json
import time
import httpx

REQUEST={'service':'Mast.Caom.Filtered.Position','params':{'columns':'*','position':'83.82208, -5.39111, 0.02','filters':[{'paramName':'obs_collection','values':['HST','HLA','JWST']},{'paramName':'dataproduct_type','values':['image']},{'paramName':'dataRights','values':['PUBLIC']},{'paramName':'calib_level','values':[2,3]}]},'format':'json','pagesize':3,'page':1}
def probe(method):
    start=time.time()
    try:
        with httpx.Client(timeout=30,follow_redirects=True) as c:
            if method=='POST':r=c.post('https://mast.stsci.edu/api/v0/invoke',data={'request':json.dumps(REQUEST)})
            else:r=c.get('https://mast.stsci.edu/api/v0/invoke',params={'request':json.dumps(REQUEST)})
            print(method,r.status_code,round(time.time()-start,2),r.text[:1200],flush=True)
    except Exception as e:print(method,type(e).__name__,str(e),round(time.time()-start,2),flush=True)

if __name__=='__main__':
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as p:
        list(p.map(probe,['GET','POST']))
