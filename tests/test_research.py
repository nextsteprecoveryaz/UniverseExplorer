import asyncio,io,json
import numpy as np
import pytest
from astropy.io import fits
from astropy.wcs import WCS
import discovery,science,epoch_images,field_history,research_services

def original(epoch=59000,shift=0):
    rng=np.random.default_rng(713);y,x=np.mgrid[:128,:128];data=rng.normal(100,1,(128,128))
    for sx,sy,amplitude in [(40+shift,50,120),(44+shift,50,100),(90,90,150)]:data+=amplitude*np.exp(-((x-sx)**2+(y-sy)**2)/(2*(2.5/2.35482)**2))
    # Third source is detector flagged and must be excluded.
    dq=np.zeros((128,128),dtype=np.uint16);dq[85:96,85:96]=4
    w=WCS(naxis=2);w.wcs.crpix=[64,64];w.wcs.crval=[83,-5];w.wcs.cdelt=[-.0001,.0001];w.wcs.ctype=['RA---TAN','DEC--TAN']
    h=w.to_header();h['BUNIT']='electron/s';primary=fits.PrimaryHDU();primary.header['EXPSTART']=epoch
    out=io.BytesIO();fits.HDUList([primary,fits.ImageHDU(data.astype('f4'),h,name='SCI'),fits.ImageHDU(np.ones_like(data,dtype='f4'),name='ERR'),fits.ImageHDU(dq,name='DQ')]).writeto(out);return out.getvalue()

def test_dq_grouped_fit_and_repeat_association(tmp_path,monkeypatch):
    monkeypatch.setattr(science,'IMAGES',tmp_path)
    m=science.import_image(original(),'original.fits');report=discovery.analyze(m['id'])
    assert report['dq_applied'] and report['error_plane'] and report['epoch_mjd']==59000
    assert len(report['rows'])==2
    assert len({r['group'] for r in report['rows']})==1
    assert sorted(r['x'] for r in report['rows'])==pytest.approx([40,44],abs=.15)
    assert all(r['flux_error']>0 and r['ra'] is not None and r['fit_flags']==0 for r in report['rows'])
    second=science.import_image(original(60000,.2),'second.fits');discovery.analyze(second['id'])
    repeat=discovery.repeat_check(m['id'],second['id'],radius=.2)
    assert all(r['within_radius'] and not r['ambiguous'] for r in repeat['rows'])
    assert (tmp_path/(m['id']+'.fits')).read_bytes()==original()

def test_no_duplicate_or_display_fits_evidence(tmp_path,monkeypatch):
    monkeypatch.setattr(science,'IMAGES',tmp_path)
    m=science.import_image(original(),'source.fits');discovery.analyze(m['id'])
    with pytest.raises(ValueError,match='different original'):discovery.repeat_check(m['id'],m['id'])
    hdus=fits.open(io.BytesIO(original()));hdus['SCI'].header['VISONLY']=True;out=io.BytesIO();hdus.writeto(out)
    display=science.import_image(out.getvalue(),'resampled.fits')
    with pytest.raises(ValueError,match='display cutout'):discovery.analyze(display['id'])

def test_mosaic_never_fills_missing_or_averages_sources():
    a=np.array([[1,np.nan],[3,np.nan]],dtype='f4');b=np.array([[8,2],[np.nan,np.nan]],dtype='f4')
    result,source,coverage=epoch_images.combine([a,b])
    assert result[0,0]==1 and result[0,1]==2 and np.isnan(result[1,1])
    assert source.tolist()==[[1,2],[1,0]] and coverage.tolist()==[[2,1],[1,0]]

def test_resolution_matching_preserves_missing_data_and_flux():
    y,x=np.mgrid[:101,:101];a=np.exp(-((x-50)**2+(y-50)**2)/(2*2**2))/(2*np.pi*4);b=np.exp(-((x-50)**2+(y-50)**2)/(2*3**2))/(2*np.pi*9)
    a[:5]=np.nan;b[:5]=np.nan
    (first,second),common=epoch_images.matched(a,b,2*2.354820045,3*2.354820045)
    assert common==pytest.approx(3*2.354820045)
    assert np.isnan(first[:5]).all()
    assert np.max(np.abs(first[35:66,35:66]-second[35:66,35:66]))<2e-6

def test_incompatible_epochs_are_not_change_evidence():
    a={'obs_collection':'HST','instrument_name':'WFC3/UVIS','filters':'F606W','dataURL':'a','t_min':1,'t_max':2}
    b={**a,'filters':'F814W','dataURL':'b','t_min':3,'t_max':4}
    assert 'Different or unknown filter' in field_history.compatible(a,b)
    assert 'Same underlying product' in field_history.compatible(a,a)
    b.update(filters='F606W',t_min=1.5)
    assert any('Overlapping' in x for x in field_history.compatible(a,b))

def test_gaia_distance_geometry_and_uncertainty():
    r=research_services.space_row({'source_id':5853498713190525696,'ra':90,'dec':0,'parallax':100,'parallax_error':1})
    assert r['source_id']=='5853498713190525696'
    assert r['xyz_pc']==pytest.approx([0,10,0],abs=1e-12)
    assert r['distance_pc']==10 and r['distance_error_pc']==.1
    assert r['distance_interval_pc']==pytest.approx([1000/101,1000/99])
    assert research_services.space_row({'parallax':-1,'parallax_error':1}) is None
    assert research_services.space_row({'parallax':3,'parallax_error':1}) is None

