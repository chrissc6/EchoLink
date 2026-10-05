import { KokoroReaderSession, cleanEchoLinkText } from './tts.js';
import './style.css';

const $ = (id) => document.getElementById(id);
const ui = Object.fromEntries(['textInput','placeholder','textView','textCount','pasteBtn','clearBtn','editorPlayBtn','openFileBtn','fileInput','copyBtn','cleanFormatting','fallbackBtn','engineMode','engineSubtitle','editorCard','transportPlayBtn','restartBtn','stopBtn','previousBtn','nextBtn','backBtn','forwardBtn','rateSelect','volumeSlider','muteBtn','scrubber','scrubProgress','elapsedTime','totalTime','statusText','statusLed','generationText','chunkCount','generationProgress','bufferStatus','deviceStatus','engineVoice','trackTitle','trackSubtitle','trackWave','toast','helpBtn','historyBtn','settingsBtn','appDialog','dialogTitle','dialogContent','downloadBtn','sideVoice','voiceSelect','voiceAvatar','voiceMeta'].map((id) => [id, $(id)]));
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
const historyKey = 'echolink-history';
let toastTimer, preparedText = '', viewSpans = [], scrubbing = false, lastStatus = 'loading', lastHighlight = -1, modelReady = false;
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
  const info = voiceInfo(voice);
  option.textContent = `${voice.name} ${info.display}`;
  option.dataset.name = voice.name;
  option.dataset.meta = info.display;
  option.dataset.accessible = info.accessible;
  ui.voiceSelect.append(option);
}
const savedVoice = voices.find(({ id }) => id === saved.voice) || voices[0];
session.voice = savedVoice.id;
ui.voiceSelect.value = savedVoice.id;
renderVoice();

ui.textInput.value = '';
ui.cleanFormatting.checked = saved.cleanFormatting !== false;
session.rate = rates.includes(Number(saved.rate)) ? Number(saved.rate) : 1;
session.volume = saved.volume == null ? 0.82 : Math.max(0, Math.min(1, Number(saved.volume)));
ui.rateSelect.value = String(session.rate);
let lastVolume = Number(saved.lastVolume) || (session.volume > 0 ? session.volume : 0.82);
ui.volumeSlider.value = Math.round(session.volume * 100);
enhanceSelect(ui.voiceSelect);
enhanceSelect(ui.rateSelect);
renderText();
worker.postMessage({ type: 'initialize', voice: session.voice });

function voiceInfo(voice) {
  const country = voice.id.startsWith('a') ? 'United States' : 'United Kingdom';
  const gender = voice.id[1] === 'f' ? 'Female' : 'Male';
  const flag = voice.id.startsWith('a') ? '🇺🇸' : '🇬🇧';
  const symbol = voice.id[1] === 'f' ? '♀' : '♂';
  return { country, gender, display: `${flag} ${symbol}`, accessible: `${voice.name}, ${country}, ${gender}` };
}

