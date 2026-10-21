VideoToMp3 WASM — Parallel Fast Edition (v4)
=============================================
(c) Kaalsoft

Converts video (or audio) files to MP3 entirely inside the browser /
WebView, using a trimmed FFmpeg 6.1.2 + LAME 3.100 compiled to
WebAssembly. No server, no upload — everything runs locally on the
device. Fully offline once the files are loaded.

WHAT CHANGED IN v4 (vs v3)
--------------------------
v4 attacks the one cost v3 could not: TIME ITSELF. Encoding time
grows with the audio's DURATION, not with the file's size in MB —
and v3 still encoded everything on a single CPU core.

For files of 2 minutes or longer, v4 now converts IN PARALLEL:

  1. The wrapper probes the audio duration.
  2. It splits the audio into up to 4 equal time segments.
  3. Each segment is encoded at the same moment in its own Web
     Worker (one per CPU core), with the EXACT same encoder
     settings, bitrate handling and sample-rate logic as a single
     conversion — quality is unchanged.
  4. The MP3 segments are concatenated in order into one file.
     (Only the first segment carries the ID3 tag; the joins are
     plain MP3 frame boundaries. Each join contains roughly 50 ms
     of encoder padding, verified by decoding and comparing
     against the single-conversion output — no gaps, no missing
     audio.)

Safety net: if probing fails, the file is shorter than 2 minutes,
the device reports a single core, or ANY segment fails, conversion
transparently falls back to the proven v3 single-worker path
(hybrid: up to 200 MB from memory, larger files streamed). The
page and the API never expose any of this machinery.

Everything else from v3 is kept: the -O2-optimized LAME (in v1/v2
it had accidentally been built with no optimization at all), the
custom 1 MiB input read buffer, deduplicated progress messages,
and byte-identical output on the single-conversion path
(md5-verified against v1/v2/v3).

FILES (keep ALL of them in ONE folder)
--------------------------------------
  index.html              The converter page (designed UI) — open this.
  video-to-mp3-stream.js  v4 wrapper (VideoToMp3Stream API; parallel
                          orchestration + automatic fallback).
  vidmp3-worker.js        The Web Worker (v4: version / convert /
                          probe / convert-range).
  vidmp3.js               Emscripten glue code (loaded by the worker).
  vidmp3.wasm             The engine (FFmpeg + LAME, WebAssembly).
  video-to-mp3.js         v1 wrapper (whole-file, bytes in memory) —
                          kept for compatibility, not used by the page.
  demo.html               Minimal v1 demo page (reference only).
  vidmp3-wasm-v4-source.zip   Source code (C core + build script).
  LICENSE-*.txt           FFmpeg (LGPL 2.1) and LAME license texts.

HOW TO RUN
----------
The page must be served over http(s) — or, inside an Android app,
through WebViewAssetLoader's appassets scheme
(https://appassets.androidplatform.net/assets/...). A plain file://
page CANNOT load Web Workers or WebAssembly, so opening index.html
straight from a file manager will show "Engine failed to load".

  * Local test:  python3 -m http.server   (then open the page URL)
  * Hosting:     any static host works (the whole folder is ~1.9 MB).
                 Parallel mode uses separate Workers, NOT
                 SharedArrayBuffer — so NO COOP/COEP headers are
                 needed, exactly like v1–v3.
  * In an APK:   put all files under src/main/assets/ (e.g.
                 assets/wasm/) and load index.html via
                 WebViewAssetLoader. No INTERNET permission needed.

USING THE PAGE
--------------
1. Tap the box (or drag & drop) and choose a video — any size.
2. Pick a bitrate: 128 / 192 / 320 kbps.
3. Tap "Convert to MP3". Keep the page in front with the screen ON
   while it converts — phones throttle or pause background pages,
   which can stretch the time a lot (this alone can turn minutes
   into an "hour-long" conversion).
4. Play the MP3 in the page or tap "Download MP3" to save it.

JAVASCRIPT API (for your own pages)
-----------------------------------
  <script src="video-to-mp3-stream.js"></script>
  <script>
    // file: a File object from <input type="file">
    const mp3Blob = await VideoToMp3Stream.convert(file, {
        bitrateKbps: 192,                 // optional, default 192
        onProgress: (pct) => { /* 0..100, live */ }
    });
    // mp3Blob is a Blob of type 'audio/mpeg'; convert() throws an
    // Error with a readable message on failure.

    const v = await VideoToMp3Stream.version();
    // "vidmp3-wasm 1.0 (libavformat 60.16.100, libavcodec 60.31.102,
    //  libswresample 4.12.100, LAME 3.100)"

  Conversions are serialized: calling convert() while one is
  running queues the new one behind it. Parallel segment encoding
  happens inside a single convert() call.

SUPPORTED INPUT
---------------
Containers: MP4/MOV, MKV/WebM, AVI, FLV, MP3, WAV, AAC.
Audio codecs decoded: AAC, MP3, Opus, Vorbis, ALAC, FLAC, PCM.
Only the audio track is used; output is MP3 (CBR at the chosen
bitrate), same sample rate as the source when LAME supports it.

SPEED — HONEST NOTES
--------------------
How much parallel mode helps depends on the device CPU: it uses up
to 4 cores at once, so the more real, independent cores the phone
has, the bigger the win. A phone with 4+ usable cores should cut a
long conversion to roughly a third or a quarter of the v3 time;
a 1–2 core device gains little and short files (< 2 min) simply
use the single path.

Measured during development (2-core test VM): a 30-minute,
15 MB test file converted in ~26 s in parallel vs ~38 s single.
Note that this VM's two vCPUs cap total multi-core throughput at
about 1.45x a single core (shared/simultaneous-multithreading
cores), so the phone result — with genuinely independent cores —
is expected to be better than the VM numbers, not worse. The
parallel path's correctness (durations, joins, levels) was fully
verified on that VM; the exact speed gain is a property of the
phone's CPU.

Two things that still slow conversions down regardless of version:
the phone throttling a background/screen-off page, and heat or
battery saver. Keep the page open with the screen on for long
videos, and prefer 128/192 kbps when speed matters most.

LIMITS
------
  * Single-conversion path: files up to 200 MB are held in memory
    (needs roughly 2–3x the file size in free RAM); larger files
    stream from storage. Parallel segment workers always stream
    their segment from storage, so parallel mode does not multiply
    the memory use by the segment count.
  * The OUTPUT MP3 is assembled in page memory as a Blob (MP3s are
    small — roughly 1 MB per minute at 128 kbps).
  * A video with no audio track fails with a readable error.
  * Very old browsers without WebAssembly / Web Workers cannot run it.

LICENSE
-------
The FFmpeg libraries in vidmp3.wasm are LGPL 2.1 (see
LICENSE-FFmpeg-LGPLv2.1.txt); LAME is LGPL (see LICENSE-LAME.txt).
The wrapper, worker, page and C bridge code are (c) Kaalsoft.
If you distribute an app containing vidmp3.wasm, include both
license files with it.
