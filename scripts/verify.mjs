import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(fs.readFileSync(path.join(root, 'server.port'), 'utf8').trim());
const origin = `http://127.0.0.1:${port}`;
const voiceIds = ['af_heart', 'af_jessica', 'af_nicole', 'af_sky', 'am_adam', 'am_onyx', 'am_santa', 'bf_alice', 'bf_emma', 'bm_daniel', 'bm_lewis'];
const screenshotDir = path.join(root, 'output', 'playwright', 'verification');
const results = [];
let serverStarted = false;
let browser;
let context;

function pass(name, detail = '') {
  results.push({ name, ok: true, detail });
  console.log(`PASS  ${name}${detail ? ` — ${detail}` : ''}`);
}

function fail(name, detail) {
  results.push({ name, ok: false, detail });
  throw new Error(`${name}: ${detail}`);
}

function check(condition, name, detail) {
  if (!condition) fail(name, detail);
  pass(name, detail);
}

function powershell(action) {
  const result = spawnSync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(root, 'server-control.ps1'), '-Action', action,
  ], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 15000 });
  if (result.error) throw result.error;
  return { code: result.status ?? 1, output: `${result.stdout || ''}${result.stderr || ''}`.trim() };
}

function waitForPort(timeoutMs = 8000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const attempt = () => {
      const socket = net.connect({ host: '127.0.0.1', port });
      socket.setTimeout(300);
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() - started >= timeoutMs) resolve(false);
        else setTimeout(attempt, 125);
      });
      socket.once('timeout', () => {
        socket.destroy();
        if (Date.now() - started >= timeoutMs) resolve(false);
        else setTimeout(attempt, 125);
      });
    };
    attempt();
  });
}

async function waitFor(page, expression, description, timeout = 600000) {
  try {
    await page.waitForFunction(expression, null, { timeout, polling: 250 });
  } catch {
    const info = await page.evaluate(() => ({
      status: document.querySelector('#statusText')?.textContent,
      generation: document.querySelector('#generationText')?.textContent,
      chunks: document.querySelector('#chunkCount')?.textContent,
      worker: window.__echolinkVerify?.messages?.slice(-6),
    })).catch(() => ({}));
    fail(description, `timed out; current browser state: ${JSON.stringify(info)}`);
  }
}

async function captureState(page, name) {
  fs.mkdirSync(screenshotDir, { recursive: true });
  await page.screenshot({ path: path.join(screenshotDir, `${name}.png`), animations: 'disabled' });
}

async function chooseMenuOption(page, selectId, value) {
  await page.locator(`#${selectId}MenuButton`).click();
  await page.locator(`#${selectId}MenuList [role="option"][data-value="${value}"]`).click();
}

