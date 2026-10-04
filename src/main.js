import { KokoroReaderSession } from './tts.js';
import './style.css';

const $ = (id) => document.getElementById(id);
const ui = Object.fromEntries(['textInput','placeholder','textView','textCount','pasteBtn','editBtn','clearBtn','playBtn','mainPlayLabel','transportPlayBtn','restartBtn','stopBtn','previousBtn','nextBtn','backBtn','forwardBtn','rateBtn','volumeSlider','muteBtn','scrubber','scrubProgress','elapsedTime','totalTime','statusText','statusLed','generationText','chunkCount','generationProgress','bufferStatus','deviceStatus','trackTitle','trackSubtitle','playerTrackTitle','playerTrackMeta','trackWave','toast','helpBtn','voiceSelect','voiceAvatar','voiceMeta'].map((id) => [id, $(id)]));
const rates = [0.75,0.9,1,1.1,1.25,1.5,1.75,2];
const voices = [
  { id: 'af_heart', name: 'Heart', accent: 'AMERICAN · WARM' },
  { id: 'af_jessica', name: 'Jessica', accent: 'AMERICAN · FEMALE' },
  { id: 'af_nicole', name: 'Nicole', accent: 'AMERICAN · FEMALE' },
  { id: 'af_sky', name: 'Sky', accent: 'AMERICAN · FEMALE' },
  { id: 'am_adam', name: 'Adam', accent: 'AMERICAN · MALE' },
  { id: 'am_onyx', name: 'Onyx', accent: 'AMERICAN · MALE' },
  { id: 'am_santa', name: 'Santa', accent: 'AMERICAN · MALE' },
  { id: 'bf_alice', name: 'Alice', accent: 'BRITISH · FEMALE' },
  { id: 'bf_emma', name: 'Emma', accent: 'BRITISH · FEMALE' },
  { id: 'bm_daniel', name: 'Daniel', accent: 'BRITISH · MALE' },
  { id: 'bm_lewis', name: 'Lewis', accent: 'BRITISH · MALE' },
];
const preferencesKey = 'echolink-preferences';
const textKey = 'echolink-last-text';
let toastTimer, preparedText = '', viewSpans = [], scrubbing = false, lastStatus = 'ready';
function readLocal(key) { try { return localStorage.getItem(key); } catch { return null; } }
function writeLocal(key, value) { try { localStorage.setItem(key, value); } catch { /* Speech stays available when browser storage is restricted. */ } }
let saved = {};
try { saved = JSON.parse(readLocal(preferencesKey) || readLocal('hush-preferences') || '{}'); } catch { saved = {}; }
const worker = new Worker(new URL('./tts-worker.js', import.meta.url), { type: 'module' });
const audioContext = new AudioContext({ sampleRate: 24000 });
const session = new KokoroReaderSession(worker, audioContext, update);
for (const voice of voices) {
  const option = document.createElement('option');
  option.value = voice.id;
  option.textContent = `${voice.name} (${voice.id})`;
  ui.voiceSelect.append(option);
}
const savedVoice = voices.find(({ id }) => id === saved.voice) || voices[0];
session.voice = savedVoice.id;
ui.voiceSelect.value = savedVoice.id;
renderVoice();

ui.textInput.value = readLocal(textKey) || readLocal('hush-last-text') || '';
session.rate = Number(saved.rate) || 1;
session.volume = saved.volume == null ? 0.82 : Number(saved.volume);
let lastVolume = Number(saved.lastVolume) || (session.volume > 0 ? session.volume : 0.82);
ui.volumeSlider.value = Math.round(session.volume * 100);
renderText();
worker.postMessage({ type: 'initialize', voice: session.voice });

