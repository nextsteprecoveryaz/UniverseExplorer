'use strict';
// Rotations on the celestial sphere keep steering continuous at RA zero and the poles.
const FlightMath=(()=>{
  const D=Math.PI/180;
  const dot=(a,b)=>a.reduce((s,v,i)=>s+v*b[i],0);
  const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
  const norm=a=>{const n=Math.hypot(...a);return a.map(v=>v/n);};
  const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
  const vector=(ra,dec)=>[Math.cos(dec*D)*Math.cos(ra*D),Math.cos(dec*D)*Math.sin(ra*D),Math.sin(dec*D)];
  const angles=v=>({ra:(Math.atan2(v[1],v[0])/D+360)%360,dec:Math.asin(clamp(v[2],-1,1))/D});
  const rotate=(v,axis,angle)=>{const c=Math.cos(angle),s=Math.sin(angle),p=dot(axis,v),q=cross(axis,v);return v.map((x,i)=>x*c+q[i]*s+axis[i]*p*(1-c));};
  function basis(ra,dec,roll=0){
    const forward=vector(ra,dec),east=[-Math.sin(ra*D),Math.cos(ra*D),0],north=cross(forward,east);
    return {forward,up:north.map((n,i)=>n*Math.cos(roll*D)-east[i]*Math.sin(roll*D))};
  }
  function orientation(camera){
    const p=angles(camera.forward),east=[-Math.sin(p.ra*D),Math.cos(p.ra*D),0],north=cross(camera.forward,east);
    return {...p,roll:-Math.atan2(dot(camera.up,east),dot(camera.up,north))/D};
  }
  function turn(camera,yaw,pitch,roll=0){
    let {forward,up}=camera;
    const right=cross(forward,up),axis=right.map((v,i)=>v*pitch-up[i]*yaw),angle=Math.hypot(...axis)*D;
    if(angle>0){const unit=norm(axis);forward=rotate(forward,unit,angle);up=rotate(up,unit,angle);}
    if(roll)up=rotate(up,forward,roll*D);
    forward=norm(forward);up=norm(up.map((v,i)=>v-forward[i]*dot(forward,up)));
    return {forward,up};
  }
  function interpolate(from,to,t){
    const a=vector(from.ra,from.dec),b=vector(to.ra,to.dec),cos=clamp(dot(a,b),-1,1),theta=Math.acos(cos);
    if(t<=0)return {ra:from.ra,dec:from.dec};if(t>=1)return {ra:to.ra,dec:to.dec};
    if(theta<1e-7)return angles(norm(a.map((v,i)=>v*(1-t)+b[i]*t)));
    let axis=cross(a,b);
    if(Math.hypot(...axis)<1e-7)axis=cross(a,Math.abs(a[2])<.9?[0,0,1]:[0,1,0]);
    return angles(rotate(a,norm(axis),theta*t));
  }
  const separation=(a,b)=>Math.acos(clamp(dot(vector(a.ra,a.dec),vector(b.ra,b.dec)),-1,1))/D;
  const zoom=(fov,rate,dt,min=.001,max=110)=>clamp(fov*Math.exp(-rate*dt),min,max);
  return {basis,orientation,turn,interpolate,separation,zoom,clamp};
})();
if(typeof module!=='undefined'&&module.exports)module.exports=FlightMath;
