import * as THREE from '/vendor/three/three.module.js';
import {OrbitControls} from '/vendor/three/OrbitControls.js';
import {GLTFLoader} from '/vendor/three/GLTFLoader.js';

const TERMINAL = new Set(['complete', 'failed', 'cancelled']);
const MAX_POLLS = 360;
const imageKey = image => /^[a-f0-9]{32}$/.test(image?.id || '') ? image.id : null;
const enhancedSource = image => image?.cloud_ai || image?.ai || null;
const sourceLabel = asset => {
  const variant = asset.source?.variant || '';
  return variant === 'original' || variant.startsWith('fits-display-') ? 'Original source' : variant ? 'Enhanced source' : 'Source image';
};

async function requestJSON(url, options = {}) {
  const response = await fetch(url, {...options, signal: AbortSignal.timeout(25000)});
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = data.detail;
    const error = new Error(typeof detail === 'string' ? detail : data.error || 'The local 3D service could not complete this request.');
    error.status = response.status;
    throw error;
  }
  return data;
}

// Poll only the visible image. A late job response can never replace another image.
export class Image3DJobSession {
  constructor({request = requestJSON, schedule = (callback, delay) => setTimeout(callback, delay), cancel = id => clearTimeout(id), notify = () => {}} = {}) {
    Object.assign(this, {request, schedule, cancel, notify});
    this.jobs = new Map(); this.imageId = null; this.visible = false; this.generation = 0; this.timer = null;
  }
  setContext(imageId, visible) {
    this.generation++; this.cancel(this.timer); this.timer = null;
    this.imageId = imageId; this.visible = visible;
    const entry = this.jobs.get(imageId);
    if (entry && visible) {
      this.notify(entry.polls >= MAX_POLLS && !TERMINAL.has(entry.job.state) ? {...entry.job, paused: true, progress: 'Automatic checking is paused. Check progress to reconnect to this local job.'} : entry.job);
      if (!TERMINAL.has(entry.job.state) && entry.polls < MAX_POLLS) this.poll(entry, this.generation);
    }
  }
  current(entry, generation) { return this.visible && this.imageId === entry.imageId && this.generation === generation; }
  running(imageId = this.imageId) { const state = this.jobs.get(imageId)?.job.state; return state && !TERMINAL.has(state); }
  async start(payload) {
    const imageId = payload.image_id;
    if (this.running(imageId)) return;
    const entry = {imageId, polls: 0, failures: 0, job: {state: 'queued', progress: 'Sending to the local processor…'}};
    this.jobs.set(imageId, entry);
    const generation = this.generation;
    if (this.current(entry, generation)) this.notify(entry.job);
    try {
      entry.job = await this.request('/api/image-3d/jobs', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(payload)});
      if (this.current(entry, this.generation)) {
        this.notify(entry.job);
        if (!TERMINAL.has(entry.job.state)) this.poll(entry, this.generation);
      }
    } catch (error) {
      entry.job = {state: 'failed', error: error.message};
      if (this.current(entry, this.generation)) this.notify(entry.job);
    }
  }
  async poll(entry, generation) {
    if (!this.current(entry, generation) || !entry.job.id || TERMINAL.has(entry.job.state)) return;
    if (entry.polls++ >= MAX_POLLS) {
      this.notify({...entry.job, paused: true, progress: 'Automatic checking paused after 30 minutes. Check progress to reconnect; the local job can continue.'});
      return;
    }
    try {
      const job = await this.request('/api/image-3d/jobs/' + encodeURIComponent(entry.job.id));
      if (!this.current(entry, generation)) return;
      entry.job = job; entry.failures = 0;
      this.notify(job);
      if (TERMINAL.has(job.state)) return;
    } catch (error) {
      if (!this.current(entry, generation)) return;
      if (error.status === 404) {
        entry.job = {...entry.job, state: 'failed', error: 'This job is no longer available. Check saved models or create it again.'};
        this.notify(entry.job); return;
      }
      entry.failures++;
      this.notify({...entry.job, paused: entry.failures >= 3, progress: entry.failures >= 3 ? 'Connection interrupted. Check progress to reconnect to the local job.' : 'Reconnecting to the local processor…'});
      if (entry.failures >= 3) return;
    }
    this.timer = this.schedule(() => this.poll(entry, generation), 5000);
  }
  resume() {
    const entry = this.jobs.get(this.imageId);
    if (entry) { entry.polls = 0; entry.failures = 0; }
    this.setContext(this.imageId, this.visible);
  }
  async cancelJob() {
    const entry = this.jobs.get(this.imageId);
    if (!entry?.job.id || TERMINAL.has(entry.job.state) || entry.cancelling) return;
    entry.cancelling = true; this.generation++; this.cancel(this.timer); this.timer = null;
    this.notify({...entry.job, cancelling: true, progress: 'Stopping generation…'});
    try {
      entry.job = await this.request('/api/image-3d/jobs/' + encodeURIComponent(entry.job.id) + '/cancel', {method: 'POST'});
      if (this.current(entry, this.generation)) this.notify(entry.job);
    } catch (error) {
      if (this.current(entry, this.generation)) this.notify({...entry.job, paused: true, progress: error.message + ' Check progress to reconnect.'});
    } finally { entry.cancelling = false; }
  }
}

