import asyncio
import pytest
import object_facts as facts


def detail(**kw):
    return {'id':'simbad:NGC  1635','name':'NGC 1635','ra':70.0328375,'dec':-.5475611,'type':'Emission-line galaxy','type_code':'EmG',
            'source_url':'https://simbad.cds.unistra.fr/simbad/sim-id?Ident=NGC1635','constellation':'Eridanus',
            'measurements':{'morph_type':'SO-a','morph_bibcode':'2003A&A...412...45P','galdim_majaxis':1.52938,'galdim_minaxis':1.42339,'galdim_bibcode':'2023ApJS..269....3M'},
            'distances':[{'dist':44.62,'unit':'Mpc ','method':'redshift','bibcode':'2007ApJ...655..790C'}],**kw}


def test_measured_ngc_story_uses_referenced_estimate_and_speech_safe_prose():
    story,sources=facts.prose(detail())
    assert 'NGC 1635' in story and 'Eridanus' in story and 'lenticular-to-spiral' in story
    assert '146 million light-years' in story and 'from 2007' in story and 'redshift-based' in story
    assert '1.5 by 1.4 arcminutes' in story and 'emission-line galaxy' in story
    assert 'http' not in story and '**' not in story and '2007ApJ' not in story
    assert any('2007ApJ' in s['url'] for s in sources)
    assert len(story)<2500


@pytest.mark.parametrize('dist,unit,qual',[(0,'Mpc',None),(-2,'Mpc',None),(float('nan'),'Mpc',None),(1,'unknown',None),(1,None,None),(22,'Mpc','<'),(22,'Mpc','>')])
def test_invalid_distances_and_limits_never_become_asserted_measurements(dist,unit,qual):
    story,_=facts.prose(detail(distances=[{'dist':dist,'unit':unit,'qual':qual,'bibcode':'2020A'}]))
    assert 'light-years' not in story


@pytest.mark.parametrize('code',['E/S0','S0:','SB?','unknown'])
def test_ambiguous_morphology_is_not_silently_promoted_to_lenticular(code):
    assert facts.morphology(code) is None
    story,_=facts.prose(detail(measurements={'morph_type':code}))
    assert code in story


def test_lookup_escapes_identifiers_and_returns_real_constellation(monkeypatch):
    seen=[]
    async def remote(url,**kw):
        seen.append(kw['params']['query'])
        return {'data':{'metadata':[{'name':k} for k in ['main_id','ra','dec','otype','dist','unit','bibcode']],
                        'data':[['NGC  1635',70.0328375,-.5475611,'EmG',44.62,'Mpc','2007ApJ...655..790C']]},'fetched_at':'2026-10-19','stale':False}
    monkeypatch.setattr(facts.remote,'remote_json',remote)
    result=asyncio.run(facts.lookup("  Name's object  "))
    assert "i.id='Name''s object'" in seen[0]
    assert result['constellation']=='Eridanus' and result['name']=='NGC 1635' and result['type']=='Emission-line galaxy'
    assert len(result['distances'])==1
