'use strict';

const filmstripRowsEl = document.getElementById('filmstrip-rows');
const montageCardsEl = document.getElementById('montage-cards');
const dctCardsEl = document.getElementById('dct-cards');
const hashCardsEl = document.getElementById('hash-cards');
const comparisonSection = document.getElementById('comparison-section');
const comparisonTable = document.getElementById('comparison-table');

const filmstripRowTemplate = document.getElementById('filmstrip-row-template');
const montageCardTemplate = document.getElementById('montage-card-template');
const dctCardTemplate = document.getElementById('dct-card-template');
const hashCardTemplate = document.getElementById('hash-card-template');

const modalOverlay = document.getElementById('modal-overlay');
const modalTitle = modalOverlay.querySelector('.modal-title');
const modalBody = modalOverlay.querySelector('.modal-body');
modalOverlay.querySelector('.modal-close').addEventListener('click', closeModal);
modalOverlay.addEventListener('click', (e) => { if (e.target === modalOverlay) closeModal(); });

let activeModalKeydown = null;
let activeModalOnClose = null;

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { closeModal(); return; }
  if (modalOverlay.hidden) return;
  if (activeModalKeydown) activeModalKeydown(e);
});

// ---------------------------------------------------------------------------
// Advanced / beginner mode toggle
// ---------------------------------------------------------------------------

function isAdvanced() {
  return document.body.classList.contains('advanced-mode');
}

(function initAdvancedMode() {
  const toggle = document.getElementById('advanced-mode-toggle');
  if (!toggle) return;
  if (localStorage.getItem('phash-advanced-mode') === 'true') {
    document.body.classList.add('advanced-mode');
    toggle.checked = true;
  }
  toggle.addEventListener('change', () => {
    document.body.classList.toggle('advanced-mode', toggle.checked);
    localStorage.setItem('phash-advanced-mode', String(toggle.checked));
  });
}());

/**
 * options.onKeydown(event) -- called for every keydown while this modal is
 *   open (Escape/closing is handled separately and always works).
 * options.onClose() -- called once, right before the modal body is cleared,
 *   for any cleanup (nothing currently needs it, but keeping the hook keeps
 *   future modals from having to re-invent teardown).
 */
function openModal(title, bodyNode, { onKeydown, onClose } = {}) {
  modalTitle.textContent = title;
  modalBody.innerHTML = '';
  modalBody.appendChild(bodyNode);
  modalOverlay.hidden = false;
  activeModalKeydown = onKeydown || null;
  activeModalOnClose = onClose || null;
}
function closeModal() {
  if (modalOverlay.hidden) return;
  if (activeModalOnClose) activeModalOnClose();
  modalOverlay.hidden = true;
  modalBody.innerHTML = '';
  activeModalKeydown = null;
  activeModalOnClose = null;
}

// jobId -> { name, timestamps: [], frameCanvases: [HTMLCanvasElement...],
//            cleanMontageCanvas, dct, bits, median, hex, int64 }
const jobs = new Map();
// All live `.filmstrip` elements, kept in sync so scrolling any one of
// them scrolls the rest to the same position.
const syncedFilmstrips = new Set();
let syncingScroll = false;

let jobCounter = 0;

document.getElementById('add-videos').addEventListener('click', async () => {
  const paths = await window.phashAPI.chooseVideos();
  for (const p of paths) addVideo(p);
});

function baseName(p) {
  return p.split(/[\\/]/).pop();
}

function drawRGBAToCanvas(canvas, width, height, data) {
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  const imageData = new ImageData(new Uint8ClampedArray(data), width, height);
  ctx.putImageData(imageData, 0, 0);
  return ctx;
}

/** Clones a canvas's pixel content into a fresh canvas (for use inside modals). */
function cloneCanvas(source) {
  const c = document.createElement('canvas');
  c.width = source.width;
  c.height = source.height;
  c.getContext('2d').drawImage(source, 0, 0);
  return c;
}

function registerFilmstripSync(filmstripEl) {
  syncedFilmstrips.add(filmstripEl);
  filmstripEl.addEventListener('scroll', () => {
    if (syncingScroll) return;
    syncingScroll = true;
    for (const other of syncedFilmstrips) {
      if (other !== filmstripEl) other.scrollLeft = filmstripEl.scrollLeft;
    }
    syncingScroll = false;
  });
}

