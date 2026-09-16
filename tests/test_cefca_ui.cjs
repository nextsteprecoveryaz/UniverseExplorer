const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');

const source=fs.readFileSync(path.join(__dirname,'../static/navigation.js'),'utf8');
const plain=value=>JSON.parse(JSON.stringify(value));
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

function route(id,collection){
  return {
    id,title:'Tour '+id,description:'Description '+id,collection,
    kind:'waypoints',track:[],stops:[{
      title:'Target '+id,ra:187,dec:12,fov:.2,survey:collection==='cefca'?'cefca-virgo':'optical',
      source:{kind:collection==='cefca'?'cefca':'featured',id:'source-'+id},travel:4,hold:15,
    }],media:[],source_url:'https://www.cefca.es/divulgacion/tour_cumulo_virgo',
    credit:'CEFCA Foundation',cover_url:'/assets/cefca-virgo.jpg',source_language:'es',
  };
}

function harness(templates){
  const nodes=new Map(),events=[],posts=[],errors=[];
  const $=selector=>{
    if(!nodes.has(selector)){
      const node={hidden:false,buttons:[],scrollIntoView:opts=>events.push(['scroll',selector,opts])};
      let html='';
      Object.defineProperty(node,'innerHTML',{
        get:()=>html,
        set:value=>{
          html=value;node.buttons=[];
          for(const match of value.matchAll(/<button\b[^>]*data-template-(start|copy)="(\d+)"[^>]*>/g)){
            node.buttons.push({kind:match[1],dataset:{[match[1]==='start'?'templateStart':'templateCopy']:match[2]}});
          }
        },
      });
      nodes.set(selector,node);
    }
    return nodes.get(selector);
  };
  const $$=selector=>{
    const kind=selector==='[data-template-start]'?'start':selector==='[data-template-copy]'?'copy':null;
    return [...nodes.values()].flatMap(node=>node.buttons).filter(button=>button.kind===kind);
  };
  const c=vm.createContext({
    $, $$, esc:escape, templates, events, routeTime:seconds=>Math.floor(seconds/60)+':'+String(seconds%60).padStart(2,'0'),
    busy:async(button,label,action)=>action(),
    jsonPost:async(url,body)=>{posts.push({url,body:plain(body)});events.push(['post',body.title]);return {id:'saved-'+posts.length};},
    playSavedRoute:async id=>events.push(['play',id]),
    failure:error=>errors.push(error),
    interruptTour:reason=>events.push(['pause',reason]),flight:{active:false},
    modal:(title,html)=>events.push(['modal',title,html]),
  });
  vm.runInContext(source,c);
  const run=code=>vm.runInContext(code,c);
  run(`navigationUI.templates=templates;
    loadSavedRoutes=async()=>events.push(['reload']);
    editSavedRoute=async id=>events.push(['edit',id]);
    saveEditedRoute=async()=>{events.push(['save-dirty']);navigationUI.dirty=false;};`);
  return {c,$,$$,run,events,posts,errors};
}

test('CEFCA grouping retains original template indexes in both sets of cards',()=>{
  const p=harness([route('a'),route('b','cefca'),route('c'),route('d','cefca')]);
  p.run('renderTourTemplates()');
  assert.equal(p.$('#cefca-tour-section').hidden,false);
  assert.deepEqual(p.$('#cefca-guided-tours').buttons.filter(b=>b.kind==='start').map(b=>b.dataset.templateStart),['1','3']);
  assert.deepEqual(p.$('#guided-tours').buttons.filter(b=>b.kind==='start').map(b=>b.dataset.templateStart),['0','2']);
  assert.match(p.$('#cefca-guided-tours').innerHTML,/Original guide in Spanish/);
  assert.match(p.$('#cefca-guided-tours').innerHTML,/CEFCA Foundation/);
});

test('Start creates and plays the actual selected template after grouping',async()=>{
  const templates=[route('a'),route('b','cefca'),route('c'),route('d','cefca')],p=harness(templates);
  p.run('renderTourTemplates()');
  for(const button of p.$$('[data-template-start]')){
    const index=Number(button.dataset.templateStart);
    await button.onclick();
    const posted=p.posts.at(-1);
    assert.equal(posted.url,'/api/navigation/routes');
    assert.equal(posted.body.title,templates[index].title);
    assert.deepEqual(posted.body.stops,templates[index].stops);
    assert.deepEqual(Object.keys(posted.body).sort(),['description','kind','stops','title','track']);
    assert.deepEqual(plain(p.events.slice(-2)),[['reload'],['play','saved-'+p.posts.length]]);
  }
  assert.deepEqual(p.errors,[]);
});