function wordCount(text) { return text.trim() ? text.trim().split(/\s+/).length : 0; }
function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.floor(seconds); const hours = Math.floor(total / 3600); const minutes = Math.floor((total % 3600) / 60); const secs = total % 60;
  return hours ? `${hours}:${String(minutes).padStart(2,'0')}:${String(secs).padStart(2,'0')}` : `${minutes}:${String(secs).padStart(2,'0')}`;
}
function notify(message) {
  ui.toast.textContent = message; ui.toast.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => ui.toast.classList.remove('show'), 3800);
}
function selectedVoice() { return voices.find(({ id }) => id === session.voice) || voices[0]; }
function renderVoice() {
  const voice = selectedVoice();
  ui.voiceAvatar.textContent = voice.name[0];
  ui.voiceMeta.textContent = voice.accent;
  ui.playerTrackMeta.textContent = `Kokoro · ${voice.name}`;
}
ui.voiceSelect.addEventListener('change', () => {
  session.stop();
  session.voice = ui.voiceSelect.value;
  renderVoice();
  savePreferences();
  notify(`${selectedVoice().name} selected. Start listening to use this voice.`);
});
function renderText() {
  const text = ui.textInput.value;
  const words = wordCount(text);
  ui.textCount.innerHTML = `${words.toLocaleString()} ${words === 1 ? 'word' : 'words'} <span>·</span> ${text.length.toLocaleString()} characters`;
  ui.placeholder.hidden = !!text;
  ui.textInput.classList.toggle('has-text', !!text);
  writeLocal(textKey, text);
  if (text !== preparedText) {
    ui.textView.hidden = true; ui.textInput.hidden = false;
    if (session.chunks.length) session.stop();
  }
}
ui.textInput.addEventListener('input', renderText);
ui.pasteBtn.addEventListener('click', async () => {
  try { ui.textInput.value = await navigator.clipboard.readText(); ui.textInput.focus(); renderText(); }
  catch { ui.textInput.focus(); notify('Clipboard access is unavailable. Use Ctrl+V to paste.'); }
});
ui.clearBtn.addEventListener('click', () => { ui.textInput.value = ''; preparedText = ''; session.stop(); ui.textInput.focus(); renderText(); });
ui.editBtn.addEventListener('click', () => { session.pause(); ui.textView.hidden = true; ui.textInput.hidden = false; ui.textInput.focus(); });
ui.helpBtn.addEventListener('click', () => notify('Space: play or pause · ← / →: skip 15 seconds · Shift + ← / →: previous or next sentence'));

function showReadView(text, chunks) {
  ui.textView.replaceChildren(); viewSpans = [];
  let offset = 0;
  for (const chunk of chunks) {
    if (chunk.sourceStart > offset) ui.textView.append(document.createTextNode(text.slice(offset, chunk.sourceStart)));
    const span = document.createElement('span'); span.className = 'speech-chunk'; span.dataset.index = chunk.index;
    span.textContent = text.slice(chunk.sourceStart, chunk.sourceEnd) || chunk.text;
    ui.textView.append(span); viewSpans.push(span); offset = chunk.sourceEnd;
  }
  if (offset < text.length) ui.textView.append(document.createTextNode(text.slice(offset)));
  ui.textView.hidden = false; ui.textInput.hidden = true;
}