async function verify() {
  const build = spawnSync(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), 'build'], {
    cwd: root, encoding: 'utf8', windowsHide: true, timeout: 180000,
  });
  if (build.error || build.status !== 0) fail('Production build', build.error?.message || `${build.stdout || ''}${build.stderr || ''}`.trim());
  pass('Production build', 'current source compiled into dist/');
  check(Number.isInteger(port) && port >= 1024 && port <= 65535, 'Configured port', String(port));
  const required = [
    ['index.html', 1000],
    ['server.mjs', 1000],
    ['server-control.ps1', 1000],
    ['vendor/kokoro.js', 10000],
    ['dist/index.html', 1000],
    ['dist/images/echolink-copper-logo.png', 100000],
    ['dist/images/twilight-mountain-valley.png', 100000],
    ['dist/images/cosmic-alpine-lake-at-dusk.png', 100000],
    ...voiceIds.map((voiceId) => [`dist/tts/voices/${voiceId}.bin`, 500000]),
    ['dist/tts/runtime/ort-wasm-simd-threaded.jsep.wasm', 1000000],
    ['dist/tts/runtime/ort-wasm-simd-threaded.jsep.mjs', 10000],
    ['dist/tts/runtime/ort-wasm-simd-threaded.wasm', 1000000],
    ['dist/tts/runtime/ort-wasm-simd-threaded.mjs', 10000],
    ['dist/models/onnx-community/Kokoro-82M-v1.0-ONNX/config.json', 30],
    ['dist/models/onnx-community/Kokoro-82M-v1.0-ONNX/tokenizer.json', 1000],
    ['dist/models/onnx-community/Kokoro-82M-v1.0-ONNX/tokenizer_config.json', 50],
    ['dist/models/onnx-community/Kokoro-82M-v1.0-ONNX/onnx/model.onnx', 200_000_000],
  ];
  const missing = required.filter(([file, min]) => !fs.existsSync(path.join(root, file)) || fs.statSync(path.join(root, file)).size < min);
  const outputAssets = fs.readdirSync(path.join(root, 'dist/assets'));
  for (const [name, pattern] of [['application JS', /^index-.*\.js$/], ['application CSS', /^index-.*\.css$/], ['module worker', /^tts-worker-.*\.js$/]]) {
    if (!outputAssets.some((file) => pattern.test(file))) missing.push([`dist/assets/${name}`, 1]);
  }
  check(missing.length === 0, 'Bundled app, model, voice, and runtime assets', missing.length ? `missing or undersized: ${missing.map(([file]) => file).join(', ')}` : `${required.length + 3} required files are present and sized plausibly`);

  const workerSource = fs.readFileSync(path.join(root, 'src/tts-worker.js'), 'utf8');
  const appSource = fs.readFileSync(path.join(root, 'src/main.js'), 'utf8');
  check(workerSource.includes("let selectedVoice = 'af_heart'") && workerSource.includes('voice: task.voice || selectedVoice') && workerSource.includes("device: 'webgpu'") && workerSource.includes('allowRemoteModels = false'), 'Heart default/WebGPU/local-only configuration', 'worker defaults to af_heart, accepts the selected voice, and disables remote model downloads');
  check(voiceIds.every((voiceId) => fs.readFileSync(path.join(root, 'src/main.js'), 'utf8').includes(`'${voiceId}'`)), 'Requested voices are selectable', `${voiceIds.length} unique requested voice IDs are configured`);
  check(appSource.includes("'previousBtn','nextBtn','backBtn','forwardBtn'") && appSource.includes("'rateSelect','volumeSlider','muteBtn','scrubber'"), 'Playback controls are wired', 'navigation, skip, speed selection, volume, and scrubber are connected');

  const oldServer = powershell('Stop');
  if (oldServer.code !== 0) fail('Port safety preflight', oldServer.output || `Stop returned ${oldServer.code}; refusing to disturb a possible unrelated listener`);
  check(!(await waitForPort(400)), 'Port starts free', `TCP ${port} has no listener before launch`);

  const started = powershell('Start');
  if (started.code !== 0) fail('Server launch', started.output || `Start returned ${started.code}`);
  serverStarted = true;
  check(await waitForPort(), 'Server opens configured port', `TCP ${port} accepted a loopback connection`);
  const response = await fetch(`${origin}/`);
  check(response.ok, 'Local page response', `GET / returned HTTP ${response.status}`);

  const browserPaths = [
    process.env.ECHOLINK_BROWSER_PATH,
    path.join(process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe'),
    path.join(process.env.ProgramFiles || 'C:/Program Files', 'Microsoft/Edge/Application/msedge.exe'),
    path.join(process.env.ProgramFiles || 'C:/Program Files', 'Google/Chrome/Application/chrome.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)', 'Google/Chrome/Application/chrome.exe'),
  ].filter(Boolean);
  const browserPath = browserPaths.find((candidate) => fs.existsSync(candidate));
  if (!browserPath) fail('Browser availability', 'Install Microsoft Edge or Chrome, or set ECHOLINK_BROWSER_PATH to its executable.');
  browser = await chromium.launch({ executablePath: browserPath, headless: true, args: ['--enable-unsafe-webgpu'] });
  pass('Browser launch', path.basename(browserPath));
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const blockedExternal = new Set();
  const responses = [];
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.origin === origin) return route.continue();
    blockedExternal.add(url.href);
    return route.abort('internetdisconnected');
  });
  await context.addInitScript(() => {
    window.__echolinkVerify = { messages: [], audio: [], sourceStarts: [] };
    const originalAdd = Worker.prototype.addEventListener;
    Worker.prototype.addEventListener = function(type, listener, options) {
      if (type !== 'message') return originalAdd.call(this, type, listener, options);
      const wrapped = (event) => {
        const data = event.data || {};
        window.__echolinkVerify.messages.push({ type: data.type, status: data.status, message: data.message, progress: data.progress?.file });
        if (data.type === 'audio' && data.samples instanceof Float32Array) {
          const samples = data.samples;
          let finite = 0, nonzero = 0, peak = 0;
          for (let i = 0; i < samples.length; i++) {
            const value = samples[i];
            if (Number.isFinite(value)) finite++;
            if (value !== 0) nonzero++;
            peak = Math.max(peak, Math.abs(value));
          }
          window.__echolinkVerify.audio.push({ index: data.index, voice: data.voice, sampleCount: samples.length, finite, nonzero, peak });
        }
        listener.call(this, event);
      };
      return originalAdd.call(this, type, wrapped, options);
    };
    const start = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function(...args) {
      window.__echolinkVerify.sourceStarts.push({ duration: this.buffer?.duration || 0, sampleRate: this.buffer?.sampleRate || 0, channels: this.buffer?.numberOfChannels || 0 });
      return start.apply(this, args);
    };
  });
  const page = await context.newPage();
  const pageErrors = [];
  const consoleErrors = [];
  const runtimeWarnings = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    if (text.includes('[W:onnxruntime:')) runtimeWarnings.push(text);
    else consoleErrors.push(text);
  });
  page.on('response', (item) => responses.push({ url: item.url(), status: item.status() }));
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.origin !== origin) blockedExternal.add(url.href);
  });

  await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  check((await page.title()).includes('EchoLink'), 'Application page renders', await page.title());
  const favicon = await page.locator('link[rel="icon"]').getAttribute('href');
  const faviconUrl = new URL(favicon, origin);
  const faviconResponse = await fetch(faviconUrl);
  check(faviconUrl.pathname === '/favicon.svg' && faviconResponse.ok && (faviconResponse.headers.get('content-type') || '').includes('image/svg+xml'), 'EchoLink waveform favicon is served locally', `${faviconUrl.pathname} returned HTTP ${faviconResponse.status}`);
  check((await page.locator('.brand').getAttribute('aria-label')) === 'EchoLink home' && /echolink/i.test(await page.locator('.brand').innerText()), 'EchoLink branding renders', 'logo and accessible name use the new app name');
  const initialVoices = await page.locator('#voiceSelect option').evaluateAll((items) => items.map((item) => item.value));
  check(JSON.stringify(initialVoices) === JSON.stringify(voiceIds), 'Requested voice list renders', `${initialVoices.length} unique options in the requested order`);
  check(await page.locator('#voiceSelect').inputValue() === 'af_heart' && (await page.locator('#sideVoice').innerText()).includes('Heart'), 'Heart remains the default voice', 'af_heart is selected on a fresh profile');
  check((await page.locator('#voiceSelect option').first().innerText()).includes('🇺🇸') && !(await page.locator('#voiceSelect option').first().innerText()).includes('('), 'Voice labels use compact country and gender cues', await page.locator('#voiceSelect option').first().innerText());
  await page.locator('#voiceSelectMenuButton').click();
  check(await page.locator('#voiceSelectMenuList').isVisible() && await page.locator('#voiceSelectMenuList [role="option"]').count() === 11, 'Themed voice menu opens with every voice', 'custom glass listbox replaces the browser dropdown');
  await captureState(page, '11-voice-menu');
  await page.keyboard.press('Escape');
  await page.locator('#rateSelectMenuButton').click();
  check(await page.locator('#rateSelectMenuList').isVisible() && await page.locator('#rateSelectMenuList [role="option"]').count() === 8, 'Themed playback speed menu opens', 'speed choices use the same glass menu treatment');
  await captureState(page, '12-speed-menu');
  await page.keyboard.press('Escape');
  await page.locator('#rateSelectMenuButton').focus();
  await page.keyboard.press('ArrowDown');
  check(await page.locator('#rateSelectMenuButton').getAttribute('aria-expanded') === 'true', 'Dropdowns support keyboard opening', 'Arrow Down opens the focused speed menu');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => [...document.querySelectorAll('.artwork .mountain-art')].every((image) => image.complete));
  const visualAssets = await page.locator('.artwork .mountain-art').evaluateAll((images) => images.map(({ currentSrc, naturalWidth }) => ({ path: new URL(currentSrc).pathname, naturalWidth })));
  check(visualAssets.length === 1 && visualAssets.every(({ naturalWidth }) => naturalWidth > 0), 'Local mountain artwork renders', visualAssets.map(({ path, naturalWidth }) => `${path} (${naturalWidth}px)`).join(', '));
  const background = await page.evaluate(() => getComputedStyle(document.body).backgroundImage);
  check(background.includes('/images/cosmic-alpine-lake-at-dusk.png'), 'Space background artwork loads locally', 'mountain and planet background is served from the project image folder');
  await waitFor(page, () => window.__echolinkVerify.messages.some((m) => m.type === 'status' && m.status === 'loading'), 'Kokoro loading state is reported', 30000);
  check((await page.locator('#statusLed').getAttribute('class')).includes('loading'), 'Model loading state is visible', await page.locator('#statusText').innerText());
  await captureState(page, '00-model-loading');
  await waitFor(page, () => window.__echolinkVerify.messages.some((m) => m.type === 'status' && m.status === 'ready'), 'Kokoro initializes from local assets');
  await captureState(page, '01-empty');
  const requiredLocalRequests = [
    '/tts/voices/af_heart.bin',
    '/models/onnx-community/Kokoro-82M-v1.0-ONNX/onnx/model.onnx',
    '/models/onnx-community/Kokoro-82M-v1.0-ONNX/tokenizer.json',
    '/models/onnx-community/Kokoro-82M-v1.0-ONNX/tokenizer_config.json',
    '/models/onnx-community/Kokoro-82M-v1.0-ONNX/config.json',
  ];
  const seenUrls = responses.map((item) => new URL(item.url).pathname);
  const missingRequests = requiredLocalRequests.filter((url) => !seenUrls.includes(url));
  check(missingRequests.length === 0, 'Kokoro model and Heart voice load over loopback', missingRequests.length ? `not requested: ${missingRequests.join(', ')}` : `${requiredLocalRequests.length} required TTS assets returned through the local server`);
  const requiredRuntime = seenUrls.filter((url) => url.startsWith('/tts/runtime/'));
  check(requiredRuntime.some((url) => url.endsWith('.wasm')) && requiredRuntime.some((url) => url.endsWith('.mjs')), 'ONNX runtime loads locally', requiredRuntime.join(', '));

  const shortText = 'This is a short offline Kokoro verification sentence.';
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
  await page.evaluate((text) => navigator.clipboard.writeText(text), shortText);
  await page.locator('#pasteBtn').click();
  await page.waitForFunction((text) => document.querySelector('#textInput')?.value === text, shortText, { timeout: 5000 });
  check(await page.locator('#textInput').inputValue() === shortText, 'Paste text works', 'clipboard text entered through the Paste control');
  check((await page.locator('#trackSubtitle').innerText()).includes('ready to read'), 'Idle text is reflected in the player card', 'word count and ready-to-read state update before playback');
  await captureState(page, '02-text-idle');
  await page.locator('#transportPlayBtn').click();
  await waitFor(page, () => window.__echolinkVerify.audio.length >= 1, 'Short sentence synthesis', 180000);
  await waitFor(page, () => window.__echolinkVerify.sourceStarts.length >= 1, 'Short sentence playback starts', 30000);
  await captureState(page, '03-playing');
  const shortAudio = await page.evaluate(() => window.__echolinkVerify.audio[0]);
  check(shortAudio.sampleCount > 1000 && shortAudio.finite === shortAudio.sampleCount && shortAudio.nonzero > 0 && shortAudio.peak > 0, 'Synthesized audio is non-empty and valid', `${shortAudio.sampleCount} float samples, ${shortAudio.nonzero} non-zero, peak ${shortAudio.peak.toFixed(4)}`);
  check(shortAudio.voice === 'af_heart', 'Default Heart selection reaches Kokoro synthesis', `worker used ${shortAudio.voice}`);
  const firstSource = await page.evaluate(() => window.__echolinkVerify.sourceStarts[0]);
  check(firstSource.duration > 0 && firstSource.sampleRate === 24000 && firstSource.channels === 1, 'Audio enters Web Audio playback', `${firstSource.duration.toFixed(2)}s mono at ${firstSource.sampleRate}Hz`);
  check(!(await page.locator('#downloadBtn').isDisabled()), 'Download enables after full synthesis', 'complete Heart audio is ready for export');
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#downloadBtn').click();
  const download = await downloadPromise;
  const downloadPath = path.join(screenshotDir, 'smoke-audio.wav');
  await download.saveAs(downloadPath);
  const wav = fs.readFileSync(downloadPath);
  check(wav.length > 1000 && wav.subarray(0, 4).toString() === 'RIFF' && wav.subarray(8, 12).toString() === 'WAVE' && wav.readUInt32LE(40) === wav.length - 44, 'Downloaded audio is a valid non-empty WAV', `${download.suggestedFilename()} · ${wav.length.toLocaleString()} bytes`);
  await page.locator('#historyBtn').click();
  check((await page.locator('#dialogTitle').innerText()) === 'Reading history' && await page.locator('.history-item').count() > 0, 'History stores the current reading locally', 'recent generated session is listed');
  await captureState(page, '07-history');
  await page.locator('.history-item').first().click();
  check(await page.locator('#textInput').inputValue() === shortText, 'History restores a previous reading', 'stored text returns to the editor');
  await page.locator('#settingsBtn').click();
  check((await page.locator('#dialogTitle').innerText()) === 'Settings' && await page.locator('#settingsVoice').inputValue() === 'af_heart', 'Settings reflect persistent defaults', 'Heart and current speed/volume are shown');
  await captureState(page, '08-settings');
  await page.locator('#settingsVoiceMenuButton').click();
  check(await page.locator('#settingsVoiceMenuList').isVisible(), 'Settings voice menu uses the themed selector', 'the persistent preference uses the same custom control');
  await captureState(page, '13-settings-voice-menu');
  await page.keyboard.press('Escape');
  await chooseMenuOption(page, 'settingsVoice', 'af_sky');
  await chooseMenuOption(page, 'settingsRate', '1.25');
  await page.locator('#settingsVolume').evaluate((el) => { el.value = '66'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  check(await page.locator('#voiceSelect').inputValue() === 'af_sky' && await page.locator('#rateSelect').inputValue() === '1.25' && await page.locator('#volumeSlider').inputValue() === '66', 'Settings update persistent reader preferences', 'voice, speed, and volume apply to the reader');
  await chooseMenuOption(page, 'settingsVoice', 'af_heart');
  await chooseMenuOption(page, 'settingsRate', '1');
  await page.locator('#settingsVolume').evaluate((el) => { el.value = '82'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.locator('.dialog-close').click();
  await page.locator('#helpBtn').click();
  check((await page.locator('#dialogTitle').innerText()) === 'Help' && (await page.locator('#dialogContent').innerText()).includes('locally'), 'Help describes shortcuts and local use', 'compact local usage panel opens');
  await captureState(page, '09-help');
  await page.locator('.dialog-close').click();
  await page.locator('#transportPlayBtn').click();
  await page.waitForFunction(() => !document.querySelector('#textView')?.hidden && document.querySelector('#transportPlayBtn')?.getAttribute('aria-label') === 'Pause');
  await page.locator('#editBtn').click();
  check(await page.locator('#textInput').isVisible() && await page.locator('#readerMode').innerText() === 'EDITOR', 'Edit mode is explicit', 'read view pauses and returns to the editor');
  await page.locator('#transportPlayBtn').click();
  await page.waitForFunction(() => !document.querySelector('#textView')?.hidden && document.querySelector('#transportPlayBtn')?.getAttribute('aria-label') === 'Pause');
  check(await page.locator('#readerMode').innerText() === 'NOW READING', 'Resume restores spoken-text view', 'resuming unchanged text restores highlighting and reading mode');
  check(blockedExternal.size === 0, 'No internet requests during offline initialization and synthesis', 'all browser requests were restricted to the loopback origin');

  await page.locator('#stopBtn').click();
  await chooseMenuOption(page, 'voiceSelect', 'af_jessica');
  check((await page.locator('#sideVoice').innerText()).includes('Jessica'), 'Voice selection updates the reader', 'Jessica is shown as the active voice');
  await captureState(page, '10-alternate-voice');
  await page.locator('#editBtn').click();
  await page.locator('#textInput').fill('Jessica is speaking a local voice selection check.');
  await page.locator('#transportPlayBtn').click();
  await waitFor(page, () => window.__echolinkVerify.audio.some((item) => item.voice === 'af_jessica'), 'Alternate voice synthesizes offline', 180000);
  await waitFor(page, () => window.__echolinkVerify.sourceStarts.length >= 2, 'Alternate voice starts playback', 30000);
  check(responses.some((item) => new URL(item.url).pathname === '/tts/voices/af_jessica.bin' && item.status === 200), 'Alternate voice embedding loads locally', 'af_jessica.bin returned HTTP 200 from loopback');

  const paragraphs = Array.from({ length: 10 }, (_, index) =>
    `Section ${index + 1}. This progressive playback check keeps the interface responsive while Kokoro creates each local audio segment. Seeking should move to this passage and continue after the requested segment is ready. The reader should keep its place and highlight the spoken text.`);
  const longText = paragraphs.join('\n\n');
  await page.locator('#stopBtn').click();
  await chooseMenuOption(page, 'voiceSelect', 'af_heart');
  await page.locator('#editBtn').click();
  await page.locator('#textInput').fill(longText);
  await page.locator('#transportPlayBtn').click();
  await waitFor(page, () => document.querySelectorAll('#textView .speech-chunk').length >= 8, 'Long text is split into navigable chunks', 10000);
  await waitFor(page, () => {
    const [generated, total] = (document.querySelector('#chunkCount')?.textContent || '').split('/').map((s) => Number(s.trim()));
    return generated > 0 && generated < total;
  }, 'Progressive speech generation begins', 180000);
  const totalChunks = Number((await page.locator('#chunkCount').innerText()).split('/')[1].trim());
  const uiResponsive = await Promise.race([
    page.evaluate(() => ({ title: document.title, chunks: document.querySelectorAll('#textView .speech-chunk').length })),
    new Promise((resolve) => setTimeout(() => resolve(null), 1000)),
  ]);
  check(uiResponsive !== null && uiResponsive.chunks >= 8, 'Long generation does not freeze the UI', `${uiResponsive?.chunks} chunks remain interactive during generation`);
  const beforeSeek = await page.locator('#chunkCount').innerText();
  const scrubber = page.locator('#scrubber');
  await scrubber.evaluate((el) => {
    el.value = '950';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  const selectedDuringGeneration = await page.evaluate(() => document.querySelector('#textView .speech-chunk.active')?.dataset.index ?? null);
  check(Number(selectedDuringGeneration) >= 1 && Number(selectedDuringGeneration) < totalChunks, 'Seek into an ungenerated section', `selected chunk ${selectedDuringGeneration} while generation was ${beforeSeek}`);
  await waitFor(page, () => window.__echolinkVerify.audio.some((item) => item.index >= Number(document.querySelector('#chunkCount')?.textContent.split('/')[1].trim()) - 1), 'Requested later section synthesizes', 300000);
  await waitFor(page, () => {
    const total = Number(document.querySelector('#chunkCount')?.textContent.split('/')[1].trim());
    const active = Number(document.querySelector('#textView .speech-chunk.active')?.dataset.index ?? -1);
    return active >= total - 2 && document.querySelector('#transportPlayBtn')?.getAttribute('aria-label') === 'Pause';
  }, 'Playback reaches the requested not-yet-generated section', 30000);
  check(blockedExternal.size === 0, 'Offline synthesis remains local', 'browser routing denied internet access while allowing the loopback server');
  await waitFor(page, () => {
    const [generated, total] = (document.querySelector('#chunkCount')?.textContent || '').split('/').map((s) => Number(s.trim()));
    return generated === total && total >= 8;
  }, 'Long passage finishes generating', 600000);
  const durationText = await page.locator('#totalTime').innerText();
  const durationParts = durationText.split(':').map(Number);
  const durationSeconds = durationParts.length === 2 ? durationParts[0] * 60 + durationParts[1] : durationParts[0];
  check(durationSeconds > 30, 'Long passage has usable seek range', `${totalChunks} chunks, ${durationText} total`);

  const generatedAudio = await page.evaluate(() => window.__echolinkVerify.audio);
  check(generatedAudio.length >= totalChunks && generatedAudio.every((item) => item.sampleCount > 1000 && item.finite === item.sampleCount && item.nonzero > 0), 'All progressive chunks contain valid generated audio', `${generatedAudio.length} audio chunks captured from the worker`);
  const liveHighlights = await page.locator('#textView .speech-chunk.active').count();
  check(liveHighlights === 1, 'Spoken text highlighting is active', 'exactly one reading chunk is highlighted during playback');

  const playButton = page.locator('#transportPlayBtn');
  if (await playButton.getAttribute('aria-label') === 'Pause') await playButton.click();
  await page.waitForFunction(() => document.querySelector('#transportPlayBtn')?.getAttribute('aria-label') === 'Play');
  check(true, 'Pause works', 'transport changed to Play while paused');
  await captureState(page, '04-paused');
  await playButton.click();
  await page.waitForFunction(() => document.querySelector('#transportPlayBtn')?.getAttribute('aria-label') === 'Pause');
  check(true, 'Resume works', 'transport resumed playback');
  await playButton.click();
  await page.waitForFunction(() => document.querySelector('#transportPlayBtn')?.getAttribute('aria-label') === 'Play');

  await page.locator('#restartBtn').click();
  await page.locator('#nextBtn').click();
  await page.waitForFunction(() => document.querySelector('#textView .speech-chunk.active')?.dataset.index === '1');
  check(true, 'Next chunk navigation works', 'active highlight moved to chunk 2');
  await page.locator('#previousBtn').click();
  await page.waitForFunction(() => document.querySelector('#textView .speech-chunk.active')?.dataset.index === '0');
  check(true, 'Previous chunk navigation works', 'active highlight returned to chunk 1');
  await page.locator('#forwardBtn').click();
  const forwarded = await page.locator('#elapsedTime').innerText();
  check(forwarded !== '0:00', '15-second forward works', `position is ${forwarded}`);
  await page.locator('#backBtn').click();
  const backward = await page.locator('#elapsedTime').innerText();
  check(backward === '0:00', '15-second back works', `position returned to ${backward}`);
  await scrubber.evaluate((el) => {
    el.value = '800';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  const scrubbed = await page.locator('#elapsedTime').innerText();
  check(scrubbed !== '0:00' && Number(await scrubber.inputValue()) >= 790, 'Scrubbing works', `seek position ${scrubbed}, slider ${await scrubber.inputValue()}/1000`);
  const seekHandle = await page.locator('.scrub-wrap').evaluate((el) => getComputedStyle(el).getPropertyValue('--seek').trim());
  check(Number.parseFloat(seekHandle) >= 79, 'Scrubber handle follows the seek position', `handle is at ${seekHandle}`);
  const activeAfterGeneratedSeek = Number(await page.locator('#textView .speech-chunk.active').getAttribute('data-index'));
  check(Number.isInteger(activeAfterGeneratedSeek) && activeAfterGeneratedSeek >= 0 && activeAfterGeneratedSeek < totalChunks, 'Seek into an already-generated section', `active chunk ${activeAfterGeneratedSeek} of ${totalChunks}`);
  await chooseMenuOption(page, 'rateSelect', '1.1');
  check(await page.locator('#rateSelect').inputValue() === '1.1', 'Playback speed selector works', 'speed was explicitly selected as 1.1x');
  await page.locator('#volumeSlider').evaluate((el) => {
    el.value = '37';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  check(await page.locator('#volumeSlider').inputValue() === '37', 'Volume slider works', 'volume changed to 37%');
  await page.locator('#muteBtn').click();
  check((await page.locator('#muteBtn').getAttribute('class')).includes('muted'), 'Mute works', 'mute state is reflected in the control');
  await page.locator('#muteBtn').click();
  check(!(await page.locator('#muteBtn').getAttribute('class')).includes('muted'), 'Unmute works', 'volume is restored');
  await page.locator('#stopBtn').click();
  check((await page.locator('#chunkCount').innerText()).trim() === '0 / 0' && (await playButton.getAttribute('aria-label')) === 'Play', 'Stop works', 'generated session cleared and playback stopped');
  await page.locator('#editBtn').click();
  await page.locator('#clearBtn').click();
  const clearedState = await page.evaluate(() => ({
    text: document.querySelector('#textInput')?.value,
    editorVisible: !document.querySelector('#textInput')?.hidden,
    readViewHidden: document.querySelector('#textView')?.hidden,
    placeholderVisible: !document.querySelector('#placeholder')?.hidden,
    scrubber: document.querySelector('#scrubber')?.value,
    elapsed: document.querySelector('#elapsedTime')?.textContent,
    trackTitle: document.querySelector('#trackTitle')?.textContent,
    timeline: document.querySelector('#chunkCount')?.textContent,
    mode: document.querySelector('#editorCard')?.dataset.mode,
  }));
  check(clearedState.text === '' && clearedState.editorVisible && clearedState.readViewHidden && clearedState.placeholderVisible && clearedState.mode === 'edit', 'Clear restores the empty editor state', 'placeholder and empty editor are visible without stale reading content');
  check(clearedState.scrubber === '0' && clearedState.elapsed === '0:00' && clearedState.timeline?.trim() === '0 / 0' && clearedState.trackTitle === 'A moment for you', 'Clear resets player and track state', JSON.stringify(clearedState));
  await captureState(page, '05-cleared');

  const responsiveLayouts = [];
  for (const [width, height] of [[1440, 1000], [1024, 900], [820, 900], [390, 844]]) {
    await page.setViewportSize({ width, height });
    responsiveLayouts.push(await page.evaluate(() => {
      const box = (selector) => document.querySelector(selector).getBoundingClientRect();
      return {
        width: innerWidth,
        documentWidth: document.documentElement.scrollWidth,
        editorBottom: box('.editor-card').bottom,
        playerTop: box('.player').top,
        scrubBottom: box('.scrub-wrap').bottom,
        playTop: box('#transportPlayBtn').top,
        playerChildrenFit: [...document.querySelector('.player').children].every((child) => {
          const inner = child.getBoundingClientRect(), outer = box('.player');
          return inner.left >= outer.left && inner.right <= outer.right;
        }),
      };
    }));
  }
  const responsiveFit = responsiveLayouts.every((layout) => layout.documentWidth <= layout.width && layout.editorBottom <= layout.playerTop + 1 && layout.playTop >= layout.scrubBottom && layout.playerChildrenFit);
  check(responsiveFit, 'Responsive layouts fit above the persistent player', JSON.stringify(responsiveLayouts));
  await captureState(page, '06-mobile-empty');

  check(pageErrors.length === 0, 'No uncaught JavaScript errors', pageErrors.length ? pageErrors.join(' | ') : 'none observed');
  check(consoleErrors.length === 0, 'No browser console errors', consoleErrors.length ? consoleErrors.join(' | ') : 'none observed');
  if (runtimeWarnings.length) pass('ONNX Runtime warnings are non-fatal', `${runtimeWarnings.length} execution-provider placement warning(s); synthesis and audio playback succeeded`);
  check(blockedExternal.size === 0, 'No external network dependency', 'zero external URLs requested while network access was denied');
}

try {
  await verify();
} catch (error) {
  results.push({ name: 'Verification run', ok: false, detail: error.message });
  console.error(`FAIL  ${error.message}`);
} finally {
  if (context) await context.close().catch(() => {});
  if (browser) await browser.close().catch(() => {});
  if (serverStarted) {
    const stopped = powershell('Stop');
    if (stopped.code === 0 && !(await waitForPort(500))) pass('Server stop releases the port', `TCP ${port} is free`);
    else results.push({ name: 'Server stop releases the port', ok: false, detail: stopped.output || 'listener remains' });
    serverStarted = false;
  }
  const restarted = powershell('Start');
  if (restarted.code === 0 && await waitForPort()) {
    pass('Server starts again after Stop', restarted.output.replace(/\s+/g, ' '));
    const response = await fetch(`${origin}/`).catch(() => null);
    if (response?.ok) pass('Restarted server responds', `HTTP ${response.status}`);
    else results.push({ name: 'Restarted server responds', ok: false, detail: `HTTP ${response?.status ?? 'unreachable'}` });
    const finalStop = powershell('Stop');
    if (finalStop.code === 0 && !(await waitForPort(500))) pass('Final cleanup releases the port', `TCP ${port} is free`);
    else results.push({ name: 'Final cleanup releases the port', ok: false, detail: finalStop.output || 'listener remains' });
  } else {
    results.push({ name: 'Server starts again after Stop', ok: false, detail: restarted.output || 'listener did not return' });
    powershell('Stop');
  }
}

const passed = results.filter((item) => item.ok).length;
const failed = results.length - passed;
console.log(`\nVerification summary: ${passed} PASS, ${failed} FAIL`);
for (const result of results.filter((item) => !item.ok)) console.log(`FAIL  ${result.name} — ${result.detail}`);
if (failed) process.exitCode = 1;
