'use strict';
const RouteTimeline=(()=>{
  const blend=(a,b,t)=>Math.exp(Math.log(Math.max(.001,a))*(1-t)+Math.log(Math.max(.001,b))*t);
  const ease=t=>t*t*(3-2*t);
  function interpolate(a,b,t,scenic=false){
    const p=FlightMath.interpolate(a,b,t),delta=((b.roll-a.roll+180)%360+360)%360-180;
    const roll=t<=0?a.roll:t>=1?b.roll:((a.roll+delta*t+180)%360+360)%360-180;
    let fov=blend(a.fov,b.fov,t);
    if(scenic){const peak=Math.max(a.fov,b.fov,Math.min(110,FlightMath.separation(a,b)*1.3));fov=t<.4?blend(a.fov,peak,ease(t/.4)):blend(peak,b.fov,ease((t-.4)/.6));}
    const survey=scenic&&t>0&&t<1&&FlightMath.separation(a,b)>Math.max(a.fov,b.fov)*2?'optical':(t<1?a.survey:b.survey);
    return {...(t<1?a:b),...p,roll,fov,survey,projection:scenic&&t<1?'AIT':(t<1?a.projection:b.projection)};
  }
  function build(route,origin){
    if(route.kind==='recording')return {route,origin,total:route.track.at(-1)?.t||0,segments:[]};
    let time=0,from=origin;
    const segments=route.stops.map((to,index)=>{const s={index,from,to,start:time,arrive:time+to.travel,end:time+to.travel+to.hold};time=s.end;from=to;return s;});
    return {route,origin,total:time,segments};
  }
  function at(timeline,time){
    const {route,segments,total}=timeline,t=Math.min(total,Math.max(0,time));
    if(route.kind==='recording'){
      const track=route.track;if(!track.length)return null;
      let low=0,high=track.length-1;
      while(low<high){const mid=Math.ceil((low+high)/2);if(track[mid].t<=t)low=mid;else high=mid-1;}
      const a=track[low],b=track[Math.min(low+1,track.length-1)],mix=b.t>a.t?(t-a.t)/(b.t-a.t):1;
      return {view:interpolate(a,b,mix),index:low,phase:t>=total?'finished':'recording',time:t};
    }
    if(!segments.length)return null;
    const s=segments.find(s=>t<s.end)||segments.at(-1),moving=t<s.arrive;
    const view=moving?interpolate(s.from,s.to,ease((t-s.start)/(s.arrive-s.start)),true):{...s.to};
    return {view,index:s.index,phase:t>=total?'finished':moving?'travel':'hold',time:t,remaining:Math.max(0,s.end-t)};
  }
  function nearestOrder(stops,origin){
    const pending=stops.map((s,i)=>({s,i})),order=[];let here=origin;
    while(pending.length){pending.sort((a,b)=>FlightMath.separation(here,a.s)-FlightMath.separation(here,b.s)||a.i-b.i);const next=pending.shift();order.push(next.i);here=next.s;}
    return order;
  }
  return {build,at,interpolate,nearestOrder};
})();
if(typeof module!=='undefined'&&module.exports)module.exports=RouteTimeline;