function addVideo(videoPath) {
  const jobId = `job-${++jobCounter}`;
  const name = baseName(videoPath);

  const job = {
    name, timestamps: [], frameCanvases: [],
    cleanMontageCanvas: document.createElement('canvas'),
    dct: null, gray: null, bits: null, median: null, hex: null, int64: null,
  };
  jobs.set(jobId, job);

  // --- Stage 1: filmstrip row ---
  const rowNode = filmstripRowTemplate.content.cloneNode(true);
  const row = rowNode.querySelector('.filmstrip-row');
  row.querySelector('.video-name').textContent = name;
  const statusEl = row.querySelector('.status');
  const filmstrip = row.querySelector('.filmstrip');
  filmstripRowsEl.appendChild(row);
  registerFilmstripSync(filmstrip);

  // --- Stage 2: montage card ---
  const montageNode = montageCardTemplate.content.cloneNode(true);
  const montageCard = montageNode.querySelector('.montage-card');
  montageCard.querySelector('.video-name').textContent = name;
  const montageCanvas = montageCard.querySelector('.montage-canvas');
  const saveMontageBtn = montageCard.querySelector('.save-montage');
  montageCardsEl.appendChild(montageCard);
  montageCanvas.addEventListener('click', () => openMontageComparisonModal(jobId));

  // --- Stage 3: DCT card ---
  const dctNode = dctCardTemplate.content.cloneNode(true);
  const dctCard = dctNode.querySelector('.dct-card');
  dctCard.querySelector('.video-name').textContent = name;
  const dctCanvas = dctCard.querySelector('.dct-canvas');
  dctCardsEl.appendChild(dctCard);
  dctCanvas.addEventListener('click', () => openDctDiffModal(jobId));

  // --- Stage 4: hash card ---
  const hashNode = hashCardTemplate.content.cloneNode(true);
  const hashCard = hashNode.querySelector('.hash-card');
  hashCard.querySelector('.video-name').textContent = name;
  const hexEl = hashCard.querySelector('.hash-hex');
  const int64El = hashCard.querySelector('.hash-int64');
  const goldenInput = hashCard.querySelector('.golden-input');
  const goldenResult = hashCard.querySelector('.golden-result');
  hashCardsEl.appendChild(hashCard);

  statusEl.textContent = 'Probing duration…';

  const unsubscribe = window.phashAPI.onProgress(jobId, ({ stage, payload }) => {
    if (stage === 'duration') {
      statusEl.textContent = `Duration: ${payload.duration.toFixed(3)}s — extracting frames…`;
    }

    if (stage === 'frame') {
      statusEl.textContent = `Extracting frame ${payload.index + 1} / ${payload.total}…`;
      job.timestamps[payload.index] = payload.timeSeconds;

      const fig = document.createElement('figure');
      const canvas = document.createElement('canvas');
      // The high-resolution preview frame, same timestamp as the 160px
      // hash frame but extracted separately at a larger width -- this
      // canvas is what both the filmstrip thumbnail AND the zoom modal
      // read from, so "zooming in" is just displaying it larger, not a
      // re-extraction.
      drawRGBAToCanvas(canvas, payload.previewWidth, payload.previewHeight, payload.previewData);
      job.frameCanvases[payload.index] = canvas;

      const caption = document.createElement('figcaption');
      caption.textContent = `#${payload.index + 1} · ${payload.timeSeconds.toFixed(2)}s`;
      fig.appendChild(canvas);
      fig.appendChild(caption);
      fig.addEventListener('click', () => openFrameComparisonModal(payload.index, jobId));
      filmstrip.appendChild(fig);
    }

    if (stage === 'montage') {
      statusEl.textContent = isAdvanced() ? 'Assembling collage…' : 'Building snapshot grid…';
      drawRGBAToCanvas(job.cleanMontageCanvas, payload.width, payload.height, payload.data);
      const ctx = drawRGBAToCanvas(montageCanvas, payload.width, payload.height, payload.data);
      // Overlay grid lines at tile boundaries (display only -- not exported/hashed).
      const tileW = payload.width / 5;
      const tileH = payload.height / 5;
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.lineWidth = 1;
      for (let i = 1; i < 5; i++) {
        ctx.beginPath(); ctx.moveTo(i * tileW, 0); ctx.lineTo(i * tileW, payload.height); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(0, i * tileH); ctx.lineTo(payload.width, i * tileH); ctx.stroke();
      }
    }

    if (stage === 'hash') {
      statusEl.textContent = 'Done.';
      hexEl.textContent = payload.hex;
      int64El.textContent = payload.int64;
      job.dct = payload.dctCoefficients8x8;
      job.gray = payload.resizedGray64x64;
      job.bits = payload.bits;
      job.median = payload.median;
      job.hex = payload.hex;
      job.int64 = payload.int64;
      drawDctHeatmap(dctCanvas, job.dct, job.bits, job.median);
      updateComparisonTable();
      unsubscribe();
    }

    if (stage === 'error') {
      statusEl.textContent = `Error: ${payload.message}`;
      unsubscribe();
    }
  });

  saveMontageBtn.addEventListener('click', () => {
    if (!job.cleanMontageCanvas.width) return; // montage not ready yet
    const a = document.createElement('a');
    a.href = job.cleanMontageCanvas.toDataURL('image/png');
    a.download = `${name.replace(/\.[^.]+$/, '')}-montage.png`;
    a.click();
  });

  goldenInput.addEventListener('change', async () => {
    const raw = goldenInput.value.trim();
    if (!raw) { goldenResult.textContent = ''; return; }
    const known = normalizeToHex(raw);
    if (!job.hex || !known) { goldenResult.textContent = 'invalid input'; return; }
    const distance = await window.phashAPI.hammingDistance(job.hex, known);
    goldenResult.textContent = distance === 0 ? 'exact match ✓' : isAdvanced() ? `Hamming distance: ${distance}` : `${distance} bit${distance === 1 ? '' : 's'} differ`;
    goldenResult.className = `golden-result ${distance === 0 ? 'match' : 'mismatch'}`;
  });

  window.phashAPI.runPipeline(jobId, videoPath).then((res) => {
    if (!res.ok) statusEl.textContent = `Error: ${res.error}`;
  });
}