function enhanceSelect(select) {
  if (!select || select.dataset.enhanced) return;
  select.dataset.enhanced = 'true';
  const wrapper = document.createElement('div');
  wrapper.className = `custom-select-wrap ${select.id === 'rateSelect' ? 'speed-menu-wrap' : ''}`;
  select.before(wrapper);
  wrapper.append(select);
  select.classList.add('custom-select-source');
  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.id = `${select.id}MenuButton`;
  trigger.className = 'custom-select-trigger';
  trigger.setAttribute('role', 'combobox');
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.setAttribute('aria-controls', `${select.id}MenuList`);
  const label = select.getAttribute('aria-label') || select.closest('label')?.childNodes[0]?.textContent?.trim() || 'Choose an option';
  const menu = document.createElement('div');
  menu.id = `${select.id}MenuList`;
  menu.className = 'custom-select-menu';
  menu.setAttribute('role', 'listbox');
  menu.hidden = true;
  wrapper.append(trigger, menu);

  const labelFor = (option) => option.dataset.accessible || option.dataset.display || option.textContent.trim();
  function renderOptions() {
    menu.replaceChildren();
    [...select.options].forEach((option) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'custom-select-option';
      item.setAttribute('role', 'option');
      item.setAttribute('aria-label', labelFor(option));
      item.setAttribute('aria-selected', String(option.value === select.value));
      item.dataset.value = option.value;
      const name = document.createElement('span');
      name.className = 'custom-option-name';
      name.textContent = option.dataset.name || option.dataset.display || option.textContent.trim();
      item.append(name);
      if (option.dataset.meta) {
        const meta = document.createElement('span');
        meta.className = 'custom-option-meta';
        meta.textContent = option.dataset.meta;
        item.append(meta);
      }
      item.addEventListener('click', () => {
        select.value = option.value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        closeMenu();
        trigger.focus();
      });
      menu.append(item);
    });
  }
  function syncValue() {
    const option = select.selectedOptions[0];
    if (!option) return;
    trigger.setAttribute('aria-label', `${label}: ${labelFor(option)}`);
    trigger.replaceChildren();
    const value = document.createElement('span');
    value.className = 'custom-select-value';
    const name = document.createElement('span');
    name.textContent = option.dataset.name || option.dataset.display || option.textContent.trim();
    value.append(name);
    if (option.dataset.meta) {
      const meta = document.createElement('span');
      meta.className = 'custom-option-meta';
      meta.textContent = option.dataset.meta;
      value.append(meta);
    }
    const caret = document.createElement('span');
    caret.className = 'custom-select-caret';
    caret.setAttribute('aria-hidden', 'true');
    trigger.append(value, caret);
    menu.querySelectorAll('[role="option"]').forEach((item) => item.setAttribute('aria-selected', String(item.dataset.value === select.value)));
  }
  function openMenu() {
    document.querySelectorAll('.custom-select-menu:not([hidden])').forEach((other) => {
      if (other === menu) return;
      other.hidden = true;
      document.getElementById(other.id.replace('MenuList', 'MenuButton'))?.setAttribute('aria-expanded', 'false');
    });
    renderOptions();
    menu.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    menu.querySelector(`[data-value="${CSS.escape(select.value)}"]`)?.focus();
  }
  function closeMenu() {
    menu.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
  }
  trigger.addEventListener('click', () => menu.hidden ? openMenu() : closeMenu());
  trigger.addEventListener('keydown', (event) => {
    if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) { event.preventDefault(); openMenu(); }
  });
  menu.addEventListener('keydown', (event) => {
    const options = [...menu.querySelectorAll('[role="option"]')];
    const index = options.indexOf(document.activeElement);
    if (event.key === 'Escape') { event.preventDefault(); closeMenu(); trigger.focus(); }
    else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); options[Math.max(0, Math.min(options.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))]?.focus(); }
    else if (event.key === 'Home') { event.preventDefault(); options[0]?.focus(); }
    else if (event.key === 'End') { event.preventDefault(); options.at(-1)?.focus(); }
  });
  select.addEventListener('change', syncValue);
  syncValue();
  renderOptions();
}

