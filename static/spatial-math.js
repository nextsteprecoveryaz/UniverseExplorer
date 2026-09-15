'use strict';
const SpatialMath=(()=>{
  const dot=(a,b)=>a.reduce((s,x,i)=>s+x*b[i],0);
  const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
  function project(xyz,position,camera,width,height){const delta=xyz.map((v,i)=>v-position[i]),depth=dot(delta,camera.forward);if(depth<=.005)return null;const focal=Math.min(width,height)*.82,right=cross(camera.forward,camera.up);return {x:width/2+dot(delta,right)*focal/depth,y:height/2-dot(delta,camera.up)*focal/depth,depth};}
  function move(position,camera,input,speed,dt){const right=cross(camera.forward,camera.up),length=Math.max(1,Math.hypot(...input));return position.map((v,i)=>v+(camera.forward[i]*input[0]+right[i]*input[1]+camera.up[i]*input[2])/length*speed*Math.min(.05,Math.max(0,dt)));}
  const deadzone=(v,d=.16)=>Number.isFinite(v)&&Math.abs(v)>d?Math.sign(v)*Math.min(1,(Math.abs(v)-d)/(1-d)):0;
  function gamepad(pad){if(!pad||pad.mapping!=='standard'||!pad.connected)return {input:[0,0,0,0],stop:false};return {input:[deadzone(pad.axes[0]),-deadzone(pad.axes[1]),-deadzone(pad.axes[3]),deadzone(pad.axes[2])],stop:!!pad.buttons[0]?.pressed||!!pad.buttons[9]?.pressed};}
  return {project,move,gamepad,deadzone};
})();
if(typeof module!=='undefined'&&module.exports)module.exports=SpatialMath;
