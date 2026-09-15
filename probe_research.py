import asyncio,json,httpx
import integrations as r
async def main():
    import field_history
    req={'service':'Mast.Caom.Filtered.Position','params':{'columns':field_history.FIELDS,'position':'274.73058300, -13.84494400, 0.02500000','filters':[{'paramName':'obs_collection','values':['HST','JWST']},{'paramName':'dataproduct_type','values':['image']},{'paramName':'dataRights','values':['PUBLIC']},{'paramName':'calib_level','values':[2,3]},{'paramName':'intentType','values':['science']}]},'format':'json','page':1,'pagesize':1000}
    async with httpx.AsyncClient(timeout=80) as c:
        x=await c.get(r.MAST,params={'request':json.dumps(req)});print('history raw',x.status_code,x.text[:2500])
    p=await r.resolve('WASP-18');print('target',p)
    for name,service,params in [
      ('tess','Mast.Caom.Filtered.Position',{'columns':'*','position':f"{p['ra']}, {p['dec']}, 0.003",'filters':[{'paramName':'obs_collection','values':['TESS']},{'paramName':'dataproduct_type','values':['timeseries']}]}),
      ('tic','Mast.Catalogs.Tic.Cone',{'ra':p['ra'],'dec':p['dec'],'radius':.003})]:
        try:
            d=await r.mast(service,params,pagesize=3);print(name,json.dumps(d)[:7000])
            if name=='tess' and d['data']['data']:
                products=await r.products(d['data']['data'][0]['obsid']);print('products',json.dumps(products)[:4000])
        except Exception as e:print(name,type(e).__name__,str(e))
    try:
        d=await r.remote_json('https://gea.esac.esa.int/tap-server/tap/sync',params={'REQUEST':'doQuery','LANG':'ADQL','FORMAT':'json','QUERY':'SELECT TOP 3 source_id,ra,dec,parallax,parallax_error,parallax_over_error,phot_g_mean_mag,ruwe FROM gaiadr3.gaia_source WHERE parallax>100 AND parallax_over_error>10 AND ruwe<1.4 ORDER BY parallax DESC'},ttl=86400);print('gaia',json.dumps(d)[:3000])
    except Exception as e:print('gaia',type(e).__name__,str(e))
asyncio.run(main())
