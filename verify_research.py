"""Live, read-only archive verification; derived results are saved locally."""
import argparse,httpx,json,time
from pathlib import Path
ROOT=Path(__file__).parent
def main():
    p=argparse.ArgumentParser();p.add_argument('mode',choices=['start','poll','tess','compare','mosaic','evidence','guide','detail']);p.add_argument('--ids',nargs='*');p.add_argument('--fov',type=float,default=.003);args=p.parse_args()
    with httpx.Client(base_url='http://127.0.0.1:8765',timeout=120) as c:
        def get(url):r=c.get(url);r.raise_for_status();return r.json()
        def post(url,data):r=c.post(url,json=data);r.raise_for_status();return r.json()
        path=ROOT/'data/verification/research-api.json';receipt=json.loads(path.read_text()) if path.exists() else {}
        if args.mode=='start':
            receipt['history_job']=post('/api/research/history',{'ra':274.730583,'dec':-13.844944,'radius':.025})
            receipt['tess_job']=post('/api/research/tess',{'ra':24.35430533279,'dec':-45.67788186596,'radius':10})
            receipt['stars']=get('/api/research/stars?radius=25');print('Gaia',len(receipt['stars']['rows']))
            receipt['library']=get('/api/images');print('images',[(r['id'],r['name']) for r in receipt['library']['rows']])
        elif args.mode=='poll':
            for k,j in list(receipt.items()):
                if not k.endswith('_job'):continue
                if j.get('state') not in ('complete','failed','cancelled'):receipt[k]=get('/api/atlas/jobs/'+j['id'])
                d=receipt[k];print(k,d.get('state'),d.get('error'),d.get('progress'))
                if d.get('state')=='complete':
                    result=d['result'];receipt[k[:-4]]=result
                    if k=='history_job':print('History',result['total'],[(r['id'],r['mission'],r['filter'],r['date'],r['fits_available']) for r in result['rows'][:12]])
                    if k=='tess_job':print('TESS',len(result['rows']),[(r['id'],r['sector'],r['cadence_seconds'],r['observation']) for r in result['rows'] if r['cadence_seconds']==120][:6])
                    if k=='transit_job':print('Transit period',result['period_days'],'sector',result['tess']['header'])
        elif args.mode=='tess':
            if receipt.get('transit'):
                saved=receipt.setdefault('transit_history',[])
                if not any(r['input_sha256']==receipt['transit']['input_sha256'] for r in saved):saved.append(receipt['transit'])
            ident=args.ids[0] if args.ids else next(r['id'] for r in receipt['tess']['rows'] if r['cadence_seconds']==120 and r['sector']==1 and '-s0001-' in r['observation'])
            receipt['transit_job']=post('/api/research/tess/'+ident+'/analyze',{'min_period':.5,'max_period':5})
        elif args.mode in ('compare','mosaic'):
            receipt[args.mode+'_job']=post('/api/research/'+args.mode,{'ra':274.730583,'dec':-13.844944,'fov':args.fov,'ids':args.ids})
        elif args.mode=='evidence':receipt['evidence_job']=post('/api/research/evidence',{'image_id':args.ids[0],'threshold':6,'fwhm':2.5})
        elif args.mode=='guide':receipt['guide']=post('/api/research/guide',{'ra':274.730583,'dec':-13.844944,'radius':.025,'question':'Which observations cover here?'});print('Guide claims',len(receipt['guide']['claims']))
        elif args.mode=='detail':receipt['detail_job']=post('/api/atlas/prepare',{'record_id':'1167721488','ra':159.2128828,'dec':-58.620046,'fov':.01,'quality':1024})
        path.parent.mkdir(exist_ok=True);path.write_text(json.dumps(receipt,indent=2,allow_nan=False));print('Saved',path)
if __name__=='__main__':main()
