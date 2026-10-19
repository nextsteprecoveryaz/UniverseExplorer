import hashlib,io,json
import numpy as np
import pytest
from PIL import Image
from fastapi.testclient import TestClient
from app import app
import gpu_enhancement as gpu
import science

@pytest.fixture(autouse=True)
def isolated(tmp_path,monkeypatch):
    images=tmp_path/'images';images.mkdir();jobs=tmp_path/'jobs';jobs.mkdir()
    monkeypatch.setattr(science,'IMAGES',images);monkeypatch.setattr(gpu,'JOBS',jobs)
    monkeypatch.setattr(gpu,'ACTIVE',None);monkeypatch.setattr(gpu,'PROCESSES',{});monkeypatch.setattr(gpu,'CANCEL',set())

def source(size=(1701,30)):
    buf=io.BytesIO();Image.new('RGBA',size,(40,90,180,128)).save(buf,format='PNG')
    return science.import_image(buf.getvalue(),'test.png')

def test_preparation_uses_original_resolution_and_alpha(tmp_path):
    m=source();assert m['preview_width']<m['width']
    target=tmp_path/'prepared.png';info=gpu.prepare(m['id'],'asinh',target,2)
    with Image.open(target) as im:assert im.size==(1701,30) and im.mode=='RGBA' and im.getpixel((0,0))[3]==128
    assert info['original_sha256']==m['sha256'] and info['input_size']==[1701,30]
    assert hashlib.sha256((science.IMAGES/m['original_file']).read_bytes()).hexdigest()==m['sha256']

def test_preparation_rejects_changed_original(tmp_path):
    m=source();(science.IMAGES/m['original_file']).write_bytes(b'changed')
    with pytest.raises(ValueError,match='checksum'):gpu.prepare(m['id'],'asinh',tmp_path/'out.png',2)

def test_older_image_without_original_does_not_silently_use_preview(tmp_path):
    m=source();del m['original_file'];science.save_metadata(m)
    with pytest.raises(ValueError,match='Import the original'):gpu.prepare(m['id'],'asinh',tmp_path/'out.png',2)

def test_output_limit_rejects_instead_of_silently_shrinking(tmp_path,monkeypatch):
    m=source((64,64));monkeypatch.setattr(gpu,'MAX_OUTPUT_PIXELS',50000)
    with pytest.raises(ValueError,match='64 megapixels'):gpu.prepare(m['id'],'asinh',tmp_path/'out.png',4)

def test_fits_uses_selected_full_resolution_display_stretch(tmp_path):
    from astropy.io import fits
    values=np.arange(40*32,dtype=np.float32).reshape(32,40);buf=io.BytesIO();fits.PrimaryHDU(values).writeto(buf)
    m=science.import_image(buf.getvalue(),'test.fits');p=tmp_path/'input.png';info=gpu.prepare(m['id'],'linear',p,2)
    np.testing.assert_array_equal(np.asarray(Image.open(p))[:,:,0],np.flipud(science.stretch_array(values,'linear')))
    assert 'FITS' in info['input_kind'];assert (science.IMAGES/m['original_file']).read_bytes()==buf.getvalue()

def test_results_keep_history_original_and_embedded_provenance(tmp_path):
    m=source((50,30));original=(science.IMAGES/m['original_file']).read_bytes()
    info=gpu.prepare(m['id'],'asinh',tmp_path/'input.png',2)
    np.save(tmp_path/'output.npy',np.full((60,100,3),100,dtype=np.uint8))
    settings=gpu.Options().model_dump();stats={'gpu':'NVIDIA test GPU','output_size':[100,60],'seconds':1}
    for variant in ['a'*32,'b'*32]:
        result=gpu.save_result({'id':variant,'image_id':m['id'],'settings':settings},tmp_path,info,stats)
        with Image.open(science.IMAGES/(m['id']+'-gpu-'+variant+'.png')) as im:
            provenance=json.loads(im.info['Provenance']);assert provenance['scientific_evidence'] is False
            assert provenance['model_sha256']==gpu.MODELS['realesrnet']['sha256'];assert im.getpixel((0,59))==(0,0,0)
        assert result['url'].endswith(variant)
    saved=science.metadata(m['id']);assert len(saved['local_history'])==2 and saved['ai'] is None
    assert (science.IMAGES/m['original_file']).read_bytes()==original
    client=TestClient(app)
    assert client.get(result['url']).status_code==200
    assert client.get(f'/api/local-gpu/images/{m["id"]}/unknown').status_code==404

