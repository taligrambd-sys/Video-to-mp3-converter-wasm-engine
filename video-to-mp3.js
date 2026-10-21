/*
 * video-to-mp3.js - clean JS wrapper for vidmp3.wasm (Kaalsoft VideoToMp3).
 *
 * The library is single-threaded WebAssembly (no pthreads / no
 * SharedArrayBuffer), so it runs on any plain static hosting without
 * COOP/COEP headers.
 *
 * API:
 *   const mp3 = await VideoToMp3.convert(videoBytes, {
 *       bitrateKbps: 192,          // optional, default 192
 *       onProgress: (pct) => {}    // optional, 0..100
 *   });
 *   // mp3 is a Uint8Array; throws Error(native message) on failure.
 *
 *   const v = await VideoToMp3.version();  // e.g. "vidmp3-wasm 1.0 ..."
 *
 * Usage in a page (load order matters):
 *   <script src="vidmp3.js"></script>        <!-- Emscripten glue -->
 *   <script src="video-to-mp3.js"></script>  <!-- this wrapper -->
 */

(function () {
    'use strict';

    // Factory from the Emscripten glue (MODULARIZE=1).
    function getFactory() {
        if (typeof VidMp3Module !== 'undefined') return VidMp3Module;
        // Node.js usage: const VideoToMp3 = require('./video-to-mp3.js');
        if (typeof require === 'function') {
            try { return require('./vidmp3.js'); } catch (e) { /* fall through */ }
        }
        throw new Error('vidmp3.js (Emscripten glue) is not loaded. ' +
            'Include it with <script src="vidmp3.js"></script> before video-to-mp3.js.');
    }

    let modulePromise = null;
    function loadModule() {
        if (!modulePromise) {
            modulePromise = getFactory()().catch((e) => {
                modulePromise = null;
                throw e;
            });
        }
        return modulePromise;
    }

    const IN_PATH = '/vidmp3_input';
    const OUT_PATH = '/vidmp3_output.mp3';

    function cleanup(Module) {
        try { Module.FS.unlink(IN_PATH); } catch (e) { /* ignore */ }
        try { Module.FS.unlink(OUT_PATH); } catch (e) { /* ignore */ }
    }

    /**
     * Convert a video (or audio) file to MP3.
     * @param {Uint8Array|ArrayBuffer} input - the whole input file bytes.
     * @param {Object} [options]
     * @param {number} [options.bitrateKbps=192]
     * @param {function(number)} [options.onProgress] - receives 0..100.
     * @returns {Promise<Uint8Array>} MP3 file bytes.
     * @throws {Error} with the native error message on failure.
     */
    async function convert(input, options) {
        options = options || {};
        const bitrateKbps = options.bitrateKbps || 192;
        const onProgress = typeof options.onProgress === 'function'
            ? options.onProgress : null;

        let bytes;
        if (input instanceof Uint8Array) {
            bytes = input;
        } else if (input instanceof ArrayBuffer) {
            bytes = new Uint8Array(input);
        } else {
            throw new Error('convert() expects a Uint8Array or ArrayBuffer.');
        }

        const Module = await loadModule();

        Module.FS.writeFile(IN_PATH, bytes);

        // The native core calls globalThis.__vidmp3_progress(pct)
        // directly (via EM_JS) whenever progress changes.
        const GT = (typeof globalThis !== 'undefined') ? globalThis : null;
        if (GT && onProgress) {
            GT.__vidmp3_progress = (pct) => {
                try { onProgress(pct); } catch (e) { /* never break native */ }
            };
        }

        let ret;
        try {
            ret = Module.ccall('vidmp3_convert', 'number',
                ['string', 'string', 'number'],
                [IN_PATH, OUT_PATH, bitrateKbps]);
        } finally {
            if (GT && GT.__vidmp3_progress) GT.__vidmp3_progress = undefined;
        }

        if (ret !== 0) {
            let msg = '';
            try {
                const errPtr = Module.ccall('vidmp3_last_error', 'number', [], []);
                msg = Module.UTF8ToString(errPtr);
            } catch (e) { /* ignore */ }
            cleanup(Module);
            throw new Error(msg || ('Video-to-MP3 conversion failed (code ' + ret + ')'));
        }

        let out;
        try {
            out = Module.FS.readFile(OUT_PATH);
        } catch (e) {
            cleanup(Module);
            throw new Error('Conversion finished but the MP3 output could not be read.');
        }
        cleanup(Module);
        return out;
    }

    /**
     * @returns {Promise<string>} version string of the native module.
     */
    async function version() {
        const Module = await loadModule();
        const ptr = Module.ccall('vidmp3_version', 'number', [], []);
        return Module.UTF8ToString(ptr);
    }

    const api = { convert: convert, version: version };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    } else {
        (typeof window !== 'undefined' ? window : globalThis).VideoToMp3 = api;
    }
})();
