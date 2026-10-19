'use strict';
function tourStoryNeeded(route,index){
  const stop=route.stops[index],media=route.media?.[index];
  if(stop?.guide||media?.kind==='notebook')return false;
  if(media?.tour_story)return media.tour_story.survey!==tourSkySurvey();
  return !media?.narration?.trim();
}
async function prepareTourStory(route,index,retry=false){
  return jsonPost('/api/navigation/stories',{stop:{...route.stops[index],survey:tourSkySurvey()},retry});
}
function tourStoryMarkup(media){
  const story=media?.tour_story;if(!story?.story?.paragraphs)return `<p>${esc(media?.description||'')}</p>`;
  const sources=story.sources||[];
  return story.story.paragraphs.map(p=>`<p>${esc(p.text)} ${p.source_urls.map(url=>{const i=sources.findIndex(s=>s.url===url);return i>=0&&/^https:\/\//i.test(url)?`<a href="${esc(url)}" target="_blank" rel="noopener noreferrer" title="${esc(sources[i].title)}" aria-label="Source ${i+1}: ${esc(sources[i].title)}">[${i+1}]</a>`:'';}).join(' ')}</p>`).join('');
}
function renderTourStory(media){
  if(!media?.tour_story)return;
  if(media.tour_story.survey!==tourSkySurvey()){$('#route-stop-description').textContent='A researched story for this sky survey will be prepared when narration starts.';$('#route-story-sources').innerHTML='';return;}
  $('#route-stop-title').textContent=media.title;
  $('#route-stop-description').innerHTML=tourStoryMarkup(media);
  $('#route-story-sources').innerHTML=storySourcesMarkup(media);
}
function applyTourStory(route,index,story){
  const media=route.media[index]||{};
  route.media[index]={...media,title:story.story?.title||route.stops[index].title,narration:story.narration,description:story.narration,
    story_sources:story.sources,tour_story:{...story,survey:story.context?.survey||tourSkySurvey()}};
  renderTourStory(route.media[index]);
}
function refreshTourStoryForSurvey(){
  const p=routePlayer;if(!p.route||p.index<0||p.route.kind==='recording'||!tourStoryNeeded(p.route,p.index))return;
  resetTourNarration();
  $('#route-stop-description').textContent='A researched story for this sky survey will be prepared when narration starts.';
  $('#route-story-sources').innerHTML='';
  if(p.playing&&narrationEnabled())void startTourNarration();
}