document.addEventListener('pointerdown', (event) => {
  document.querySelectorAll('.custom-select-wrap').forEach((wrapper) => {
    if (wrapper.contains(event.target)) return;
    const menu = wrapper.querySelector('.custom-select-menu');
    if (menu) menu.hidden = true;
    wrapper.querySelector('.custom-select-trigger')?.setAttribute('aria-expanded', 'false');
  });
});

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
  ui.engineVoice.textContent = `${voice.name.toUpperCase()} · ${voice.id.slice(0, 2).toUpperCase()}`;
  ui.sideVoice.textContent = `${voice.name} (${voice.id})`;
  renderTrack();
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
  ui.placeholder.hidden = !!text.trim();
  ui.clearBtn.disabled = !text;
  ui.copyBtn.disabled = !text;
  ui.editorPlayBtn.disabled = !text.trim() || !modelReady;
  ui.textInput.classList.toggle('has-text', !!text.trim());
  if (text !== preparedText) {
    ui.editorCard.dataset.mode = 'edit';
    ui.textView.hidden = true; ui.textView.replaceChildren(); viewSpans = []; lastHighlight = -1;
    if (session.chunks.length) { preparedText = ''; session.stop(); }
  }
  renderTrack();
}
ui.textInput.addEventListener('input', renderText);
ui.pasteBtn.addEventListener('click', async () => {
  try { ui.textInput.value = await navigator.clipboard.readText(); ui.textInput.focus(); renderText(); }
  catch { ui.textInput.focus(); notify('Clipboard access is unavailable. Use Ctrl+V to paste.'); }
});
ui.openFileBtn.addEventListener('click', () => ui.fileInput.click());
ui.fileInput.addEventListener('change', async () => {
  const file = ui.fileInput.files?.[0];
  if (!file) return;
  ui.textInput.value = await file.text();
  renderText();
  ui.fileInput.value = '';
  notify(`Opened ${file.name}`);
});
ui.copyBtn.addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(ui.textInput.value); notify('Text copied.'); }
  catch { ui.textInput.focus(); ui.textInput.select(); notify('Clipboard access is unavailable. Text selected; copy with Ctrl+C.'); }
});
ui.cleanFormatting.addEventListener('change', () => {
  savePreferences();
  if (session.chunks.length) { session.stop(); preparedText = ''; ui.textView.hidden = true; renderText(); }
});
ui.fallbackBtn.addEventListener('click', () => worker.postMessage({ type: 'fallback-now', reason: 'You selected another local quality mode.' }));
ui.clearBtn.addEventListener('click', () => {
  ui.textInput.value = ''; preparedText = ''; viewSpans = []; lastHighlight = -1;
  ui.editorCard.dataset.mode = 'edit';
  ui.textView.replaceChildren(); ui.textView.hidden = true;
  session.stop(); renderText(); renderTrack(); ui.textInput.focus();
});
function openPanel(title, markup) {
  ui.dialogTitle.textContent = title;
  ui.dialogContent.innerHTML = markup;
  ui.appDialog.showModal();
}
function loadHistory() { try { return JSON.parse(readLocal(historyKey) || '[]'); } catch { return []; } }
function rememberReading(text) {
  if (!text.trim()) return;
  const history = loadHistory().filter((item) => item.text !== text);
  history.unshift({ text, voice: session.voice, at: Date.now() });
  writeLocal(historyKey, JSON.stringify(history.slice(0, 20)));
}
ui.historyBtn.addEventListener('click', () => {
  const history = loadHistory();
  const content = history.length ? `<div class="history-list">${history.map((item, index) => `<button class="history-item" data-history-index="${index}">${escapeHtml(item.text.slice(0, 110))}${item.text.length > 110 ? '…' : ''}<small>${escapeHtml(voices.find((voice) => voice.id === item.voice)?.name || item.voice)} · ${new Date(item.at).toLocaleString()}</small></button>`).join('')}</div>` : '<p class="dialog-copy">Recent readings will appear here on this device.</p>';
  openPanel('Reading history', content);
  ui.dialogContent.querySelectorAll('[data-history-index]').forEach((button) => button.addEventListener('click', () => {
    const item = history[Number(button.dataset.historyIndex)];
    if (!item) return;
    session.stop(); preparedText = ''; ui.textView.replaceChildren(); ui.textView.hidden = true;
    ui.textInput.value = item.text; ui.voiceSelect.value = voices.some((voice) => voice.id === item.voice) ? item.voice : 'af_heart';
    session.voice = ui.voiceSelect.value; renderVoice(); renderText(); savePreferences(); ui.appDialog.close();
  }));
});
ui.settingsBtn.addEventListener('click', () => {
  openPanel('Settings', `<div class="settings-form"><label>Default voice<select id="settingsVoice">${voices.map((voice) => { const info = voiceInfo(voice); return `<option value="${voice.id}" data-name="${voice.name}" data-meta="${info.display}" data-accessible="${info.accessible}" ${voice.id === session.voice ? 'selected' : ''}>${voice.name} ${info.display}</option>`; }).join('')}</select></label><label>Playback speed <select id="settingsRate">${rates.map((rate) => `<option value="${rate}" ${rate === session.rate ? 'selected' : ''}>${rate}×</option>`).join('')}</select></label><label>Volume <input id="settingsVolume" type="range" min="0" max="100" value="${Math.round(session.volume * 100)}" /></label><p class="dialog-copy">Preferences are saved locally in this browser.</p></div>`);
  enhanceSelect($('settingsVoice'));
  enhanceSelect($('settingsRate'));
  $('settingsVoice').addEventListener('change', (event) => { ui.voiceSelect.value = event.target.value; ui.voiceSelect.dispatchEvent(new Event('change')); });
  $('settingsRate').addEventListener('change', (event) => { ui.rateSelect.value = event.target.value; ui.rateSelect.dispatchEvent(new Event('change')); });
  $('settingsVolume').addEventListener('input', (event) => { ui.volumeSlider.value = event.target.value; ui.volumeSlider.dispatchEvent(new Event('input')); });
});
ui.helpBtn.addEventListener('click', () => openPanel('Help', '<div class="dialog-copy"><p>Paste or type text, choose a voice, then press Play. Kokoro generates speech locally on this device.</p><p><kbd>Space</kbd> Play or pause<br><kbd>←</kbd> / <kbd>→</kbd> Skip 15 seconds<br><kbd>Shift</kbd> + arrow Previous or next sentence</p><p>Model, voices, and runtime are served from EchoLink’s local files. Draft text clears on refresh; history and preferences stay in this browser.</p></div>'));
function escapeHtml(value) { return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]); }
ui.downloadBtn.addEventListener('click', () => {
  if (!session.chunks.length || session.generated !== session.chunks.length || session.chunks.some((chunk) => !chunk.buffer)) { notify('Wait until speech generation is complete to download the full audio.'); return; }
  downloadWav(session.chunks, preparedText);
});
function downloadWav(chunks, text) {
  const sampleCount = chunks.reduce((sum, chunk) => sum + chunk.buffer.length, 0);
  const bytes = new ArrayBuffer(44 + sampleCount * 2);
  const view = new DataView(bytes);
  const write = (offset, value) => [...value].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)));
  write(0, 'RIFF'); view.setUint32(4, 36 + sampleCount * 2, true); write(8, 'WAVE'); write(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, 24000, true); view.setUint32(28, 48000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); write(36, 'data'); view.setUint32(40, sampleCount * 2, true);
  let offset = 44;
  for (const chunk of chunks) for (const sample of chunk.buffer.getChannelData(0)) { const clipped = Math.max(-1, Math.min(1, sample)); view.setInt16(offset, clipped < 0 ? clipped * 32768 : clipped * 32767, true); offset += 2; }
  const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = `${safeFilename(text)}-${session.voice}.wav`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function safeFilename(text) { return (cleanEchoLinkText(text).trim().split(/\s+/).slice(0, 6).join('-').replace(/[^\p{L}\p{N}-]/gu, '').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'echolink-reading').toLowerCase(); }

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
  ui.editorCard.dataset.mode = 'reading';
  ui.textView.hidden = false;
}

