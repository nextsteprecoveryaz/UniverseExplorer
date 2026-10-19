'use strict';
const objectVideoUI={object:null,items:[],player:null,serial:0,api:null,ready:false};
function objectVideoItems(o){
  const canonical=value=>String(value||'').toLowerCase().replace(/\s+/g,'').replace(/\b(m|ngc|ic)-(\d)/g,'$1$2');
  const destination=(state.config?.destinations||[]).find(d=>canonical(d.object_id)===canonical(o.id)||d.id===o.id);
  const rows=destination?.videos||o.videos||[];
  return rows.filter(v=>v.provider==='youtube'&&/^[A-Za-z0-9_-]{11}$/.test(v.id));
}
function objectVideoStatus(message){const node=$('#object-video-status');if(node)node.textContent=message;}
function pauseObjectVideos(keepNative=false){
  objectVideoUI.serial++;
  if(objectVideoUI.ready){try{objectVideoUI.player?.pauseVideo();}catch{}}
  else if(objectVideoUI.player){try{objectVideoUI.player.destroy();}catch{}objectVideoUI.player=null;}
  if(!keepNative)$('#object-video')?.pause();
}
function stopObjectVideoLibrary(){
  objectVideoUI.serial++;try{objectVideoUI.player?.destroy();}catch{}
  objectVideoUI.player=null;objectVideoUI.ready=false;
  const stage=$('#object-video-stage');if(stage){stage.hidden=true;stage.replaceChildren();}
  const links=$('#object-video-links');if(links)links.hidden=true;
  $$('#object-video-list [data-object-video]').forEach(button=>button.setAttribute('aria-pressed','false'));
}
function pauseNarrationForVideo(){
  if(typeof cancelDestinationVisit==='function')cancelDestinationVisit();
  $('#object-research-audio')?.pause();
  if(typeof pauseTourNarration==='function')pauseTourNarration();
}
function loadObjectYouTubeAPI(){
  if(window.YT?.Player)return Promise.resolve(window.YT);
  if(objectVideoUI.api)return objectVideoUI.api;
  objectVideoUI.api=new Promise((resolve,reject)=>{
    const script=document.createElement('script');script.src='https://www.youtube.com/iframe_api';script.async=true;
    const previous=window.onYouTubeIframeAPIReady;
    let settled=false,timer;
    const finish=error=>{
      if(settled)return;settled=true;clearTimeout(timer);
      if(error){script.remove();window.onYouTubeIframeAPIReady=previous;reject(error);}else resolve(window.YT);
    };
    window.onYouTubeIframeAPIReady=()=>{if(typeof previous==='function')previous();finish();};
    script.onerror=()=>finish(new Error('YouTube could not load. Use Watch on YouTube to open the video.'));
    timer=setTimeout(()=>finish(new Error('YouTube is taking too long to load. Try the video again or use Watch on YouTube.')),15000);
    document.head.append(script);
  }).catch(error=>{objectVideoUI.api=null;throw error;});
  return objectVideoUI.api;
}
function renderObjectVideos(o){
  objectVideoUI.object=o;objectVideoUI.items=objectVideoItems(o);
  const items=objectVideoUI.items,node=$('#object-videos');if(!node)return;
  if(!items.length){node.innerHTML=o.video_url?'':'<p class="video-unavailable">No curated video is linked for this object yet.</p>';return;}
  node.innerHTML=`<div class="object-videos-heading"><h3>Watch & explore</h3><span>${items.length} YouTube videos</span></div><p class="object-videos-note">Scroll to choose a video. Playing pauses narration; your saved story stays here.</p><div id="object-video-stage" class="object-video-stage" hidden></div><div id="object-video-links" class="object-video-links" hidden><a id="object-video-watch" target="_blank" rel="noopener">Watch on YouTube ↗</a><button id="object-video-expand" class="text-button">Larger view</button></div><p id="object-video-status" role="status"></p><div id="object-video-list" class="object-video-list" role="region" aria-label="Videos about ${esc(o.name)}" tabindex="0">${items.map((v,i)=>`<button class="object-video-choice" data-object-video="${i}" aria-pressed="false" aria-label="Play ${esc(v.title)}"><img src="https://i.ytimg.com/vi/${v.id}/mqdefault.jpg" alt="" loading="lazy"><span><strong>${esc(v.title)}</strong><small>${esc(v.channel)}${v.duration?' · '+esc(v.duration):''}</small></span><span class="object-video-play" aria-hidden="true">▶</span></button>`).join('')}</div><p class="object-videos-note">YouTube needs internet. Publisher restrictions may require opening a video on YouTube. Videos may show other wavelengths, animations, or artist’s impressions.</p>`;
  $$('#object-video-list [data-object-video]').forEach(button=>button.onclick=()=>playObjectYouTube(o,Number(button.dataset.objectVideo)));
  $('#object-video-expand').onclick=async()=>{
    const stage=$('#object-video-stage');if(stage.hidden)return;
    try{if(!stage.requestFullscreen)throw new Error();await stage.requestFullscreen();}
    catch{objectVideoStatus('Use the player’s fullscreen control or Watch on YouTube for a larger view.');}
  };
}
async function playObjectYouTube(o,index){
  if(mapUI.selected!==o||objectVideoUI.object!==o)return;
  const video=objectVideoUI.items[index];if(!video)return;
  const serial=++objectVideoUI.serial;
  try{objectVideoUI.player?.destroy();}catch{}objectVideoUI.player=null;objectVideoUI.ready=false;
  $('#object-video')?.pause();pauseNarrationForVideo();
  const stage=$('#object-video-stage');stage.hidden=false;stage.innerHTML='<div id="object-youtube-player"></div>';
  $('#object-video-links').hidden=false;$('#object-video-watch').href='https://www.youtube.com/watch?v='+video.id;
  $$('#object-video-list [data-object-video]').forEach(button=>button.setAttribute('aria-pressed',String(Number(button.dataset.objectVideo)===index)));
  objectVideoStatus('Loading '+video.title+'…');
  const current=()=>serial===objectVideoUI.serial&&mapUI.selected===o&&objectVideoUI.object===o;
  try{
    const YT=await loadObjectYouTubeAPI();if(!current())return;
    objectVideoUI.player=new YT.Player('object-youtube-player',{
      host:'https://www.youtube-nocookie.com',width:'100%',height:'220',videoId:video.id,
      playerVars:{origin:location.origin,autoplay:1,playsinline:1,rel:0},
      events:{
        onReady:event=>{
          if(!current()){event.target.destroy();return;}
          objectVideoUI.ready=true;const frame=event.target.getIframe();frame.title=video.title;frame.referrerPolicy='strict-origin-when-cross-origin';
          objectVideoStatus(video.title+' · '+video.channel);event.target.playVideo();
        },
        onStateChange:event=>{
          // Pausing narration must not invalidate a ready video's later play events.
          if(objectVideoUI.player!==event.target||mapUI.selected!==o)return;
          if(event.data===1){pauseNarrationForVideo();$('#object-video')?.pause();objectVideoStatus('Playing · '+video.title);}
          if(event.data===2)objectVideoStatus('Paused · '+video.title);
          if(event.data===0)objectVideoStatus('Finished · choose another video below.');
        },
        onAutoplayBlocked:()=>{if(current())objectVideoStatus('Press play in the video to watch '+video.title+'.');},
        onError:event=>{if(objectVideoUI.player===event.target&&mapUI.selected===o)objectVideoStatus('This video cannot play here (YouTube '+event.data+'). Use Watch on YouTube, or choose another video.');}
      }
    });
  }catch(error){if(current())objectVideoStatus(error.message);}
}