def test_history_count_failure_does_not_replace_saved_search(tmp_path,monkeypatch):
    monkeypatch.setattr(field_history,'PATH',tmp_path/'history.db')
    async def incomplete(*args,**kwargs):return {'data':{'data':[],'paging':{'rowsFiltered':10,'pagesFiltered':1}},'stale':False}
    monkeypatch.setattr(field_history.remote,'mast',incomplete)
    with pytest.raises(ValueError,match='completeness'):asyncio.run(field_history.fetch(10,0,.01))
    assert field_history.saved()==[]

def test_watch_baseline_new_generation_and_duplicate_notifications(tmp_path,monkeypatch):
    monkeypatch.setattr(research_services,'PATH',tmp_path/'research.db')
    rows=[{'record_id':'1','obsid':'1','obs_id':'test1','obs_collection':'HST','s_ra':10,'s_dec':0,'t_min':59000}]
    monkeypatch.setattr(field_history,'local_rows',lambda *args:rows[:])
    gen=['old'];monkeypatch.setattr(research_services.recent_archive,'active',lambda c:gen[0])
    item=research_services.add_watch({'title':'Test','ra':10,'dec':0,'radius':.02})
    assert item['baseline']==1 and research_services.watches()['notices']==[]
    rows.append({**rows[0],'record_id':'2','obsid':'2','obs_id':'test2'})
    gen[0]='new';r=research_services.check_watches()
    assert r['added']==1 and r['notices'][0]['count']==1
    assert research_services.check_watches()['added']==0
    research_services.read_notice(r['notices'][0]['id']);assert research_services.watches()['notices'][0]['read']
    research_services.remove_watch(item['id']);assert research_services.watches()['rows']==[]

def test_research_input_validation():
    from fastapi.testclient import TestClient
    from app import app
    c=TestClient(app)
    assert c.post('/api/research/evidence',json={'image_id':'../elsewhere'}).status_code==422
    assert c.get('/api/research/stars?radius=10000').status_code==422
    assert c.post('/api/research/compare',json={'ra':0,'dec':0,'fov':1,'ids':['1','2']}).status_code==422
    assert c.post('/api/research/tess/1/analyze',json={'min_period':10,'max_period':2}).status_code==422

def test_common_grid_difference_requires_compatible_calibration(tmp_path,monkeypatch):
    import atlas_cache
    monkeypatch.setattr(atlas_cache,'ROOT',tmp_path/'cache')
    a={'record_id':'1','obsid':'1','obs_id':'first','obs_collection':'HST','instrument_name':'WFC3/UVIS','filters':'F656N','t_min':59000,'t_max':59001,'dataURL':'first.fits'}
    b={**a,'record_id':'2','obsid':'2','obs_id':'second','t_min':60000,'t_max':60001,'dataURL':'second.fits'}
    monkeypatch.setattr(field_history,'observation',lambda i:a if i=='1' else b)
    header=epoch_images.sky_cutout.view_header(10,0,.01,32);y,x=np.mgrid[:32,:32];base=100+100*np.exp(-((x-16)**2+(y-16)**2)/8)
    def fetch(o,ra,dec,fov,grid,size=768):
        out=io.BytesIO();data=base.copy()
        if o['record_id']=='2':data[16,16]+=50
        fits.PrimaryHDU(data,header=fits.Header(header)).writeto(out)
        return out.getvalue(),{'wcs':header,'unit':'ELECTRONS/S','fov':.01}
    monkeypatch.setattr(epoch_images,'fetch',fetch)
    without_psf=epoch_images.compare(['1','2'],10,0,.01)
    assert without_psf['difference'] is None
    result=epoch_images.compare(['1','2'],10,0,.01,psf=[.1,.1])
    assert result['difference'] and result['difference_unavailable']==[]
    assert result['overlap_fraction']==1
    b['filters']='F814W';assert epoch_images.compare(['1','2'],10,0,.01,psf=[.1,.1])['difference'] is None
    with pytest.raises(ValueError,match='older observation'):epoch_images.compare(['2','1'],10,0,.01)

def test_multichip_cutout_selects_chip_at_requested_position():
    from sky_cutout import from_archive,view_header
    class Reader(io.BytesIO):
        etag='test';size=1;transferred=1;requests=1
    h1=fits.ImageHDU(np.ones((64,64)),fits.Header(view_header(20,0,.01,64)),name='SCI');h1.header['EXTVER']=1
    h2=fits.ImageHDU(np.full((64,64),5.),fits.Header(view_header(10,0,.01,64)),name='SCI');h2.header['EXTVER']=2
    out=io.BytesIO();fits.HDUList([fits.PrimaryHDU(),h1,h2]).writeto(out)
    content,meta=from_archive({'dataURL':'mast:HST/product/test.fits','record_id':'1'},10,0,.001,reader_factory=lambda uri:Reader(out.getvalue()))
    assert np.nanmedian(fits.getdata(io.BytesIO(content)))==5
    assert meta['finite_fraction']>0