export function disposeModel(root) {
  const geometries = new Set(), materials = new Set(), textures = new Set();
  root?.traverse(object => {
    if (object.geometry) geometries.add(object.geometry);
    for (const material of [].concat(object.material || [])) {
      materials.add(material);
      for (const value of Object.values(material)) if (value?.isTexture) textures.add(value);
    }
    object.skeleton?.dispose?.();
  });
  textures.forEach(texture => texture.dispose()); materials.forEach(material => material.dispose()); geometries.forEach(geometry => geometry.dispose());
}

function safeURL(value) {
  if (!value) return null;
  try { const url = new URL(value, location.href); return url.origin === location.origin && /^https?:$/.test(url.protocol) ? url.href : null; } catch { return null; }
}

class Image3DWorkspace {
  constructor() {
    this.image = null; this.visible = false; this.generation = 0; this.loadGeneration = 0; this.historyGeneration = 0;
    this.status = null; this.asset = null; this.model = null; this.renderer = null; this.autoRotate = false;
    this.jobs = new Image3DJobSession({notify: job => this.updateJob(job)});
    this.build();
    document.addEventListener('visibilitychange', () => {
      this.jobs.setContext(imageKey(this.image), this.visible && !document.hidden);
      if (document.hidden) this.stopRendering(); else if (this.visible) this.startRendering();
    });
  }
  el(selector) { return this.dialog.querySelector(selector); }
  build() {
    this.dialog = document.createElement('dialog');
    this.dialog.id = 'image-3d-workspace'; this.dialog.className = 'image-3d-workspace';
    this.dialog.setAttribute('aria-labelledby', 'image-3d-title');
    this.dialog.innerHTML = `
      <header class="image-3d-header"><div><span class="overline">IMAGE LAB / LOCAL 3D STUDIO</span><h2 id="image-3d-title">A new dimension.</h2></div><button class="icon-button" type="button" data-3d="close" aria-label="Close 3D studio">×</button></header>
      <div class="image-3d-layout">
        <section class="image-3d-viewport" aria-label="Interactive 3D preview">
          <div class="image-3d-canvas" data-3d="canvas"></div>
          <div class="image-3d-view-label"><span class="image-3d-dot"></span><span data-3d="view-title">Your image, with perspective</span></div>
          <div class="image-3d-empty" data-3d="empty"><div class="image-3d-orbit" aria-hidden="true"><span>✦</span></div><h3>Give your image some depth.</h3><p>Build a layered astronomy scene or generate a textured model with TRELLIS.2.</p><span>Everything is processed on this PC.</span></div>
          <div class="image-3d-loading" data-3d="loading" role="status" hidden>Opening your 3D model…</div>
          <div class="image-3d-view-tools" data-3d="view-tools" hidden><button type="button" class="button" data-3d="reset">Reset view</button><button type="button" class="button" data-3d="rotate" aria-pressed="false">Auto-rotate</button><span>Drag to orbit · Scroll to zoom · Right-drag to pan</span></div>
          <div class="image-3d-interpretation">INTERPRETED 3D <span>Depth is illustrative, not measured.</span></div>
        </section>
        <aside class="image-3d-settings" aria-label="3D creation controls">
          <section class="image-3d-source"><img data-3d="thumbnail" alt="Source image for the 3D model"><div><span class="overline">SOURCE IMAGE</span><strong data-3d="image-name"></strong><small data-3d="image-size"></small></div></section>
          <label class="image-3d-label">Build from<select data-3d="source" aria-label="3D source image"><option value="original">Original image</option></select></label>
          <p class="image-3d-hint">To include display color adjustments, save an adjusted copy in Image Lab first.</p>
          <fieldset class="image-3d-modes"><legend>Choose your approach</legend>
            <label class="image-3d-mode"><input type="radio" name="image-3d-mode" value="astronomy" checked><span><strong>Astronomy scene <small>FAST · LOCAL</small></strong><span>Image-textured relief and star layers. Explore the photograph with gentle parallax.</span></span></label>
            <label class="image-3d-mode"><input type="radio" name="image-3d-mode" value="trellis"><span><strong>TRELLIS.2 model <small>GENERATIVE · GPU</small></strong><span>Generate a textured 3D object. Best with a distinct subject; nebula and galaxy results can vary.</span></span></label>
          </fieldset>
          <div class="image-3d-scene-options" data-3d="scene-options"><label class="image-3d-label image-3d-range-label">Depth strength<output data-3d="depth-value">35%</output><input data-3d="depth" type="range" min="0" max="1" step="0.05" value="0.35" aria-label="Scene depth strength"></label><div class="image-3d-range-captions"><span>Subtle</span><span>Pronounced</span></div></div>
          <div data-3d="trellis-options" hidden><div class="image-3d-option-row"><label class="image-3d-label">Model resolution<select data-3d="resolution" aria-label="TRELLIS model resolution"><option value="512">512 · faster</option><option value="1024">1024 · more detail</option></select></label><label class="image-3d-label">Seed<input data-3d="seed" aria-label="TRELLIS seed" type="number" min="0" max="2147483647" step="1" value="42"></label></div><p class="image-3d-hint">Generates unseen geometry. This can take several minutes.</p></div>
          <div class="image-3d-processor" data-3d="processor" role="status">Checking local processors…</div>
          <button type="button" class="button primary image-3d-create" data-3d="create">Create astronomy scene <span>↗</span></button>
          <div class="image-3d-job" data-3d="job" role="status" aria-live="polite" hidden><div data-3d="job-state"></div><p data-3d="job-message"></p><button class="text-button" type="button" data-3d="check" hidden>Check progress</button><button class="text-button" type="button" data-3d="cancel" hidden>Cancel generation</button></div>
          <section class="image-3d-export" data-3d="export" hidden><span class="overline">YOUR MODEL</span><p data-3d="model-stats"></p><a class="button" data-3d="download" download>Download GLB ↗</a><a class="text-button" data-3d="provenance" download>Download provenance</a></section>
          <section class="image-3d-saved"><div><span class="overline">SAVED FOR THIS IMAGE</span><button type="button" class="text-button" data-3d="refresh">Refresh</button></div><div data-3d="saved-list"><p class="image-3d-hint">Your models will appear here.</p></div></section>
        </aside>
      </div>`;
    document.body.append(this.dialog);
    this.el('[data-3d="close"]').onclick = () => this.close();
    this.dialog.addEventListener('cancel', event => { event.preventDefault(); this.close(); });
    this.dialog.addEventListener('close', () => { if (this.visible) this.close(); });
    this.dialog.querySelectorAll('[name="image-3d-mode"]').forEach(input => input.onchange = () => this.renderControls());
    this.el('[data-3d="depth"]').oninput = event => { this.el('[data-3d="depth-value"]').textContent = Math.round(event.target.value * 100) + '%'; };
    this.el('[data-3d="source"]').onchange = () => this.updateThumbnail();
    this.el('[data-3d="create"]').onclick = () => this.create();
    this.el('[data-3d="reset"]').onclick = () => this.resetView();
    this.el('[data-3d="rotate"]').onclick = () => { this.autoRotate = !this.autoRotate; if (!this.autoRotate && this.model) this.model.rotation.y = 0; this.el('[data-3d="rotate"]').setAttribute('aria-pressed', String(this.autoRotate)); };
    this.el('[data-3d="refresh"]').onclick = () => { this.refreshStatus(); this.refreshHistory(); this.jobs.resume(); };
    this.el('[data-3d="check"]').onclick = () => this.jobs.resume();
    this.el('[data-3d="cancel"]').onclick = () => this.jobs.cancelJob();
  }
  mode() { return this.el('[name="image-3d-mode"]:checked').value; }
  bind(image) {
    const changed = imageKey(image) !== imageKey(this.image);
    this.image = image;
    if (changed) {
      this.generation++; this.historyGeneration++; this.asset = null; this.finishedJob = null; this.disposeViewer();
      this.el('[data-3d="job"]').hidden = true; this.el('[data-3d="export"]').hidden = true;
      this.el('[data-3d="saved-list"]').replaceChildren();
      this.el('[data-3d="view-title"]').textContent = 'Your image, with perspective';
      this.el('[data-3d="empty"]').hidden = false;
    }
    this.el('[data-3d="image-name"]').textContent = image?.name || 'Open an image in Image Lab';
    this.el('[data-3d="image-size"]').textContent = image ? `${image.width} × ${image.height} pixels` : '';
    const source = this.el('[data-3d="source"]'), previous = source.value;
    source.replaceChildren(new Option('Original image', 'original'));
    if (enhancedSource(image)) source.add(new Option('Latest enhanced image' + (enhancedSource(image).provider ? ' · ' + enhancedSource(image).provider : ''), 'enhanced'));
    source.value = !changed && previous === 'enhanced' && enhancedSource(image) ? 'enhanced' : 'original';
    this.updateThumbnail(); this.renderControls();
    this.jobs.setContext(imageKey(image), this.visible && !document.hidden);
    if (this.visible) { this.refreshHistory(); if (this.asset && !this.renderer) this.loadAsset(this.asset); }
  }
  updateThumbnail() {
    const enhanced = this.el('[data-3d="source"]').value === 'enhanced';
    const source = enhancedSource(this.image);
    let url = safeURL(enhanced ? source?.url || source?.preview_url || this.image?.ai_url : this.image?.preview_url);
    if (url && !enhanced && this.image?.scientific) { const preview = new URL(url); preview.searchParams.set('stretch', this.image.display_stretch || 'asinh'); url = preview.href; }
    const thumbnail = this.el('[data-3d="thumbnail"]');
    if (url) { thumbnail.src = url; thumbnail.hidden = false; } else { thumbnail.removeAttribute('src'); thumbnail.hidden = true; }
    thumbnail.alt = enhanced ? 'Latest enhanced source image' : 'Original source image';
  }
  open() {
    if (this.visible) return;
    this.visible = true; this.generation++; this.previousFocus = document.activeElement;
    this.dialog.showModal(); this.el('[data-3d="close"]').focus();
    this.jobs.setContext(imageKey(this.image), !document.hidden);
    this.refreshStatus(); this.refreshHistory(); this.renderControls();
    if (this.asset && !this.renderer) this.loadAsset(this.asset);
  }
  close() {
    if (!this.visible) return;
    this.visible = false; this.generation++; this.historyGeneration++;
    this.jobs.setContext(imageKey(this.image), false); this.disposeViewer();
    if (this.dialog.open) this.dialog.close();
    if (this.previousFocus?.isConnected) this.previousFocus.focus();
  }
  async refreshStatus() {
    const generation = this.generation;
    try {
      const status = await requestJSON('/api/image-3d/status');
      if (generation !== this.generation || !this.visible) return;
      this.status = status;
    } catch (error) { if (generation === this.generation) this.status = {error: error.message}; }
    this.renderControls();
  }
  renderControls() {
    const mode = this.mode(), trellis = mode === 'trellis', running = Boolean(this.jobs.running(imageKey(this.image)));
    this.el('[data-3d="scene-options"]').hidden = trellis;
    this.el('[data-3d="trellis-options"]').hidden = !trellis;
    const processor = this.status?.[trellis ? 'trellis' : 'local_scene'];
    const ready = processor?.ready === true;
    this.el('[data-3d="processor"]').textContent = this.status?.error || (!this.status ? 'Checking local processors…' : ready ? (trellis ? 'TRELLIS.2 is ready on this PC.' : 'Ready · local processing on this PC') : processor?.message || 'The local processor is not available yet.');
    this.el('[data-3d="processor"]').dataset.ready = String(ready);
    const button = this.el('[data-3d="create"]');
    button.disabled = !ready || !imageKey(this.image) || running;
    button.textContent = running ? 'Creating on this PC…' : trellis ? 'Generate TRELLIS.2 model ↗' : 'Create astronomy scene ↗';
  }
  async create() {
    if (this.el('[data-3d="create"]').disabled) return;
    const seedInput = this.el('[data-3d="seed"]');
    if (this.mode() === 'trellis' && !seedInput.reportValidity()) return;
    this.finishedJob = null;
    await this.jobs.start({image_id: imageKey(this.image), mode: this.mode(), source: this.el('[data-3d="source"]').value, stretch: this.image.display_stretch || 'asinh', depth: Number(this.el('[data-3d="depth"]').value), seed: Number(seedInput.value), resolution: Number(this.el('[data-3d="resolution"]').value)});
  }
  updateJob(job) {
    this.el('[data-3d="job"]').hidden = false;
    this.el('[data-3d="job"]').dataset.state = job.state;
    this.el('[data-3d="job-state"]').textContent = job.state === 'complete' ? 'Your 3D model is ready' : job.state === 'failed' ? 'Could not create this model' : job.state === 'cancelled' ? 'Generation cancelled' : job.paused ? 'Progress checking paused' : 'Creating on this PC';
    this.el('[data-3d="job-message"]').textContent = job.error || job.progress || (job.state === 'complete' ? 'Saved locally with its original source and creation settings.' : job.state === 'cancelled' ? 'Generation stopped.' : 'Preparing your image…');
    this.el('[data-3d="check"]').hidden = !job.paused;
    this.el('[data-3d="cancel"]').hidden = !job.id || TERMINAL.has(job.state);
    this.el('[data-3d="cancel"]').disabled = Boolean(job.cancelling);
    this.renderControls();
    if (job.state === 'complete' && job.result && this.finishedJob !== job.id) {
      this.finishedJob = job.id; this.loadAsset(job.result); this.refreshHistory();
    }
  }
  async refreshHistory() {
    const imageId = imageKey(this.image), generation = ++this.historyGeneration;
    if (!imageId || !this.visible) return;
    const list = this.el('[data-3d="saved-list"]');
    try {
      const data = await requestJSON('/api/image-3d/images/' + imageId);
      if (generation !== this.historyGeneration || !this.visible || imageId !== imageKey(this.image)) return;
      list.replaceChildren();
      if (!data.rows?.length) { const text = document.createElement('p'); text.className = 'image-3d-hint'; text.textContent = 'No models yet. Your creations will stay with this image.'; list.append(text); return; }
      for (const asset of data.rows) {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'image-3d-saved-model';
        button.dataset.asset = asset.id; button.setAttribute('aria-pressed', String(this.asset?.id === asset.id));
        const title = document.createElement('strong'); title.textContent = asset.mode === 'trellis' ? 'TRELLIS.2 model' : 'Astronomy scene';
        const details = document.createElement('small');
        const date = new Date(asset.created_at), depth = asset.settings?.depth ?? asset.processing?.depth, resolution = asset.settings?.resolution ?? asset.stats?.resolution;
        const setting = asset.mode === 'trellis' ? (Number.isFinite(resolution) ? `${resolution} resolution` : '') : (Number.isFinite(depth) ? `${Math.round(depth * 100)}% depth` : '');
        details.textContent = [setting, sourceLabel(asset), Number.isNaN(date.valueOf()) ? '' : date.toLocaleString([], {dateStyle: 'medium', timeStyle: 'short'})].filter(Boolean).join(' · ');
        button.append(title, details); button.onclick = () => this.loadAsset(asset); list.append(button);
      }
    } catch (error) { if (generation === this.historyGeneration) { list.replaceChildren(); const text = document.createElement('p'); text.className = 'image-3d-hint'; text.textContent = error.message; list.append(text); } }
  }
  initViewer() {
    if (this.renderer) return;
    const container = this.el('[data-3d="canvas"]');
    this.renderer = new THREE.WebGLRenderer({antialias: true, alpha: false});
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace; this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.setClearColor(0x070e15, 1);
    this.renderer.domElement.setAttribute('aria-label', '3D model. Drag to orbit, scroll to zoom, right-drag to pan.');
    this.renderer.domElement.setAttribute('tabindex', '0');
    container.replaceChildren(this.renderer.domElement);
    this.scene = new THREE.Scene(); this.camera = new THREE.PerspectiveCamera(40, 1, 0.01, 100);
    this.scene.add(new THREE.AmbientLight(0xffffff, 2));
    const keyLight = new THREE.DirectionalLight(0xffffff, 2.5); keyLight.position.set(3, 4, 6); this.scene.add(keyLight);
    const fill = new THREE.DirectionalLight(0x99d5ed, 1); fill.position.set(-3, 1, -2); this.scene.add(fill);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true; this.controls.dampingFactor = 0.08; this.controls.autoRotateSpeed = 0.6;
    this.controls.listenToKeyEvents(this.renderer.domElement);
    this.resizeObserver = new ResizeObserver(() => this.resize()); this.resizeObserver.observe(container);
    this.resize(); this.startRendering();
  }
  resize() {
    if (!this.renderer) return;
    const bounds = this.el('[data-3d="canvas"]').getBoundingClientRect();
    if (bounds.width < 1 || bounds.height < 1) return;
    this.renderer.setSize(bounds.width, bounds.height, false); this.camera.aspect = bounds.width / bounds.height; this.camera.updateProjectionMatrix();
  }
  resetView() {
    if (!this.camera || !this.controls) return;
    if (this.model) this.model.rotation.y = 0;
    const astronomy = this.asset?.mode !== 'trellis';
    if (astronomy) this.camera.fov = 40;
    const radius = astronomy ? 1.4 : this.modelRadius || 1;
    // The scene generator projects its image and star layers from this exact camera.
    const distance = astronomy ? 3.4 : radius / Math.sin(THREE.MathUtils.degToRad(this.camera.fov / 2)) * 1.15;
    const portrait = Math.max(1, 1 / this.camera.aspect);
    this.camera.position.set(0, 0, distance * portrait); this.camera.near = Math.max(0.001, radius / 100); this.camera.far = Math.max(100, distance * 30); this.camera.updateProjectionMatrix();
    this.controls.target.set(0, 0, 0); this.controls.minDistance = radius * 0.25; this.controls.maxDistance = distance * 6;
    const limit = THREE.MathUtils.degToRad(65);
    this.controls.minAzimuthAngle = astronomy ? -limit : -Infinity; this.controls.maxAzimuthAngle = astronomy ? limit : Infinity;
    this.controls.minPolarAngle = astronomy ? Math.PI / 2 - limit : 0.01; this.controls.maxPolarAngle = astronomy ? Math.PI / 2 + limit : Math.PI - 0.01;
    this.controls.update();
  }
  startRendering() {
    if (!this.renderer || this.frame || !this.visible || document.hidden) return;
    let previous = 0;
    const render = time => {
      if (!this.visible || document.hidden || !this.renderer) { this.frame = null; return; }
      const delta = previous ? Math.min(0.05, (time - previous) / 1000) : 0; previous = time;
      // A slow sway keeps an image relief facing the viewer while still revealing its depth.
      if (this.autoRotate && this.asset?.mode !== 'trellis' && this.model) this.model.rotation.y = Math.sin(time / 6500) * 0.22;
      this.controls.autoRotate = this.autoRotate && this.asset?.mode === 'trellis';
      this.controls.update(delta); this.renderer.render(this.scene, this.camera);
      this.frame = requestAnimationFrame(render);
    };
    this.frame = requestAnimationFrame(render);
  }
  stopRendering() { cancelAnimationFrame(this.frame); this.frame = null; }
  async loadAsset(asset) {
    if (!this.visible || asset.image_id !== imageKey(this.image)) return;
    const url = safeURL(asset.model_url);
    if (!url) { this.el('[data-3d="loading"]').hidden = false; this.el('[data-3d="loading"]').textContent = 'This model has no valid local file URL.'; return; }
    const generation = ++this.loadGeneration;
    this.asset = asset; this.el('[data-3d="loading"]').hidden = false; this.el('[data-3d="loading"]').textContent = 'Opening your 3D model…';
    this.el('[data-3d="empty"]').hidden = true;
    try {
      this.initViewer();
      const gltf = await new GLTFLoader().loadAsync(url);
      if (generation !== this.loadGeneration || !this.visible || asset.image_id !== imageKey(this.image)) { disposeModel(gltf.scene); return; }
      if (this.model) { this.scene.remove(this.model); disposeModel(this.model); }
      this.model = gltf.scene;
      const bounds = new THREE.Box3().setFromObject(this.model), center = bounds.getCenter(new THREE.Vector3()), size = bounds.getSize(new THREE.Vector3());
      if (asset.mode === 'trellis') this.model.position.sub(center);
      this.modelRadius = Math.max(size.length() / 2, 0.01); this.scene.add(this.model);
      this.resetView(); this.el('[data-3d="loading"]').hidden = true;
      this.el('[data-3d="view-tools"]').hidden = false;
      this.el('[data-3d="view-title"]').textContent = asset.mode === 'trellis' ? 'TRELLIS.2 · generated geometry' : 'Astronomy scene · image relief & star layers';
      this.el('[data-3d="export"]').hidden = false;
      this.el('[data-3d="download"]').href = url;
      const manifestURL = safeURL(asset.manifest_url); this.el('[data-3d="provenance"]').hidden = !manifestURL;
      if (manifestURL) this.el('[data-3d="provenance"]').href = manifestURL;
      const stats = asset.stats || {}, faces = stats.triangles ?? stats.faces;
      this.el('[data-3d="model-stats"]').textContent = [asset.mode === 'trellis' ? 'Textured 3D model' : 'Layered image relief', Number.isFinite(faces) ? Number(faces).toLocaleString() + ' triangles' : '', 'GLB · opens in Blender'].filter(Boolean).join(' · ');
      this.el('[data-3d="saved-list"]').querySelectorAll('[data-asset]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.asset === asset.id)));
    } catch (error) {
      if (generation !== this.loadGeneration || !this.visible) return;
      this.el('[data-3d="loading"]').textContent = 'The 3D preview could not open: ' + error.message;
      this.el('[data-3d="export"]').hidden = false; this.el('[data-3d="download"]').href = url;
      const manifestURL = safeURL(asset.manifest_url); this.el('[data-3d="provenance"]').hidden = !manifestURL; if (manifestURL) this.el('[data-3d="provenance"]').href = manifestURL;
    }
  }
  disposeViewer() {
    this.loadGeneration++; this.stopRendering(); this.resizeObserver?.disconnect(); this.resizeObserver = null;
    this.controls?.dispose(); this.controls = null; disposeModel(this.model); this.model = null; this.scene = null;
    this.renderer?.dispose(); this.renderer?.forceContextLoss(); this.renderer?.domElement.remove(); this.renderer = null;
    this.el('[data-3d="view-tools"]').hidden = true; this.el('[data-3d="loading"]').hidden = true;
  }
}

let workspace;
let pendingImage = null;
const boot = () => { if (!workspace) { workspace = new Image3DWorkspace(); if (pendingImage) workspace.bind(pendingImage); } };
window.ImageLab3D = {
  bind(image) { pendingImage = image; workspace?.bind(image); },
  open() { boot(); workspace.open(); },
  close() { workspace?.close(); },
};
window.addEventListener('universe:image-opened', event => window.ImageLab3D.bind(event.detail?.image));
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, {once: true}); else boot();