test('Customize saves pending edits and copies selected source references before opening the editor',async()=>{
  const templates=[route('a'),route('b','cefca'),route('c'),route('d','cefca')],p=harness(templates);
  p.run('renderTourTemplates()');
  for(const button of p.$$('[data-template-copy]')){
    const index=Number(button.dataset.templateCopy),start=p.events.length;
    p.run('navigationUI.dirty=true');
    await button.onclick();
    const posted=p.posts.at(-1),events=p.events.slice(start);
    assert.equal(posted.body.title,templates[index].title+' · my route');
    assert.deepEqual(posted.body.stops,templates[index].stops);
    assert.deepEqual(events.map(event=>event[0]),['save-dirty','post','reload','edit','scroll']);
    assert.equal(events[3][1],'saved-'+p.posts.length);
    assert.equal(events[4][1],'#route-editor');
  }
});

test('card text and source/cover attributes escape markup',()=>{
  const cefca=route('b','cefca'),regular=route('a');
  const malicious='<img src=x onerror="attack()"> & \'quoted\'';
  cefca.title=cefca.description=regular.title=regular.description=malicious;
  cefca.source_url='https://www.cefca.es/?q=" onclick="attack()';
  cefca.cover_url='/assets/cover.jpg" onerror="attack()';
  regular.media=[{title:malicious,preview_url:'/assets/image.jpg" onerror="attack()'}];
  const p=harness([regular,cefca]);p.run('renderTourTemplates()');
  for(const selector of ['#guided-tours','#cefca-guided-tours']){
    const html=p.$(selector).innerHTML;
    assert.ok(html.includes(escape(malicious)));
    assert.ok(!html.includes(malicious));
    assert.doesNotMatch(html,/"\s+(onerror|onclick)="attack/);
  }
  assert.ok(p.$('#cefca-guided-tours').innerHTML.includes('href="'+escape(cefca.source_url)+'"'));
  assert.doesNotMatch(p.$('#cefca-guided-tours').innerHTML,/<img\b/);
  assert.doesNotMatch(p.$('#guided-tours').innerHTML,/<img\b/);
});

test('removing the CEFCA collection hides its section without leaving stale action buttons',()=>{
  const p=harness([route('a'),route('b','cefca')]);p.run('renderTourTemplates()');
  p.run('navigationUI.templates=templates.slice(0,1);renderTourTemplates()');
  assert.equal(p.$('#cefca-tour-section').hidden,true);
  assert.equal(p.$('#cefca-guided-tours').innerHTML,'');
  assert.equal(p.$$('[data-template-start]').length,1);
  assert.equal(p.$$('[data-template-copy]').length,1);
});

test('CEFCA inspection shows the source guide and escaped notes without using a featured-object inspector',async()=>{
  const p=harness([]);
  p.c.media={kind:'cefca',available:true,title:'M87',description:'Look <closely> & compare.',credit:'CEFCA Foundation',ra:187.7059304,dec:12.3911231,source_url:'https://www.cefca.es/divulgacion/tour_cumulo_virgo'};
  await p.run('inspectNavigationMedia(media)');
  const modal=p.events.find(event=>event[0]==='modal');
  assert.ok(modal);
  assert.equal(modal[1],'M87');
  assert.match(modal[2],/Look &lt;closely&gt; &amp; compare\./);
  assert.match(modal[2],/187\.705930/);
  assert.match(modal[2],/Read the original Spanish guide/);
  assert.match(modal[2],/target="_blank" rel="noopener"/);
  assert.deepEqual(p.errors,[]);
});

test('story citations are linked, escaped and reject non-HTTPS URLs',()=>{
  const p=harness([]);
  p.c.media={story_sources:[{title:'NASA <research>',url:'https://science.nasa.gov/example?q="quoted"'},{title:'Unsafe',url:'javascript:alert(1)'},null]};
  const html=p.run('storySourcesMarkup(media)');
  assert.match(html,/Story sources/);
  assert.match(html,/NASA &lt;research&gt;/);
  assert.match(html,/&quot;quoted&quot;/);
  assert.match(html,/rel="noopener noreferrer"/);
  assert.doesNotMatch(html,/javascript:|Unsafe/);
  assert.equal(p.run('storySourcesMarkup(null)'),'');
});