async function startOrResume() {
  if (!modelReady) { notify('Kokoro is still getting ready. Play enables after the local voice check passes.'); return; }
  if (ui.textInput.value.trim() && (!session.chunks.length || ui.textInput.value !== preparedText)) {
    preparedText = ui.textInput.value;
    session.prepare(preparedText, { cleanFormatting: ui.cleanFormatting.checked });
    rememberReading(preparedText);
  }
  if (!session.chunks.length) { ui.textInput.focus(); notify('Paste or type something to read first.'); return; }
  showReadView(preparedText, session.chunks);
  try { await session.play(); }
  catch (error) { notify(`Audio playback could not start: ${error?.message || error}`); }
}
ui.editorPlayBtn.addEventListener('click', () => session.playing ? session.pause() : startOrResume());
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
ui.rateSelect.addEventListener('change', () => {
  session.setPlaybackRate(Number(ui.rateSelect.value));
  savePreferences();
});
ui.volumeSlider.addEventListener('input', () => { session.setVolume(Number(ui.volumeSlider.value) / 100); if (session.volume > 0) lastVolume = session.volume; savePreferences(); });
ui.muteBtn.addEventListener('click', () => {
  const muted = session.volume > 0;
  if (muted) lastVolume = session.volume;
  session.setVolume(muted ? 0 : lastVolume);
  ui.volumeSlider.value = Math.round(session.volume * 100); savePreferences();
});
function savePreferences() { writeLocal(preferencesKey, JSON.stringify({ rate: session.rate, volume: session.volume, lastVolume, voice: session.voice, cleanFormatting: ui.cleanFormatting.checked })); }
function renderTrack() {
  const text = preparedText || ui.textInput.value;
  if (!text.trim()) {
    ui.trackTitle.textContent = 'A moment for you';
    ui.trackSubtitle.textContent = 'Paste text to begin';
    return;
  }
  const words = wordCount(text);
  ui.trackTitle.textContent = text.trim().split(/\s+/).slice(0, 5).join(' ') + (words > 5 ? '…' : '');
  ui.trackSubtitle.textContent = `${words.toLocaleString()} ${words === 1 ? 'word' : 'words'} · ${preparedText ? `read by ${selectedVoice().name}` : 'ready to read'}`;
}
ui.scrubber.addEventListener('input', () => {
  scrubbing = true;
  const duration = session.duration;
  const target = duration * Number(ui.scrubber.value) / 1000;
  ui.elapsedTime.textContent = formatTime(target);
  ui.scrubProgress.style.width = `${ui.scrubber.value / 10}%`;
  ui.scrubber.parentElement.style.setProperty('--seek', `${ui.scrubber.value / 10}%`);
});
ui.scrubber.addEventListener('change', () => {
  session.seek(session.duration * Number(ui.scrubber.value) / 1000); scrubbing = false;
  if (session.playing && session.buffering) notify('Preparing your place…');
});
ui.textInput.addEventListener('scroll', () => {
  if (!ui.textView.hidden) ui.textView.scrollTop = ui.textInput.scrollTop;
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

function update(state = {}) {
  if (state.status === 'error') { lastStatus = 'error'; if (!state.sessionId) modelReady = false; ui.statusText.textContent = state.message || 'Something went wrong'; ui.statusLed.className = 'status-led error'; notify(state.message || 'Speech generation failed.'); }
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
  if (state.status === 'ready') { lastStatus = 'ready'; modelReady = true; ui.statusText.textContent = session.paused ? (session.chunks.length ? 'Paused' : 'Ready to listen') : (session.playing ? 'Playing' : 'Ready to listen'); ui.statusLed.className = session.playing ? 'status-led playing' : 'status-led'; }
  if (state.status === 'loading' || state.status === 'self-testing' || state.status === 'fallback') modelReady = false;
  ui.editorPlayBtn.disabled = !ui.textInput.value.trim() || !modelReady;
  ui.transportPlayBtn.disabled = !modelReady && !session.chunks.length;
  ui.engineSubtitle.textContent = state.engineName ? `${state.engineName} · ${state.backend || 'local'}${state.dtype ? ` · ${state.dtype.toUpperCase()}` : ''}` : (modelReady ? 'Local Kokoro ready' : 'Checking local speech modes…');
  ui.engineMode.textContent = state.engineMode ? `${state.engineMode} · ${state.backend || 'local'} ${state.dtype || ''}` : (modelReady ? 'Local voice self-test passed' : 'Local model · preparing');
  const order = state.engineOrder || [];
  const currentIndex = order.indexOf(state.engineId);
  ui.fallbackBtn.hidden = !modelReady || currentIndex < 0 || currentIndex >= order.length - 1;
  ui.deviceStatus.textContent = state.backend === 'wasm' ? 'Local CPU acceleration' : state.status === 'ready' ? 'WebGPU acceleration' : 'Checking device capabilities';
  ui.generationText.textContent = state.total && state.generated === state.total ? 'AUDIO READY' : (state.generated ? 'GENERATING SPEECH' : (state.status === 'loading' || state.status === 'self-testing' ? `LOADING MODEL · ${state.dtype?.toUpperCase() || 'LOCAL'}` : `KOKORO · ${state.dtype?.toUpperCase() || 'LOCAL'}`));
  ui.chunkCount.textContent = `${state.generated || 0} / ${state.total || 0}`;
  ui.generationProgress.style.width = `${state.total ? 100 * state.generated / state.total : (state.status === 'loading' ? '14' : '0')}%`;
  const buffered = Math.max(0, (state.chunks || []).reduce((sum, chunk) => sum + (chunk.buffer ? chunk.duration : 0), 0));
  ui.bufferStatus.textContent = buffered ? `${Math.floor(buffered / 60)}:${String(Math.floor(buffered % 60)).padStart(2,'0')}` : '—';
  const position = state.position ?? session.currentPosition();
  const duration = state.duration ?? session.duration;
  ui.elapsedTime.textContent = formatTime(position);
  ui.totalTime.textContent = duration ? formatTime(duration) : '0:00';
  if (!scrubbing) {
    const progress = duration ? Math.min(1000, Math.round(position / duration * 1000)) : 0;
    ui.scrubber.value = progress; ui.scrubProgress.style.width = `${progress / 10}%`;
    ui.scrubber.parentElement.style.setProperty('--seek', `${progress / 10}%`);
  }
  ui.rateSelect.value = String(session.rate);
  ui.muteBtn.classList.toggle('muted', session.volume === 0);
  ui.transportPlayBtn.classList.toggle('is-playing', state.playing);
  ui.transportPlayBtn.setAttribute('aria-label', state.playing ? 'Pause' : 'Play');
  ui.editorPlayBtn.textContent = state.playing ? 'Pause' : 'Play';
  ui.editorPlayBtn.disabled = !ui.textInput.value.trim() || !modelReady;
  ui.transportPlayBtn.firstElementChild.innerHTML = state.playing
    ? '<svg viewBox="0 0 24 24"><path d="M7 5h4v14H7zM15 5h4v14h-4z"/></svg>'
    : '<svg viewBox="0 0 24 24"><path d="m8 5 12 7-12 7V5Z"/></svg>';
  ui.trackWave.classList.toggle('active', !!state.playing);
  ui.downloadBtn.disabled = !session.chunks.length || session.generated !== session.chunks.length || session.chunks.some((chunk) => !chunk.buffer);
  if (preparedText) renderTrack();
  const active = (state.chunks || []).findIndex((chunk) => position >= chunk.start && position < chunk.end);
  if (active !== lastHighlight && active < 0) { viewSpans[lastHighlight]?.classList.remove('active'); lastHighlight = -1; }
  if (active !== lastHighlight && active >= 0 && viewSpans[active]) {
    viewSpans[lastHighlight]?.classList.remove('active');
    viewSpans[active].classList.add('active'); lastHighlight = active;
    const rect = viewSpans[active].getBoundingClientRect();
    const area = ui.textInput.getBoundingClientRect();
    if (rect.top < area.top || rect.bottom > area.bottom) {
      ui.textInput.scrollTop += rect.top < area.top ? rect.top - area.top : rect.bottom - area.bottom;
      ui.textView.scrollTop = ui.textInput.scrollTop;
    }
  }
}
setInterval(() => { if (session.playing) update({ position: session.currentPosition(), duration: session.duration, playing: true, chunks: session.chunks, generated: session.generated, total: session.chunks.length, cursor: session.cursor }); }, 120);
