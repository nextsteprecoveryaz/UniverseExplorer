const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');

function cockpit(){
  const nodes=new Map(),events={},windowEvents={},frames=new Map();
  let clock=0,id=0,fov=70,ra=0,dec=0,roll=0;
  const $=key=>{
    if(!nodes.has(key))nodes.set(key,{value:'1',open:false,hidden:false,textContent:'',attrs:{},classList:{add(){},remove(){},toggle(){}},setAttribute(k,v){this.attrs[k]=v;},addEventListener(){},focus(){}});
    return nodes.get(key);
  };
  const context=vm.createContext({$, $$:()=>[],Set,Map,Math,console,
    document:{hidden:false,addEventListener(k,fn){events[k]=fn;}},
    window:{matchMedia:()=>({matches:false}),addEventListener(k,fn){windowEvents[k]=fn;}},
    MutationObserver:class{observe(){}},performance:{now:()=>clock},
    requestAnimationFrame(fn){frames.set(++id,fn);return id;},cancelAnimationFrame(n){frames.delete(n);},
    state:{page:'explore',sky:{getFov:()=>[fov,fov],setFoV(v){fov=v;},getRaDec:()=>[ra,dec],gotoRaDec(a,b){ra=a;dec=b;},getRotation:()=>roll,setRotation(v){roll=v;}}},
    travelFrame:null,coordinates(){},failure(e){throw e;},stopObjectVideo(){},toast(){},noteDialog(){},currentField(){return {ra,dec,fov};}
  });
  for(const file of ['flight-math.js','flight.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../static',file),'utf8'),context);
  vm.runInContext('initFlight();flight.active=true;flightPose();',context);
  const key=(code,target=null,extra={})=>{const e={code,target,preventDefault(){this.prevented=true;},...extra};events.keydown(e);return e;};
  const advance=(count=1)=>{for(let n=0;n<count;n++){clock+=16;const pending=[...frames.values()];frames.clear();for(const fn of pending)fn(clock);}};
  return {$,events,windowEvents,context,key,advance,view:()=>({ra,dec,fov}),pending:()=>frames.size};
}

test('W changes magnification and Space cancels every scheduled movement',()=>{
  const c=cockpit();assert.equal(c.key('KeyW').prevented,true);c.advance(15);
  assert.ok(c.view().fov<70);c.key('Space');const stopped=c.view();c.advance(100);
  assert.deepEqual(c.view(),stopped);assert.equal(c.pending(),0);
});

test('text editing pauses flight and does not consume navigation letters',()=>{
  const c=cockpit();c.key('ArrowRight');c.advance(12);
  const input={closest:()=>true};c.events.focusin({target:input});const stopped=c.view();
  assert.equal(c.key('KeyW',input).prevented,undefined);c.advance(20);
  assert.deepEqual(c.view(),stopped);assert.equal(c.pending(),0);
});

test('blur and tab hiding stop cruise without automatic resumption',()=>{
  for(const reason of ['blur','hidden']){
    const c=cockpit();c.$('#flight-cruise').onclick();c.advance(40);
    assert.notEqual(c.view().ra,0);
    if(reason==='blur')c.windowEvents.blur();else{c.context.document.hidden=true;c.events.visibilitychange();}
    const stopped=c.view();c.context.document.hidden=false;c.advance(50);
    assert.deepEqual(c.view(),stopped);assert.equal(c.$('#flight-cruise').attrs['aria-pressed'],'false');
  }
});

test('opening a dialog stops the animation before it changes the sky again',()=>{
  const c=cockpit();c.key('ArrowUp');c.advance(5);c.$('#modal').open=true;
  const stopped=c.view();c.advance(10);assert.deepEqual(c.view(),stopped);assert.equal(c.pending(),0);
});

test('mouse zoom limits keep the perspective view within its usable range',()=>{
  const c=cockpit();c.context.state.sky.setFoV(300);
  vm.runInContext('flightViewChanged()',c.context);assert.equal(c.view().fov,110);
  c.context.state.sky.setFoV(.0000001);
  vm.runInContext('flightViewChanged()',c.context);assert.equal(c.view().fov,.001);
});