async function startOrResume() {
  if (ui.textInput.value.trim() && (!session.chunks.length || ui.textInput.value !== preparedText)) {
    preparedText = ui.textInput.value;
    session.prepare(preparedText);
    showReadView(preparedText, session.chunks);
  }
  if (!session.chunks.length) { ui.textInput.focus(); notify('Paste or type something to read first.'); return; }
  await session.play();
}
ui.playBtn.addEventListener('click', () => session.playing ? session.pause() : startOrResume());
ui.transportPlayBtn.addEventListener('click', () => session.playing ? session.pause() : startOrResume());
ui.backBtn.addEventListener('click', () => session.skip(-15));
ui.forwardBtn.addEventListener('click', () => session.skip(15));
ui.stopBtn.addEventListener('click', () => session.stop());
ui.restartBtn.addEventListener('click', () => { const wasPlaying = session.playing; session.seek(0); if (wasPlaying) session.play(); });
ui.previousBtn.addEventListener('click', () => moveSentence(-1));
ui.nextBtn.addEventListener('click', () => moveSentence(1));
function moveSentence(direction) {
  if (!session.chunks.length) return;
  const position = session.currentPosition();
  let current = session.chunks.findIndex((chunk) => position >= chunk.start && position < chunk.end);
  if (current < 0) current = session.cursor || 0;
  const target = Math.max(0, Math.min(session.chunks.length - 1, current + direction));
  session.seek(session.chunks[target].start);
  if (session.playing && !session.chunks[target].buffer) notify('Preparing that section…');
}
ui.rateBtn.addEventListener('click', () => {
  const index = rates.indexOf(session.rate);
  session.setPlaybackRate(rates[(index + 1) % rates.length]);
  savePreferences();
});
ui.volumeSlider.addEventListener('input', () => { session.setVolume(Number(ui.volumeSlider.value) / 100); if (session.volume > 0) lastVolume = session.volume; savePreferences(); });
ui.muteBtn.addEventListener('click', () => {
  const muted = session.volume > 0;
  if (muted) lastVolume = session.volume;
  session.setVolume(muted ? 0 : lastVolume);
  ui.volumeSlider.value = Math.round(session.volume * 100); savePreferences();
});
function savePreferences() { writeLocal(preferencesKey, JSON.stringify({ rate: session.rate, volume: session.volume, lastVolume, voice: session.voice })); }
ui.scrubber.addEventListener('input', () => {
  scrubbing = true;
  const duration = session.duration;
  const target = duration * Number(ui.scrubber.value) / 1000;
  ui.elapsedTime.textContent = formatTime(target);
  ui.scrubProgress.style.width = `${ui.scrubber.value / 10}%`;
});
ui.scrubber.addEventListener('change', () => {
  session.seek(session.duration * Number(ui.scrubber.value) / 1000); scrubbing = false;
  if (session.playing && session.buffering) notify('Preparing your place…');
});
ui.textView.addEventListener('click', (event) => {
  const span = event.target.closest('.speech-chunk'); if (!span) return;
  const target = session.chunks[Number(span.dataset.index)];
  if (target) { session.seek(target.start); if (!session.playing) session.play(); }
});
document.addEventListener('keydown', (event) => {
  const typing = event.target === ui.textInput || ['INPUT','TEXTAREA','SELECT'].includes(event.target?.tagName) || event.target?.isContentEditable;
  if (typing || event.altKey || event.ctrlKey || event.metaKey) return;
  if (event.code === 'Space') { event.preventDefault(); session.playing ? session.pause() : startOrResume(); }
  else if (event.key === 'ArrowLeft' && event.shiftKey) { event.preventDefault(); moveSentence(-1); }
  else if (event.key === 'ArrowRight' && event.shiftKey) { event.preventDefault(); moveSentence(1); }
  else if (event.key === 'ArrowLeft') { event.preventDefault(); session.skip(-15); }
  else if (event.key === 'ArrowRight') { event.preventDefault(); session.skip(15); }
});

