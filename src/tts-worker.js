import { KokoroTTS, env as kokoroEnv } from '../vendor/kokoro.js';
import { env as transformersEnv } from '@huggingface/transformers';
import { validateEchoLinkAudioQuality } from './audioQuality.js';

const MODEL_PATH = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const VOICE_DEFAULT = 'af_heart';
const ENGINE_STRATEGIES = [
  { id: 'webgpu-fp32', name: 'Full', description: 'High quality · WebGPU', dtype: 'fp32', backend: 'webgpu', mode: 'High quality' },
  { id: 'wasm-fp32', name: 'Compatibility', description: 'High quality · compatibility', dtype: 'fp32', backend: 'wasm', mode: 'High quality' },
  { id: 'wasm-q8', name: 'Compact', description: 'Compact · lower memory', dtype: 'q8', backend: 'wasm', mode: 'Compact' },
];

let engine = null;
let engineStrategy = null;
let engineStrategies = [];
let initialization = null;
let cancelled = new Set();
let queue = [];
let draining = false;
let sessionId = 0;
let selectedVoice = VOICE_DEFAULT;
let compactDevice = false;
let capabilities = null;

const send = (type, data = {}) => self.postMessage({ type, ...data });

function withTimeout(promise, label, timeoutMs = 15000) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs / 1000}s.`)), timeoutMs); }),
  ]).finally(() => clearTimeout(timer));
}

async function inspectCapabilities() {
  const secureContext = self.isSecureContext === true;
  const webgpuAvailable = Boolean(self.navigator?.gpu);
  let adapterAvailable = false;
  let deviceAvailable = false;
  let adapterError = '';
  if (secureContext && webgpuAvailable) {
    try {
      send('diagnostic', { phase: 'request-adapter' });
      const adapter = await withTimeout(navigator.gpu.requestAdapter(), 'WebGPU adapter request');
      adapterAvailable = Boolean(adapter);
      if (adapter) {
        send('diagnostic', { phase: 'request-device' });
        const device = await withTimeout(adapter.requestDevice(), 'WebGPU device request');
        deviceAvailable = Boolean(device);
        device?.destroy?.();
      }
    } catch (error) { adapterError = error?.message || String(error); }
  }
  return { secureContext, webgpuAvailable, adapterAvailable, deviceAvailable, adapterError };
}

function isAppleMobile() {
  return /iPhone|iPad|iPod/i.test(self.navigator?.userAgent || '')
    || (self.navigator?.platform === 'MacIntel' && Number(self.navigator?.maxTouchPoints) > 1);
}

function chooseStrategies(state) {
  // iOS WebKit can terminate the page when allocating the full model. LAN HTTP
  // also removes WebGPU's secure-context requirement, so use the local Q8 WASM
  // model first in either case. Desktop still prefers full precision WebGPU.
  compactDevice = isAppleMobile();
  if (compactDevice || !state.secureContext || !state.deviceAvailable) {
    return compactDevice
      ? [ENGINE_STRATEGIES[2]]
      : [ENGINE_STRATEGIES[2], ENGINE_STRATEGIES[1]];
  }
  return [...ENGINE_STRATEGIES];
}

async function configureRuntime() {
  capabilities = await inspectCapabilities();
  engineStrategies = chooseStrategies(capabilities);
  send('capabilities', { ...capabilities, compactDevice });
  transformersEnv.allowLocalModels = true;
  transformersEnv.allowRemoteModels = false;
  transformersEnv.useBrowserCache = false;
  transformersEnv.localModelPath = new URL('/models/', self.location.href).href;
  if (transformersEnv.backends?.onnx?.webgpu) {
    // Windows Chromium ignores powerPreference; allow the browser to select.
    transformersEnv.backends.onnx.webgpu.powerPreference = undefined;
  }
  if ((compactDevice || !capabilities.deviceAvailable) && transformersEnv.backends?.onnx?.wasm) {
    transformersEnv.backends.onnx.wasm.numThreads = 1;
  }
  kokoroEnv.wasmPaths = new URL('/tts/runtime/', self.location.href).href;
}

async function initialize(startIndex = 0, priorFailure = '') {
  if (engine && startIndex === 0) return engine;
  if (initialization && startIndex === 0) return initialization;
  const task = initializeEngine(startIndex, priorFailure);
  if (startIndex > 0) return task;
  initialization = task.catch((error) => { initialization = null; throw error; });
  return initialization;
}

async function initializeEngine(startIndex = 0, priorFailure = '') {
  if (!capabilities || startIndex === 0) await configureRuntime();
  const failures = priorFailure ? [priorFailure] : [];
  if (!capabilities.secureContext) failures.push('This page is not a secure context; WebGPU is unavailable here.');
  else if (!capabilities.webgpuAvailable || !capabilities.adapterAvailable || !capabilities.deviceAvailable) {
    failures.push(capabilities.adapterError || 'WebGPU is unavailable; trying local WASM.');
  }

  for (let index = startIndex; index < engineStrategies.length; index += 1) {
    const strategy = engineStrategies[index];
    if (strategy.backend === 'webgpu' && !capabilities.deviceAvailable) continue;
    send('status', {
      status: index > 0 || failures.length ? 'fallback' : 'loading',
      message: index > 0 || failures.length
        ? `${failures.at(-1)} Trying ${strategy.description} on this device…`
        : `Loading the local ${strategy.description} voice model…`,
      engineId: strategy.id,
      backend: strategy.backend,
      dtype: strategy.dtype,
      mode: strategy.mode,
      engineOrder: engineStrategies.map((item) => item.id),
    });

    let candidate = null;
    try {
      candidate = await KokoroTTS.from_pretrained(MODEL_PATH, {
        dtype: strategy.dtype,
        device: strategy.backend,
        progress_callback: (progress) => send('progress', { progress, engineId: strategy.id }),
      });
      send('status', { status: 'self-testing', message: `Checking a short Heart sample with ${strategy.description}…`, engineId: strategy.id, backend: strategy.backend, dtype: strategy.dtype, mode: strategy.mode });
      const sample = await candidate.generate('Testing hello, are you there?', { voice: VOICE_DEFAULT, speed: 1 });
      const quality = validateEchoLinkAudioQuality(new Float32Array(sample.audio), 'Heart voice check');
      engine = candidate;
      engineStrategy = strategy;
      send('status', {
        status: 'ready',
        message: `Voice check passed · ${strategy.description}.`,
        engineId: strategy.id,
        engineName: strategy.name,
        engineMode: strategy.mode,
        backend: strategy.backend,
        dtype: strategy.dtype,
        engineOrder: engineStrategies.map((item) => item.id),
        qualityCheck: quality,
      });
      return engine;
    } catch (error) {
      failures.push(`${strategy.description}: ${error?.message || String(error)}`);
      try { await candidate?.model?.dispose?.(); } catch { /* Try the next local engine. */ }
      engine = null;
      engineStrategy = null;
    }
  }
  throw new Error(`No local Kokoro mode passed its speech check. ${failures.join(' | ')}`);
}

async function moveToNextEngine(reason = 'Trying the next local speech mode.') {
  if (!engineStrategy) throw new Error('The current voice mode is not ready yet.');
  const currentIndex = engineStrategies.findIndex((item) => item.id === engineStrategy.id);
  if (currentIndex < 0 || currentIndex + 1 >= engineStrategies.length) throw new Error('No lower local speech mode is available on this device.');
  const from = engineStrategy;
  try { await engine?.model?.dispose?.(); } catch { /* Continue to the selected fallback. */ }
  engine = null;
  engineStrategy = null;
  initialization = null;
  const prior = `${reason} ${from.description} did not meet the selected quality level.`;
  try {
    await initialize(currentIndex + 1, prior);
  } catch (error) {
    send('error', { message: error?.message || String(error) });
  }
}

function enqueue(message) {
  const task = { ...message, sessionId };
  if (message.priority) {
    const index = queue.findIndex((item) => item.sessionId === sessionId);
    queue.splice(index < 0 ? 0 : index, 0, task);
  } else queue.push(task);
  drain();
}

async function drain() {
  if (draining) return;
  draining = true;
  while (queue.length) {
    const task = queue.shift();
    if (cancelled.has(task.sessionId)) continue;
    try {
      await initialize();
      if (cancelled.has(task.sessionId)) continue;
      send('status', { status: 'generating', message: `Generating section ${task.index + 1}…`, engineId: engineStrategy?.id, engineName: engineStrategy?.name, engineMode: engineStrategy?.mode });
      const audio = await engine.generate(task.text, { voice: task.voice || selectedVoice, speed: 1.0 });
      if (cancelled.has(task.sessionId)) continue;
      const samples = new Float32Array(audio.audio);
      validateEchoLinkAudioQuality(samples, `Section ${task.index + 1}`);
      send('audio', { sessionId: task.sessionId, index: task.index, voice: task.voice || selectedVoice, text: task.text, start: task.start, end: task.end, samples, engineId: engineStrategy?.id }, [samples.buffer]);
    } catch (error) {
      if (!cancelled.has(task.sessionId)) send('error', { sessionId: task.sessionId, message: error?.message || String(error), engineId: engineStrategy?.id });
    }
  }
  draining = false;
  send('queue-empty', { sessionId });
  if (engine && !cancelled.has(sessionId)) send('status', { status: 'ready', message: `${engineStrategy?.description || 'Local voice'} is ready.`, engineId: engineStrategy?.id, engineName: engineStrategy?.name, engineMode: engineStrategy?.mode, backend: engineStrategy?.backend, dtype: engineStrategy?.dtype, engineOrder: engineStrategies.map((item) => item.id) });
}

self.onmessage = (event) => {
  const message = event.data || {};
  if (message.type === 'initialize') {
    if (message.voice) selectedVoice = message.voice;
    initialize().catch((error) => send('error', { message: error?.message || String(error) }));
    return;
  }
  if (message.type === 'prepare') {
    if (sessionId) cancelled.add(sessionId);
    sessionId = message.sessionId;
    cancelled.delete(sessionId);
    queue = [];
    const voice = message.voice || selectedVoice;
    for (const chunk of message.chunks || []) queue.push({ ...chunk, sessionId, voice, priority: false });
    drain();
    return;
  }
  if (message.type === 'prioritize') {
    const at = queue.findIndex((item) => item.sessionId === sessionId && item.index >= message.index);
    if (at > 0) { const [target] = queue.splice(at, 1); queue.unshift({ ...target, priority: true }); }
    return;
  }
  if (message.type === 'cancel') {
    cancelled.add(message.sessionId);
    queue = queue.filter((task) => task.sessionId !== message.sessionId);
    send('cancelled', { sessionId: message.sessionId });
    return;
  }
  if (message.type === 'fallback-now') moveToNextEngine(message.reason).catch((error) => send('error', { message: error?.message || String(error) }));
};
