import pytest
import aladin_desktop as desktop


class Client:
    is_connected=True
    def __init__(self,status):self.messages=[];self.status=status
    def call_and_wait(self,cid,message,timeout):
        self.messages.append(message)
        if message['samp.mtype']=='image.load.fits':raise TimeoutError('Aladin MEF parent omitted its reply')
        return {'samp.status':'samp.ok','samp.result':{'script.result':self.status}}
    def disconnect(self):self.is_connected=False


@pytest.mark.parametrize('loaded',[True,False])
def test_fits_completion_timeout_does_not_resend(monkeypatch,loaded):
    # Java's file:C:/ URI and Python's file:///C:/ URI identify the same file.
    status='PlaneID "Science[1]"\nType Image\nStatus shown\nUrl file:C:/app/data/science.fits\nWidth 1024\nHeight 1024\n' if loaded else 'PlaneID "Science"\nType Folder\nStatus shown\n'
    c=Client(status)
    monkeypatch.setattr(desktop,'launch',lambda:None)
    monkeypatch.setattr(desktop,'connection',lambda:(c,[('aladin',{})]))
    if loaded:
        result=desktop.send('image.load.fits',{'url':'file:///C:/app/data/science.fits'})
        assert result['response']=='loaded-verified'
        assert result['image_planes'][0]['width']==1024
    else:
        with pytest.raises(ValueError,match='sent once'):desktop.send('image.load.fits',{'url':'file:///C:/app/data/science.fits'})
    assert sum(m['samp.mtype']=='image.load.fits' for m in c.messages)==1
    assert not c.is_connected


def test_existing_unrelated_plane_is_not_success():
    c=Client('PlaneID "Unrelated"\nType Image\nStatus shown\nUrl file:C:/app/data/other.fits\nWidth 256\nHeight 256\n')
    assert desktop.loaded_images(c,'aladin','file:///C:/app/data/science.fits')==[]
