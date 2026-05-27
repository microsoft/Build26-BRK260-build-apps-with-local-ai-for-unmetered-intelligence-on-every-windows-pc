// ── DOM elements ────────────────────────────────────────────────────────────────
const statusDot    = document.getElementById('status-dot');
const statusText   = document.getElementById('status-text');
const progressCont = document.getElementById('progress-container');
const progressBar  = document.getElementById('progress-bar');
const dropZone     = document.getElementById('drop-zone');
const placeholder  = document.getElementById('placeholder');
const previewImg   = document.getElementById('preview-img');
const btnBrowse    = document.getElementById('btn-browse');
const btnDescribe  = document.getElementById('btn-describe');
const output       = document.getElementById('description-output');
const statsEl      = document.getElementById('stats');

// ── State ───────────────────────────────────────────────────────────────────────
let imageData = null;   // { base64, mimeType, fileName }
let modelReady = false;
let describing = false;

// ── Helpers ─────────────────────────────────────────────────────────────────────
function setStatus(text, state = 'loading') {
  statusText.textContent = text;
  statusDot.className = 'dot ' + state;
}

function showProgress(pct) {
  progressCont.style.display = 'block';
  progressBar.style.width = pct.toFixed(1) + '%';
}

function hideProgress() {
  progressCont.style.display = 'none';
  progressBar.style.width = '0%';
}

function setImage(data) {
  imageData = data;
  previewImg.src = `data:${data.mimeType};base64,${data.base64}`;
  previewImg.style.display = 'block';
  placeholder.style.display = 'none';
  btnDescribe.disabled = !modelReady;
}

function clearOutput() {
  output.innerHTML = '';
  statsEl.textContent = '';
}

// ── Event listeners ─────────────────────────────────────────────────────────────

// Drag & drop
dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZone.classList.add('drag-over');
});
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file && file.type.startsWith('image/')) {
    readFileAsBase64(file);
  }
});

// Click to browse (via drop zone)
dropZone.addEventListener('click', () => {
  if (!describing) browseImage();
});

btnBrowse.addEventListener('click', browseImage);

btnDescribe.addEventListener('click', describeImage);

// ── Functions ───────────────────────────────────────────────────────────────────

function readFileAsBase64(file) {
  const reader = new FileReader();
  reader.onload = () => {
    const base64 = reader.result.split(',')[1];
    setImage({ base64, mimeType: file.type, fileName: file.name });
  };
  reader.readAsDataURL(file);
}

async function browseImage() {
  const result = await window.api.selectImage();
  if (result) setImage(result);
}

async function describeImage() {
  if (!imageData || !modelReady || describing) return;

  describing = true;
  btnDescribe.disabled = true;
  btnBrowse.disabled = true;
  clearOutput();
  setStatus('Analyzing image…', 'loading');

  // Listen for streaming chunks
  const cleanup = window.api.onDescribeChunk((chunk) => {
    output.textContent += chunk.content;
    output.scrollTop = output.scrollHeight;
  });

  try {
    const result = await window.api.describeImage(imageData.base64, imageData.mimeType);

    const s = result.stats;
    statsEl.textContent =
      `${s.tokenCount} tokens · ${s.tokensPerSecond} tok/s · ` +
      `TTFT ${s.timeToFirstToken}ms · Total ${(s.totalTime / 1000).toFixed(1)}s`;

    setStatus('Ready — model loaded', 'ready');
  } catch (err) {
    output.innerHTML = `<span style="color:#ef4444">Error: ${err.message}</span>`;
    setStatus('Error during inference', 'error');
  } finally {
    cleanup();
    describing = false;
    btnDescribe.disabled = false;
    btnBrowse.disabled = false;
  }
}

// ── Foundry Local event listeners ───────────────────────────────────────────────
window.api.onStatus((msg) => setStatus(msg, 'loading'));
window.api.onDownloadProgress((pct) => showProgress(pct));

// ── Boot sequence ───────────────────────────────────────────────────────────────
(async function boot() {
  try {
    setStatus('Initializing Foundry Local SDK…', 'loading');
    await window.api.initialize();

    setStatus('Downloading & loading Qwen 3.5 9B… (first run may take a while)', 'loading');
    await window.api.loadModel();
    hideProgress();

    modelReady = true;
    btnBrowse.disabled = false;
    if (imageData) btnDescribe.disabled = false;

    setStatus('Ready — model loaded', 'ready');
  } catch (err) {
    setStatus(`Setup failed: ${err.message}`, 'error');
    console.error('Boot error:', err);
  }
})();
