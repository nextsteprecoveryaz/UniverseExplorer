const test=require('node:test');
const assert=require('node:assert/strict');
const flight=require('../static/flight-math.js');
const close=(a,b,tolerance=1e-8)=>assert.ok(Math.abs(a-b)<tolerance,`${a} should equal ${b}`);

test('travel crosses RA zero by the short arc',()=>{
  const from={ra:359,dec:0},to={ra:1,dec:0},mid=flight.interpolate(from,to,.5);
  close(flight.separation(from,mid),1,1e-6);
  close(flight.separation(mid,to),1,1e-6);
});

test('travel handles identical and antipodal positions without NaN',()=>{
  for(const [a,b] of [[{ra:0,dec:0},{ra:180,dec:0}],[{ra:42,dec:90},{ra:42,dec:-90}],[{ra:22,dec:30},{ra:22,dec:30}]]){
    const p=flight.interpolate(a,b,.5);
    assert.ok(Number.isFinite(p.ra)&&Number.isFinite(p.dec));
    close(flight.separation(a,p),flight.separation(p,b),1e-6);
    assert.deepEqual(flight.interpolate(a,b,1),b);
  }
});

test('continuous steering crosses the north pole and returns through a full turn',()=>{
  let camera=flight.basis(25,89);
  for(let i=0;i<4;i++)camera=flight.turn(camera,0,.5);
  const crossed=flight.orientation(camera);
  close(crossed.ra,205,1e-6);close(crossed.dec,89,1e-6);
  for(let i=4;i<720;i++)camera=flight.turn(camera,0,.5);
  const p=flight.orientation(camera);close(p.ra,25,1e-6);close(p.dec,89,1e-6);
});

test('long mixed steering maintains orthogonal camera axes and valid sky coordinates',()=>{
  let camera=flight.basis(359.9,-89,32);
  for(let i=0;i<20000;i++)camera=flight.turn(camera,.13,.07,.03);
  const p=flight.orientation(camera);
  close(Math.hypot(...camera.forward),1);close(Math.hypot(...camera.up),1);
  close(camera.forward.reduce((s,v,i)=>s+v*camera.up[i],0),0);
  assert.ok(p.ra>=0&&p.ra<360&&p.dec>=-90&&p.dec<=90);
  const restored=flight.orientation(flight.basis(p.ra,p.dec,p.roll));
  close(restored.roll,p.roll);close(restored.ra,p.ra);close(restored.dec,p.dec);
});

test('zoom is independent of frame rate and stays inside useful bounds',()=>{
  let f=60;for(let n=0;n<60;n++)f=flight.zoom(f,1,1/60);
  close(f,flight.zoom(60,1,1));
  close(flight.zoom(.001,100,1),.001);close(flight.zoom(110,-100,1),110);
});
