# EchoLink — local Kokoro reader

EchoLink is a standalone text-to-speech reader. The browser interface and model run locally; the Kokoro model, Heart voice, inference runtime, and application JavaScript are stored in this folder.

## First-time setup

The finished app is already built. The FP32 Kokoro model (about 311 MiB), selected Kokoro voice embeddings, and browser runtime are included in this folder, so you can launch it as-is. Heart (`af_heart`) is the default voice. The selector includes `af_heart`, `af_jessica`, `af_nicole`, `af_sky`, `am_adam`, `am_onyx`, `am_santa`, `bf_alice`, `bf_emma`, `bm_daniel`, and `bm_lewis`. To rebuild from source, run `setup.bat` while online; it installs the pinned build dependencies and recreates `dist/` from the bundled model and voice files.

Node.js 20.19+ or 22.12+ is required. The ONNX model is stored with Git LFS; install Git LFS before cloning so the model is downloaded as a real model file rather than an LFS pointer. If you already cloned without it, run `git lfs install` and `git lfs pull` in the repository.

## Daily use, including offline use

Run **EchoLink.cmd** to open the server control menu. Choose **Start** to launch the web server as an independent background process and return to the menu; **Enter** refreshes the live port status; **Stop** releases the port; and **Quit** stops the server, verifies the port is free, then exits. The app uses the single port in `server.port` (4174 by default) and is served at `http://127.0.0.1:4174`. If another process owns that port, the launcher reports the conflict and leaves it alone. `Hush.cmd` remains as a compatibility shortcut and opens the EchoLink menu.

Choose **Verify app** in the menu or run `npm run verify` to rebuild and run the repeatable offline smoke test. It checks bundled assets, server start/stop/restart, browser runtime errors, local-only model and runtime loads, default Heart (`af_heart`) and alternate Jessica synthesis, progressive generation, and the main playback controls. It uses installed Microsoft Edge or Chrome with WebGPU and denies all browser requests outside the local server. A person should still listen to samples and visually inspect the reader in their target browser/GPU setup.

WebGPU is the required primary backend. Use a current Chrome or Edge build with hardware acceleration enabled. EchoLink does not switch to browser speech synthesis or a different voice if WebGPU is unavailable.

## Implementation

- `src/tts.js` is the reusable timeline and playback session API.
- `src/tts-worker.js` owns model loading and serial, progressive generation in a persistent Web Worker.
- Kokoro.js is pinned to 1.2.1; model `onnx-community/Kokoro-82M-v1.0-ONNX`; `fp32` + `webgpu`; selectable local voices; 24 kHz output.
- Remote model downloads are disabled in Transformers.js. The Kokoro voice loader is patched at build time to resolve `/tts/voices/<voice-id>.bin` locally.
- The production local server applies a Content Security Policy with `connect-src 'self'`, so a remote request cannot silently become a runtime dependency.
- Text and preferences are stored in the browser's local storage.

## Rebuild

With dependencies installed, run `npm run build`. Then start with `EchoLink.cmd` or `node server.mjs`. Runtime use of the built `dist/` folder requires Node.js but no npm packages and no network.

## Bundled assets and licenses

The model configuration/tokenizer and FP32 ONNX model come from the Apache-2.0 licensed [Kokoro ONNX model repository](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX). Kokoro.js and the bundled voice embeddings come from the Apache-2.0 licensed [kokoro-js package](https://www.npmjs.com/package/kokoro-js). Browser runtime assets are from ONNX Runtime Web, distributed under MIT. See package license files in `node_modules/` for full notices. EchoLink's app code is Apache-2.0.

Offline playback was checked in Chromium by loading the app and model from the loopback server, switching the browser's network emulation to offline, then synthesizing a new passage. Playback succeeded without new network requests. The production server also blocks non-local connections with its Content Security Policy. Chromium's offline emulation blocks loopback requests too, so it cannot cold-start a localhost app; a physical disconnect-before-launch check remains specific to the target browser and WebGPU driver.