function normalizeToHex(raw) {
  try {
    if (/^-?\d+$/.test(raw) && !/^[0-9a-f]+$/i.test(raw.replace('-', ''))) {
      return BigInt.asUintN(64, BigInt(raw)).toString(16).padStart(16, '0');
    }
    const cleaned = raw.replace(/^0x/i, '');
    return BigInt.asUintN(64, BigInt('0x' + cleaned)).toString(16).padStart(16, '0');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Reusable draggable before/after comparison slider
// ---------------------------------------------------------------------------
//
// canvasA is drawn on top, clipped to the left `value`% of the container;
// canvasB fills the container underneath. Dragging the handle (or the
// underlying full-size range input, which also gives free keyboard support
// while it's focused) reveals more of one or the other. An optional
// `overlayCanvas` is layered on top of both, unclipped, toggled by CSS
// class rather than removed/re-added so callers can flip it on/off cheaply.
//
// Returns { node, setImages(canvasA, canvasB), setOverlayVisible(bool) } so
// callers can swap in new frames (e.g. on prev/next) without rebuilding the
// whole slider and losing the handle position.
function buildCompareSlider({ canvasA, canvasB, labelA, labelB, overlayCanvas }) {
  const wrap = document.createElement('div');
  wrap.className = 'compare-slider';

  const layerB = document.createElement('div');
  layerB.className = 'compare-slider-layer compare-slider-layer-b';
  const layerA = document.createElement('div');
  layerA.className = 'compare-slider-layer compare-slider-layer-a';
  wrap.appendChild(layerB);
  wrap.appendChild(layerA);

  let layerOverlay = null;
  if (overlayCanvas) {
    layerOverlay = document.createElement('div');
    layerOverlay.className = 'compare-slider-layer compare-slider-layer-overlay';
    overlayCanvas.className = 'compare-slider-canvas';
    layerOverlay.appendChild(overlayCanvas);
    wrap.appendChild(layerOverlay);
  }

  const tagA = document.createElement('div');
  tagA.className = 'compare-slider-tag compare-slider-tag-a';
  const tagB = document.createElement('div');
  tagB.className = 'compare-slider-tag compare-slider-tag-b';
  wrap.appendChild(tagA);
  wrap.appendChild(tagB);

  const handle = document.createElement('div');
  handle.className = 'compare-slider-handle';
  handle.innerHTML = '<span class="compare-slider-grip">&#8596;</span>';
  wrap.appendChild(handle);

  // A full-size, on-top, invisible hit area we drive entirely with pointer
  // events -- an <input type="range"> stretched to fill the image doesn't
  // work here: styling its thumb to cover the whole track (needed to make
  // the whole image draggable, not just a native-sized thumb) leaves the
  // thumb nowhere to actually move to, so clicks warp the value to one end
  // and further drags do nothing. Plain pointer events avoid all of that.
  // Deliberately not focusable/keyboard-driven: this modal's ← / → keys are
  // reserved for prev/next frame navigation, so the slider itself only
  // responds to pointer drag/click to avoid the two fighting over focus.
  const hit = document.createElement('div');
  hit.className = 'compare-slider-hit';
  wrap.appendChild(hit);

  let value = 50;

  function applyValue() {
    layerA.style.clipPath = `inset(0 ${100 - value}% 0 0)`;
    handle.style.left = `${value}%`;
  }

  function setValue(v) {
    value = Math.min(100, Math.max(0, v));
    applyValue();
  }

  function valueFromClientX(clientX) {
    const rect = wrap.getBoundingClientRect();
    if (rect.width === 0) return value;
    return ((clientX - rect.left) / rect.width) * 100;
  }

  let dragging = false;
  function onWindowPointerMove(e) { if (dragging) setValue(valueFromClientX(e.clientX)); }
  function onWindowPointerUp(e) { endDrag(e); }

  hit.addEventListener('pointerdown', (e) => {
    dragging = true;
    setValue(valueFromClientX(e.clientX));
    try { hit.setPointerCapture(e.pointerId); } catch { /* not all pointer types support capture; window fallback below covers it */ }
    // Fallback for when pointer capture isn't honored (or fails, per above):
    // also track movement/release on the window while dragging, so a fast
    // drag that leaves the hit area's bounds doesn't get stuck forever.
    // Scoped to the drag itself (added here, removed in endDrag) so repeated
    // modal opens don't pile up window-level listeners.
    window.addEventListener('pointermove', onWindowPointerMove);
    window.addEventListener('pointerup', onWindowPointerUp);
    e.preventDefault();
  });
  hit.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    setValue(valueFromClientX(e.clientX));
  });
  function endDrag(e) {
    if (!dragging) return;
    dragging = false;
    try { if (hit.hasPointerCapture(e.pointerId)) hit.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    window.removeEventListener('pointermove', onWindowPointerMove);
    window.removeEventListener('pointerup', onWindowPointerUp);
  }
  hit.addEventListener('pointerup', endDrag);
  hit.addEventListener('pointercancel', endDrag);

  function setImages(newCanvasA, newCanvasB, newLabelA, newLabelB) {
    newCanvasA.className = 'compare-slider-canvas';
    newCanvasB.className = 'compare-slider-canvas';
    layerA.innerHTML = '';
    layerB.innerHTML = '';
    layerA.appendChild(newCanvasA);
    layerB.appendChild(newCanvasB);
    wrap.style.aspectRatio = newCanvasB.width && newCanvasB.height
      ? `${newCanvasB.width} / ${newCanvasB.height}`
      : '1 / 1';
    if (newLabelA != null) tagA.textContent = newLabelA;
    if (newLabelB != null) tagB.textContent = newLabelB;
    applyValue();
  }

  function setOverlayVisible(visible) {
    if (layerOverlay) layerOverlay.classList.toggle('is-visible', visible);
  }

  setImages(canvasA, canvasB, labelA, labelB);

  return { node: wrap, setImages, setOverlayVisible };
}

// ---------------------------------------------------------------------------
// DCT contribution overlay for an individual frame tile.
// The heatmap is computed over the full 64x64 collage downsample and then
// cropped to the sub-region that corresponds to this frame's position in the
// 5x5 grid (each tile = 64/5 = 12.8 pixels wide/tall in the 64x64 space).
// ---------------------------------------------------------------------------

function buildFrameOverlayCanvas(jobA, jobB, frameIndex, outWidth, outHeight) {
  if (!jobA || !jobB || !jobA.dct || !jobB.dct || !jobA.gray || !jobB.gray) return null;

  const diffWeights = {};
  let anyDiff = false;
  for (let i = 0; i < 64; i++) {
    if (jobA.bits[i] !== jobB.bits[i]) {
      diffWeights[i] = Math.abs(jobA.dct[i] - jobB.dct[i]);
      anyDiff = true;
    }
  }
  if (!anyDiff) return null;

  const pixelDiff = new Float64Array(4096);
  for (let i = 0; i < 4096; i++) pixelDiff[i] = jobA.gray[i] - jobB.gray[i];

  const heat = PhashCore.computeDctContributionHeatmap(Object.keys(diffWeights).map(Number), diffWeights, pixelDiff);

  const small = document.createElement('canvas');
  small.width = 64; small.height = 64;
  const sctx = small.getContext('2d');
  const imgData = sctx.createImageData(64, 64);
  for (let i = 0; i < heat.length; i++) {
    const v = heat[i];
    imgData.data[i * 4 + 0] = Math.round(255 * v);
    imgData.data[i * 4 + 1] = 0;
    imgData.data[i * 4 + 2] = Math.round(200 * (1 - v));
    imgData.data[i * 4 + 3] = Math.round(200 + 52 * v);
  }
  sctx.putImageData(imgData, 0, 0);

  // Crop the tile region for this frame index out of the full 64x64 heatmap.
  const tileCol = frameIndex % PhashCore.COLUMNS;
  const tileRow = Math.floor(frameIndex / PhashCore.ROWS);
  const tileSizeF = PhashCore.HASH_RESIZE / PhashCore.COLUMNS; // 12.8px per tile side

  const out = document.createElement('canvas');
  out.width = outWidth; out.height = outHeight;
  const octx = out.getContext('2d');
  octx.imageSmoothingEnabled = true;
  octx.drawImage(small, tileCol * tileSizeF, tileRow * tileSizeF, tileSizeF, tileSizeF, 0, 0, outWidth, outHeight);
  return out;
}

// ---------------------------------------------------------------------------
// Modal: frame comparison (slider between two videos, same sample index,
// with prev/next navigation across sample indices)
// ---------------------------------------------------------------------------

function openFrameComparisonModal(index, originJobId) {
  const jobIds = Array.from(jobs.keys());
  if (jobIds.length === 0) return;
  if (originJobId == null || !jobs.has(originJobId)) originJobId = jobIds[0];
  const otherJobId = jobIds.find((id) => id !== originJobId) || originJobId;

  const wrap = document.createElement('div');

  const controls = document.createElement('div');
  controls.className = 'compare-controls';

  const selA = buildJobSelect(originJobId);
  const selB = buildJobSelect(otherJobId);
  const labelSelA = document.createElement('label');
  labelSelA.textContent = 'Video A';
  labelSelA.appendChild(selA);
  const labelSelB = document.createElement('label');
  labelSelB.textContent = 'Video B';
  labelSelB.appendChild(selB);
  controls.appendChild(labelSelA);
  controls.appendChild(labelSelB);

  const nav = document.createElement('div');
  nav.className = 'compare-nav';
  const prevBtn = document.createElement('button');
  prevBtn.type = 'button';
  prevBtn.textContent = '← Prev';
  const nextBtn = document.createElement('button');
  nextBtn.type = 'button';
  nextBtn.textContent = 'Next →';
  const indexLabel = document.createElement('span');
  indexLabel.className = 'compare-nav-index';
  nav.appendChild(prevBtn);
  nav.appendChild(indexLabel);
  nav.appendChild(nextBtn);
  controls.appendChild(nav);

  const hint = document.createElement('span');
  hint.className = 'compare-keyboard-hint';
  hint.textContent = 'Keyboard: ← / → to change frame, T to toggle overlay, Esc to close';
  controls.appendChild(hint);

  const overlayLabel = document.createElement('label');
  overlayLabel.className = 'compare-overlay-toggle';
  const overlayCheckbox = document.createElement('input');
  overlayCheckbox.type = 'checkbox';
  overlayLabel.appendChild(overlayCheckbox);
  overlayLabel.appendChild(document.createTextNode(isAdvanced() ? ' Overlay DCT diff contribution' : ' Show difference heatmap'));
  controls.appendChild(overlayLabel);

  wrap.appendChild(controls);

  const sliderHost = document.createElement('div');
  wrap.appendChild(sliderHost);

  const legend = document.createElement('p');
  legend.className = 'compare-overlay-legend';
  legend.hidden = true;
  legend.textContent = isAdvanced()
    ? 'Overlay cropped to this frame’s tile in the 64×64 downsample. Warmer/more opaque red = this pixel position both actually differs between the two videos and sits where the DCT frequencies that flipped hash bits are most sensitive. The heatmap is computed for the full collage; only the portion for this tile’s position in the 5×5 grid is shown here.'
    : 'Warmer/more opaque red = this area of the frame contributed most to the fingerprint difference. The overlay is derived from how this tile sits in the full 5×5 snapshot grid.';
  wrap.appendChild(legend);

  // Persistent overlay canvas updated in-place so the slider doesn't need
  // to be rebuilt when navigating frames or switching the video selection.
  const sharedOverlayCanvas = document.createElement('canvas');
  sharedOverlayCanvas.width = 480; sharedOverlayCanvas.height = 270;

  let currentIndex = index;
  let slider = null;

  function totalSamples() {
    const a = jobs.get(selA.value);
    const b = jobs.get(selB.value);
    return Math.max(a ? a.timestamps.length : 0, b ? b.timestamps.length : 0, currentIndex + 1, 1);
  }

  function placeholderCanvas() {
    const c = document.createElement('canvas');
    c.width = 480; c.height = 270;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#10161a';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.fillStyle = '#bfccd6';
    ctx.font = '13px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Not extracted yet', c.width / 2, c.height / 2);
    return c;
  }

  function updateOverlay() {
    const jobA = jobs.get(selA.value);
    const jobB = jobs.get(selB.value);
    const refCanvas = (jobA && jobA.frameCanvases[currentIndex]) || (jobB && jobB.frameCanvases[currentIndex]);
    const w = refCanvas ? refCanvas.width : 480;
    const h = refCanvas ? refCanvas.height : 270;
    const newOverlay = buildFrameOverlayCanvas(jobA, jobB, currentIndex, w, h);
    sharedOverlayCanvas.width = w;
    sharedOverlayCanvas.height = h;
    if (newOverlay) sharedOverlayCanvas.getContext('2d').drawImage(newOverlay, 0, 0);
    const available = !!newOverlay;
    overlayCheckbox.disabled = !available;
    legend.hidden = !available;
    if (slider) slider.setOverlayVisible(overlayCheckbox.checked && available);
  }

  function render() {
    const jobA = jobs.get(selA.value);
    const jobB = jobs.get(selB.value);
    const canvasA = (jobA && jobA.frameCanvases[currentIndex]) ? cloneCanvas(jobA.frameCanvases[currentIndex]) : placeholderCanvas();
    const canvasB = (jobB && jobB.frameCanvases[currentIndex]) ? cloneCanvas(jobB.frameCanvases[currentIndex]) : placeholderCanvas();
    const labelA = jobA ? jobA.name : '—';
    const labelB = jobB ? jobB.name : '—';

    if (!slider) {
      slider = buildCompareSlider({ canvasA, canvasB, labelA, labelB, overlayCanvas: sharedOverlayCanvas });
      sliderHost.appendChild(slider.node);
    } else {
      slider.setImages(canvasA, canvasB, labelA, labelB);
    }

    const total = totalSamples();
    const tA = jobA && jobA.timestamps[currentIndex];
    const tB = jobB && jobB.timestamps[currentIndex];
    const t = tA != null ? tA : tB;
    indexLabel.textContent = t != null
      ? `Frame ${currentIndex + 1} of ${total} · ${t.toFixed(2)}s`
      : `Frame ${currentIndex + 1} of ${total}`;
    prevBtn.disabled = currentIndex <= 0;
    nextBtn.disabled = currentIndex >= total - 1;
    updateOverlay();
  }

  function goTo(newIndex) {
    const total = totalSamples();
    if (newIndex < 0 || newIndex >= total) return;
    currentIndex = newIndex;
    render();
  }

  prevBtn.addEventListener('click', () => goTo(currentIndex - 1));
  nextBtn.addEventListener('click', () => goTo(currentIndex + 1));
  selA.addEventListener('change', render);
  selB.addEventListener('change', render);
  overlayCheckbox.addEventListener('change', () => {
    if (slider) slider.setOverlayVisible(overlayCheckbox.checked && !overlayCheckbox.disabled);
  });
  render();

  openModal(`Frame comparison — frame ${index + 1}`, wrap, {
    onKeydown(e) {
      const tag = document.activeElement && document.activeElement.tagName;
      if (tag === 'SELECT' || tag === 'INPUT') return; // let native controls handle their own keys
      if (e.key === 'ArrowLeft') { e.preventDefault(); goTo(currentIndex - 1); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); goTo(currentIndex + 1); }
      else if (e.key === 't' || e.key === 'T') {
        e.preventDefault();
        if (!overlayCheckbox.disabled) {
          overlayCheckbox.checked = !overlayCheckbox.checked;
          if (slider) slider.setOverlayVisible(overlayCheckbox.checked);
        }
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Modal: collage comparison (slider between two videos' exact hashed
// pixels, with an optional DCT-contribution overlay)
// ---------------------------------------------------------------------------

function openMontageComparisonModal(originJobId) {
  const jobIds = Array.from(jobs.keys());
  if (jobIds.length === 0) return;
  if (originJobId == null || !jobs.has(originJobId)) originJobId = jobIds[0];
  const otherJobId = jobIds.find((id) => id !== originJobId) || originJobId;

  const wrap = document.createElement('div');

  const controls = document.createElement('div');
  controls.className = 'compare-controls';

  const selA = buildJobSelect(originJobId);
  const selB = buildJobSelect(otherJobId);
  const labelSelA = document.createElement('label');
  labelSelA.textContent = 'Video A';
  labelSelA.appendChild(selA);
  const labelSelB = document.createElement('label');
  labelSelB.textContent = 'Video B';
  labelSelB.appendChild(selB);
  controls.appendChild(labelSelA);
  controls.appendChild(labelSelB);

  const overlayLabel = document.createElement('label');
  overlayLabel.className = 'compare-overlay-toggle';
  const overlayCheckbox = document.createElement('input');
  overlayCheckbox.type = 'checkbox';
  overlayLabel.appendChild(overlayCheckbox);
  overlayLabel.appendChild(document.createTextNode(isAdvanced() ? ' Overlay DCT diff contribution' : ' Show difference heatmap'));
  controls.appendChild(overlayLabel);

  wrap.appendChild(controls);

  const summary = document.createElement('div');
  summary.className = 'compare-summary';
  wrap.appendChild(summary);

  const sliderHost = document.createElement('div');
  wrap.appendChild(sliderHost);

  const legend = document.createElement('p');
  legend.className = 'compare-overlay-legend';
  legend.hidden = true;
  legend.textContent = isAdvanced()
    ? 'Warmer/more opaque red = this region both actually differs between the two collages (in the 64\u00d764 downsample) and sits where the specific frequencies that flipped bits are most sensitive. Both have to be true \u2014 a region that\u2019s identical between the two videos won\u2019t light up here even if it lines up with a flipped coefficient\u2019s pattern.'
    : 'Warmer/more opaque red = this area of the snapshot grid contributed most to the fingerprint difference. A region that looks the same in both videos won\u2019t light up even if it overlaps with a pattern that differs.';
  wrap.appendChild(legend);

  let slider = null;

  function placeholderCanvas() {
    const c = document.createElement('canvas');
    c.width = 800; c.height = 800;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#10161a';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.fillStyle = '#bfccd6';
    ctx.font = '18px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Not assembled yet', c.width / 2, c.height / 2);
    return c;
  }

  function buildOverlayCanvas(jobA, jobB, size) {
    if (!jobA.dct || !jobB.dct || !jobA.gray || !jobB.gray) return null;
    const diffWeights = {};
    let anyDiff = false;
    for (let i = 0; i < 64; i++) {
      if (jobA.bits[i] !== jobB.bits[i]) {
        diffWeights[i] = Math.abs(jobA.dct[i] - jobB.dct[i]);
        anyDiff = true;
      }
    }
    if (!anyDiff) return null;

    const pixelDiff = new Float64Array(4096);
    for (let i = 0; i < 4096; i++) pixelDiff[i] = jobA.gray[i] - jobB.gray[i];

    const heat = PhashCore.computeDctContributionHeatmap(Object.keys(diffWeights).map(Number), diffWeights, pixelDiff);

    const small = document.createElement('canvas');
    small.width = 64; small.height = 64;
    const sctx = small.getContext('2d');
    const imgData = sctx.createImageData(64, 64);
    for (let i = 0; i < heat.length; i++) {
      const v = heat[i];
      imgData.data[i * 4 + 0] = Math.round(255 * v);
      imgData.data[i * 4 + 1] = 0;
      imgData.data[i * 4 + 2] = Math.round(200 * (1 - v));
      imgData.data[i * 4 + 3] = Math.round(200 + 52 * v);
    }
    sctx.putImageData(imgData, 0, 0);

    const big = document.createElement('canvas');
    big.width = size; big.height = size;
    const bctx = big.getContext('2d');
    bctx.imageSmoothingEnabled = true;
    bctx.drawImage(small, 0, 0, size, size);
    return big;
  }

  function render() {
    const jobA = jobs.get(selA.value);
    const jobB = jobs.get(selB.value);
    const canvasA = (jobA && jobA.cleanMontageCanvas.width) ? cloneCanvas(jobA.cleanMontageCanvas) : placeholderCanvas();
    const canvasB = (jobB && jobB.cleanMontageCanvas.width) ? cloneCanvas(jobB.cleanMontageCanvas) : placeholderCanvas();
    const labelA = jobA ? jobA.name : '—';
    const labelB = jobB ? jobB.name : '—';

    let overlayCanvas = null;
    if (jobA && jobB) overlayCanvas = buildOverlayCanvas(jobA, jobB, canvasB.width || 800);

    if (jobA && jobB && jobA.hex && jobB.hex) {
      const distance = hammingDistanceLocal(jobA.hex, jobB.hex);
      summary.textContent = isAdvanced()
        ? `Hamming distance: ${distance} of 64 bits.`
        : `${distance} of 64 bits differ.`;
    } else {
      summary.textContent = isAdvanced()
        ? 'Both videos need to finish hashing for a hash comparison.'
        : 'Both videos need to finish processing for a comparison.';
    }

    legend.hidden = !overlayCanvas;
    overlayCheckbox.disabled = !overlayCanvas;

    if (!slider) {
      slider = buildCompareSlider({ canvasA, canvasB, labelA, labelB, overlayCanvas: overlayCanvas || document.createElement('canvas') });
      sliderHost.appendChild(slider.node);
    } else {
      slider.setImages(canvasA, canvasB, labelA, labelB);
    }
    slider.setOverlayVisible(overlayCheckbox.checked && !!overlayCanvas);
  }

  selA.addEventListener('change', render);
  selB.addEventListener('change', render);
  overlayCheckbox.addEventListener('change', render);
  render();

  openModal(isAdvanced() ? 'Collage comparison' : 'Snapshot grid comparison', wrap, {
    onKeydown(e) {
      if ((e.key === 't' || e.key === 'T') && slider && !overlayCheckbox.disabled) {
        e.preventDefault();
        overlayCheckbox.checked = !overlayCheckbox.checked;
        slider.setOverlayVisible(overlayCheckbox.checked);
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Modal: DCT bit-level diff between two videos
// ---------------------------------------------------------------------------

function openDctDiffModal(originJobId) {
  const wrap = document.createElement('div');

  const controls = document.createElement('div');
  controls.className = 'dct-diff-controls';

  const jobIds = Array.from(jobs.keys());
  const otherJobId = jobIds.find((id) => id !== originJobId) || originJobId;

  const selA = buildJobSelect(originJobId);
  const selB = buildJobSelect(otherJobId);

  const labelA = document.createElement('label');
  labelA.textContent = 'Video A';
  labelA.appendChild(selA);
  const labelB = document.createElement('label');
  labelB.textContent = 'Video B';
  labelB.appendChild(selB);

  controls.appendChild(labelA);
  controls.appendChild(labelB);
  wrap.appendChild(controls);

  const summary = document.createElement('div');
  summary.className = 'dct-diff-summary';
  wrap.appendChild(summary);

  const grids = document.createElement('div');
  grids.className = 'dct-diff-grids';
  wrap.appendChild(grids);

  function render() {
    const jobA = jobs.get(selA.value);
    const jobB = jobs.get(selB.value);
    grids.innerHTML = '';
    summary.innerHTML = '';

    if (!jobA || !jobB || !jobA.dct || !jobB.dct) {
      summary.textContent = 'Both videos need to finish hashing first.';
      return;
    }

    const diffIdx = new Set();
    for (let i = 0; i < 64; i++) {
      if (jobA.bits[i] !== jobB.bits[i]) diffIdx.add(i);
    }

    summary.innerHTML = isAdvanced()
      ? `<span class="distance">${diffIdx.size}</span> of 64 coefficients flipped sides of the median (Hamming distance ${diffIdx.size}). Outlined cells below are the ones responsible for the hash difference.`
      : `<span class="distance">${diffIdx.size}</span> of 64 frequency patterns differ between the two videos. Outlined cells below show exactly which ones.`;

    grids.appendChild(buildDctFigure(jobA.name, jobA.dct, jobA.bits, jobA.median, diffIdx));
    grids.appendChild(buildDiffFigure(jobA, jobB, diffIdx));
    grids.appendChild(buildDctFigure(jobB.name, jobB.dct, jobB.bits, jobB.median, diffIdx));
  }

  selA.addEventListener('change', render);
  selB.addEventListener('change', render);
  render();

  openModal(isAdvanced() ? 'DCT coefficient diff' : 'Frequency comparison', wrap);
}

function buildJobSelect(selectedId) {
  const sel = document.createElement('select');
  for (const [id, job] of jobs.entries()) {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = job.name;
    if (id === selectedId) opt.selected = true;
    sel.appendChild(opt);
  }
  return sel;
}

function buildDctFigure(name, coeffs, bits, median, highlightSet) {
  const fig = document.createElement('figure');
  const canvas = document.createElement('canvas');
  canvas.width = 260;
  canvas.height = 260;
  drawDctHeatmap(canvas, coeffs, bits, median, highlightSet);
  fig.appendChild(canvas);
  const cap = document.createElement('figcaption');
  cap.textContent = name;
  fig.appendChild(cap);
  return fig;
}

function buildDiffFigure(jobA, jobB, diffIdx) {
  const fig = document.createElement('figure');
  const canvas = document.createElement('canvas');
  canvas.width = 260;
  canvas.height = 260;
  drawDiffGrid(canvas, jobA, jobB, diffIdx);
  fig.appendChild(canvas);
  const cap = document.createElement('figcaption');
  cap.textContent = isAdvanced() ? 'Diff (bit flips highlighted)' : 'Differences';
  fig.appendChild(cap);
  return fig;
}

function drawDiffGrid(canvas, jobA, jobB, diffIdx) {
  const ctx = canvas.getContext('2d');
  const size = canvas.width;
  const cell = size / 8;

  for (let j = 0; j < 8; j++) {
    for (let i = 0; i < 8; i++) {
      const idx = 8 * j + i;
      const flipped = diffIdx.has(idx);
      ctx.fillStyle = flipped ? 'rgba(219,55,55,0.55)' : 'rgba(65,76,83,0.4)'; // --danger vs --border-ish
      ctx.fillRect(i * cell, j * cell, cell, cell);
      ctx.strokeStyle = 'rgba(255,255,255,0.15)';
      ctx.strokeRect(i * cell, j * cell, cell, cell);

      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.font = '10px monospace';
      ctx.textAlign = 'center';
      if (flipped) {
        ctx.fillText(`${jobA.bits[idx]}→${jobB.bits[idx]}`, i * cell + cell / 2, j * cell + cell / 2 + 4);
      } else {
        ctx.fillText('=', i * cell + cell / 2, j * cell + cell / 2 + 4);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// DCT heatmap (shared by the stage-3 cards and the diff modal)
// ---------------------------------------------------------------------------

function drawDctHeatmap(canvas, coeffs, bits, median, highlightSet) {
  const ctx = canvas.getContext('2d');
  const size = canvas.width; // square canvas, 8x8 grid
  const cell = size / 8;
  const maxAbs = Math.max(...coeffs.map((v) => Math.abs(v))) || 1;

  for (let j = 0; j < 8; j++) {
    for (let i = 0; i < 8; i++) {
      const idx = 8 * j + i;
      const v = coeffs[idx];
      const intensity = Math.min(1, Math.abs(v) / maxAbs);
      const above = v > median;
      const color = above
        ? `rgba(255,${Math.round(160 - 100 * intensity)},80,${0.35 + 0.65 * intensity})`
        : `rgba(80,${Math.round(140 + 60 * intensity)},255,${0.35 + 0.65 * intensity})`;
      ctx.fillStyle = color;
      ctx.fillRect(i * cell, j * cell, cell, cell);

      const isHighlighted = highlightSet && highlightSet.has(idx);
      ctx.strokeStyle = isHighlighted ? '#db3737' : 'rgba(255,255,255,0.15)';
      ctx.lineWidth = isHighlighted ? 2 : 1;
      ctx.strokeRect(i * cell + ctx.lineWidth / 2, j * cell + ctx.lineWidth / 2, cell - ctx.lineWidth, cell - ctx.lineWidth);
      ctx.lineWidth = 1;

      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.font = '11px monospace';
      ctx.textAlign = 'center';
      ctx.fillText(String(bits[idx]), i * cell + cell / 2, j * cell + cell / 2 + 4);
    }
  }
}

// ---------------------------------------------------------------------------
// Comparison table (stage 4)
// ---------------------------------------------------------------------------

function updateComparisonTable() {
  const withHash = Array.from(jobs.values()).filter((j) => j.hex);
  if (withHash.length < 2) { comparisonSection.hidden = true; return; }
  comparisonSection.hidden = false;

  let html = '<tr><th></th>' + withHash.map((j) => `<th>${j.name}</th>`).join('') + '</tr>';
  for (const rowJob of withHash) {
    html += `<tr><th>${rowJob.name}</th>`;
    for (const colJob of withHash) {
      if (rowJob === colJob) {
        html += '<td>&mdash;</td>';
      } else {
        html += `<td>${hammingDistanceLocal(rowJob.hex, colJob.hex)}</td>`;
      }
    }
    html += '</tr>';
  }
  comparisonTable.innerHTML = html;
}

function hammingDistanceLocal(hexA, hexB) {
  let a = BigInt('0x' + hexA);
  let b = BigInt('0x' + hexB);
  let x = a ^ b;
  let count = 0n;
  while (x) { count += x & 1n; x >>= 1n; }
  return Number(count);
}