let lastHighlight = -1;
function update(state = {}) {
  if (state.status === 'error') { lastStatus = 'error'; ui.statusText.textContent = state.message || 'Something went wrong'; ui.statusLed.className = 'status-led error'; notify(state.message || 'Speech generation failed.'); }
  else if (state.status === 'loading') {
    lastStatus = state.status; ui.statusText.textContent = state.message || (state.status === 'loading' ? 'Loading Kokoro' : 'Generating speech'); ui.statusLed.className = `status-led ${state.status}`;
  } else if (session.paused && state.total) {
    ui.statusText.textContent = state.generated ? (state.generated < state.total ? 'Paused · building buffer' : 'Paused') : 'Preparing speech';
    ui.statusLed.className = state.generated < state.total ? 'status-led generating' : 'status-led';
  } else if (state.status === 'generating') {
    lastStatus = state.status; ui.statusText.textContent = state.message || 'Generating speech'; ui.statusLed.className = 'status-led generating';
  } else if (state.buffering) { ui.statusText.textContent = 'Preparing your place…'; ui.statusLed.className = 'status-led loading'; }
  else if (state.playing) { ui.statusText.textContent = 'Playing'; ui.statusLed.className = 'status-led playing'; }
  else if (state.generated && state.generated === state.total && state.total && !state.playing) { ui.statusText.textContent = 'Ready to listen'; ui.statusLed.className = 'status-led'; }
  else if (lastStatus !== 'loading' && lastStatus !== 'generating') { ui.statusText.textContent = 'Ready when you are'; ui.statusLed.className = 'status-led'; }
  if (state.status === 'ready') { lastStatus = 'ready'; ui.statusText.textContent = session.paused ? (session.chunks.length ? 'Paused' : 'Ready to listen') : (session.playing ? 'Playing' : 'Ready to listen'); ui.statusLed.className = session.playing ? 'status-led playing' : 'status-led'; }
  if (state.message?.includes('WebGPU is unavailable')) ui.deviceStatus.textContent = 'UNAVAILABLE';
  else if (state.status === 'loading' || state.status === 'ready') ui.deviceStatus.textContent = 'WEBGPU';
  ui.generationText.textContent = state.total && state.generated === state.total ? 'AUDIO READY' : (state.generated ? 'GENERATING SPEECH' : (state.status === 'loading' ? 'LOADING MODEL · FP32' : 'KOKORO · FP32'));
  ui.chunkCount.textContent = `${state.generated || 0} / ${state.total || 0}`;
  ui.generationProgress.style.width = `${state.total ? 100 * state.generated / state.total : (state.status === 'loading' ? '14' : '0')}%`;
  const buffered = Math.max(0, (state.chunks || []).reduce((sum, chunk) => sum + (chunk.buffer ? chunk.duration : 0), 0));
  ui.bufferStatus.textContent = buffered ? `${Math.floor(buffered / 60)}:${String(Math.floor(buffered % 60)).padStart(2,'0')}` : '—';
  const position = state.position ?? session.currentPosition();
  const duration = state.duration ?? session.duration;
  ui.elapsedTime.textContent = formatTime(position);
  ui.totalTime.textContent = duration ? formatTime(duration) : '0:00';
  if (!scrubbing && duration) {
    const progress = Math.min(1000, Math.round(position / duration * 1000));
    ui.scrubber.value = progress; ui.scrubProgress.style.width = `${progress / 10}%`;
  }
  ui.rateBtn.innerHTML = `${Number(session.rate.toFixed(2))}<span>x</span>`;
  ui.muteBtn.classList.toggle('muted', session.volume === 0);
  ui.transportPlayBtn.classList.toggle('is-playing', state.playing);
  ui.transportPlayBtn.setAttribute('aria-label', state.playing ? 'Pause' : 'Play');
  ui.transportPlayBtn.firstElementChild.textContent = state.playing ? 'Ⅱ' : '▶';
  ui.mainPlayLabel.textContent = state.playing ? 'Pause listening' : (state.generated ? 'Resume listening' : 'Start listening');
  ui.trackWave.classList.toggle('active', !!state.playing);
  if (preparedText) {
    ui.trackTitle.textContent = preparedText.trim().split(/\s+/).slice(0,5).join(' ') + (wordCount(preparedText)>5 ? '…' : '');
    ui.trackSubtitle.textContent = `${wordCount(preparedText).toLocaleString()} words · read by ${selectedVoice().name}`;
    ui.playerTrackTitle.textContent = ui.trackTitle.textContent;
  }
  const active = (state.chunks || []).findIndex((chunk) => position >= chunk.start && position < chunk.end);
  if (active !== lastHighlight && active < 0) { viewSpans[lastHighlight]?.classList.remove('active'); lastHighlight = -1; }
  if (active !== lastHighlight && active >= 0 && viewSpans[active]) {
    viewSpans[lastHighlight]?.classList.remove('active');
    viewSpans[active].classList.add('active'); lastHighlight = active;
    const rect = viewSpans[active].getBoundingClientRect();
    if (rect.top < 110 || rect.bottom > innerHeight - 185) viewSpans[active].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}
setInterval(() => { if (session.playing) update({ position: session.currentPosition(), duration: session.duration, playing: true, chunks: session.chunks, generated: session.generated, total: session.chunks.length, cursor: session.cursor }); }, 120);