def test_invalid_output_dimensions_cannot_be_published(tmp_path):
    m=source((50,30));np.save(tmp_path/'output.npy',np.zeros((1,1,3),dtype=np.uint8))
    with pytest.raises(ValueError,match='dimensions'):gpu.save_result({'id':'c'*32,'image_id':m['id'],'settings':gpu.Options().model_dump()},tmp_path,{'input_size':[50,30]}, {'gpu':'test'})
    assert not science.metadata(m['id']).get('local_history')

def test_cancellation_during_png_save_prevents_publication(tmp_path,monkeypatch):
    m=source((50,30));variant='e'*32;settings=gpu.Options().model_dump()
    info=gpu.prepare(m['id'],'asinh',tmp_path/'input.png',2)
    np.save(tmp_path/'output.npy',np.zeros((60,100,3),dtype=np.uint8))
    original_save=Image.Image.save
    def save_and_cancel(self,*args,**kwargs):
        original_save(self,*args,**kwargs);gpu.CANCEL.add(variant)
    monkeypatch.setattr(Image.Image,'save',save_and_cancel)
    with pytest.raises(InterruptedError):gpu.save_result({'id':variant,'image_id':m['id'],'settings':settings},tmp_path,info,{'gpu':'test'})
    assert not science.metadata(m['id']).get('local_history')
    assert not list(science.IMAGES.glob('*-gpu-*'))

def test_api_validates_options_and_handles_missing_installation(monkeypatch):
    m=source();client=TestClient(app);url=f'/api/local-gpu/images/{m["id"]}'
    for body in [{'scale':3},{'model':'unknown'},{'strength':2},{'tile':999},{'precision':'automatic'}]:assert client.post(url,json=body).status_code==422
    monkeypatch.setattr(gpu,'installation',lambda:{'ready':False})
    assert client.post(url,json={}).status_code==503

def test_background_start_conflict_and_cancel_before_spawn(monkeypatch):
    m=source();client=TestClient(app);started=[]
    class Thread:
        def __init__(self,**kwargs):started.append(kwargs)
        def start(self):pass
    monkeypatch.setattr(gpu.threading,'Thread',Thread);monkeypatch.setattr(gpu,'installation',lambda:{'ready':True})
    response=client.post(f'/api/local-gpu/images/{m["id"]}',json={});assert response.status_code==202
    job=response.json();assert gpu.ACTIVE==job['id'] and len(started)==1
    assert client.post(f'/api/local-gpu/images/{m["id"]}',json={}).status_code==409
    assert client.post(f'/api/local-gpu/jobs/{job["id"]}/cancel').json()['status']=='cancelling'
    gpu.run_job(job['id']);assert gpu.read_job(job['id'])['status']=='cancelled' and gpu.ACTIVE is None
    assert not (gpu.JOBS/job['id']/'input.png').exists()

def test_stale_jobs_become_failed_after_restart():
    job={'id':'f'*32,'status':'running'};gpu.write_job(job)
    assert gpu.get_job(job['id'])['status']=='failed'
    with pytest.raises(Exception):gpu.get_job('../outside')

def test_new_gpu_results_can_feed_3d_with_their_own_provenance(tmp_path):
    import image_3d
    m=source((50,30));variant='c'*32
    m['cloud_ai']={'variant':'d'*32,'created_at':'2026-01-01T00:00:00Z'}
    m['local_history']=[{'variant':variant,'created_at':'2026-10-19T00:00:00Z','provider':'Local NVIDIA CUDA','model':'RealESRNet x4plus','output_size':[100,60]}]
    path=science.IMAGES/(m['id']+'-gpu-'+variant+'.png');Image.new('RGB',(100,60),'red').save(path);science.save_metadata(m)
    _,info=image_3d.source_input(image_3d.CreateJob(image_id=m['id'],source='enhanced'),tmp_path/'3d.png')
    assert info['variant']=='gpu-'+variant and info['provider']['model']=='RealESRNet x4plus'
    m['local_history'][0]['output_size']=[8000,4000];science.save_metadata(m)
    with pytest.raises(ValueError,match='25 million'):image_3d.source_input(image_3d.CreateJob(image_id=m['id'],source='enhanced'),tmp_path/'3d.png')
