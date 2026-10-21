/*
 * vidmp3-worker.js - Web Worker for the Kaalsoft VideoToMp3 WASM module
 * (parallel fast build, v4).
 *
 * v4 keeps everything v3 had (hybrid input paths, deduplicated
 * progress, optimized -O2 LAME in the engine) and adds the two calls
 * the parallel wrapper needs:
 *
 *   probe         -> measures the audio duration of a File, so the
 *                    wrapper can split the work into time segments.
 *   convert-range -> converts ONLY the audio inside [startUs, endUs)
 *                    of the file. The wrapper runs several of these at
 *                    once in separate workers (one per CPU core) and
 *                    concatenates the MP3 segments in order - that is
 *                    what makes long videos convert faster. Segment
 *                    workers always read through a WORKERFS mount:
 *                    with the core's 1 MiB read buffer that is
 *                    efficient, and it avoids holding one copy of the
 *                    file per worker in RAM.
 *
 * The encoder, bitrate handling and sample-rate logic are exactly
 * v3's - a segment is encoded with the same settings a full convert
 * would use, so quality is unchanged. Segment joins are plain MP3
 * frame-stream concatenations; segments after the first are encoded
 * without an ID3 header (writeId3 = 0).
 *
 * Files that must sit next to each other (served over http(s), or the
 * appassets scheme inside an app - file:// blocks workers and wasm):
 *   vidmp3-worker.js  (this file)
 *   vidmp3.js         (Emscripten glue, MODULARIZE factory VidMp3Module)
 *   vidmp3.wasm       (the engine)
 *
 * Message protocol
 * ----------------
 * In:
 *   { type: 'version' }
 *   { type: 'convert', file: <File>, bitrateKbps: <number> }
 *   { type: 'probe', file: <File> }
 *   { type: 'convert-range', file: <File>, bitrateKbps: <number>,
 *     startUs: <number>, endUs: <number>, writeId3: <0|1>,
 *     segIndex: <number> }
 * Out:
 *   { type: 'version',  version: <string> }
 *   { type: 'probe',    durationUs: <number> }
 *   { type: 'progress', pct: <0..100> }              (convert)
 *   { type: 'progress', pct: <0..100>, segIndex: n } (convert-range)
 *   { type: 'chunk',    data: <ArrayBuffer> }   (transferred, ~1 MB each)
 *   { type: 'done' }
 *   { type: 'error',    message: <string> }
 */

'use strict';

importScripts('vidmp3.js');

var modulePromise = null;
function loadModule() {
    if (!modulePromise) {
        modulePromise = VidMp3Module();
    }
    return modulePromise;
}

var IN_MOUNT = '/input';
var IN_PATH = '/input/input';   // WORKERFS path (streaming, large files)
var MEM_PATH = '/input-mem';    // MEMFS path (fast, <= 200 MB files)
var OUT_PATH = '/output.mp3';
var CHUNK_BYTES = 1024 * 1024;  // stream the MP3 back in ~1 MB pieces
var MEMFS_MAX_BYTES = 200 * 1024 * 1024;  // hybrid threshold

function lastError(Module) {
    try {
        var ptr = Module.ccall('vidmp3_last_error', 'number', [], []);
        return Module.UTF8ToString(ptr);
    } catch (e) {
        return '';
    }
}

function checkRet(Module, ret) {
    if (ret !== 0) {
        throw new Error(lastError(Module) ||
            ('Video-to-MP3 conversion failed (code ' + ret + ')'));
    }
}

/* Mount the File with WORKERFS for the duration of fn, then unmount. */
function withWorkerfs(Module, file, fn) {
    var FS = Module.FS;
    var WORKERFS = Module.WORKERFS;
    if (!WORKERFS) {
        throw new Error('This vidmp3.wasm build has no WORKERFS support.');
    }
    try { FS.mkdir(IN_MOUNT); } catch (e) { /* already exists */ }
    var mounted = false;
    try {
        FS.mount(WORKERFS, { blobs: [{ name: 'input', data: file }] }, IN_MOUNT);
        mounted = true;
        return fn(IN_PATH);
    } finally {
        if (mounted) {
            try { FS.unmount(IN_MOUNT); } catch (e) { /* ignore */ }
        }
    }
}

/* Write the File to a MEMFS memory file for the duration of fn. */
function withMemfs(Module, file, fn) {
    var FS = Module.FS;
    return file.arrayBuffer().then(function (ab) {
        FS.writeFile(MEM_PATH, new Uint8Array(ab));
        try {
            return fn(MEM_PATH);
        } finally {
            try { FS.unlink(MEM_PATH); } catch (e) { /* ignore */ }
        }
    });
}

/* Give fn a readable input path for the File, hybrid-style:
 * small files via MEMFS (fast), large ones via WORKERFS (streaming). */
function withInput(Module, file, fn) {
    if (file.size <= MEMFS_MAX_BYTES) {
        return withMemfs(Module, file, fn);
    }
    return withWorkerfs(Module, file, fn);
}

/* Run a full conversion with progress reporting (deduplicated). */
function runConvert(Module, inputPath, bitrateKbps) {
    var lastPct = -1;
    // The native core reports progress through this hook (EM_JS).
    self.__vidmp3_progress = function (pct) {
        if (pct !== lastPct) {
            lastPct = pct;
            postMessage({ type: 'progress', pct: pct });
        }
    };
    try {
        return Module.ccall('vidmp3_convert', 'number',
            ['string', 'string', 'number'],
            [inputPath, OUT_PATH, bitrateKbps]);
    } finally {
        self.__vidmp3_progress = undefined;
    }
}

/* Run a range conversion; progress is tagged with the segment index
 * so the wrapper can aggregate the parallel segments' progress. */
function runConvertRange(Module, inputPath, msg) {
    var lastPct = -1;
    self.__vidmp3_progress = function (pct) {
        if (pct !== lastPct) {
            lastPct = pct;
            postMessage({ type: 'progress', pct: pct, segIndex: msg.segIndex });
        }
    };
    try {
        return Module.ccall('vidmp3_convert_range', 'number',
            ['string', 'string', 'number', 'bigint', 'bigint', 'number'],
            [inputPath, OUT_PATH, msg.bitrateKbps || 192,
             BigInt(Math.round(msg.startUs || 0)),
             BigInt(Math.round(msg.endUs || 0)),
             msg.writeId3 ? 1 : 0]);
    } finally {
        self.__vidmp3_progress = undefined;
    }
}

/* Stream the finished MP3 back to the page in ~1 MB transferred
 * chunks, then delete it from the module filesystem. */
function streamOut(Module) {
    var FS = Module.FS;
    var stream = FS.open(OUT_PATH, 'r');
    try {
        var buf = new Uint8Array(CHUNK_BYTES);
        var pos = 0;
        for (;;) {
            var n = FS.read(stream, buf, 0, CHUNK_BYTES, pos);
            if (n <= 0) break;
            pos += n;
            var part = buf.slice(0, n); // copy: buf is reused
            postMessage({ type: 'chunk', data: part.buffer }, [part.buffer]);
        }
    } finally {
        FS.close(stream);
    }
    try { FS.unlink(OUT_PATH); } catch (e) { /* ignore */ }
}

function doConvert(file, bitrateKbps) {
    return loadModule().then(function (Module) {
        return withInput(Module, file, function (inputPath) {
            checkRet(Module, runConvert(Module, inputPath, bitrateKbps));
            streamOut(Module);
            postMessage({ type: 'done' });
        });
    });
}

function doProbe(file) {
    return loadModule().then(function (Module) {
        return withInput(Module, file, function (inputPath) {
            var dur = Module.ccall('vidmp3_probe', 'bigint',
                ['string'], [inputPath]);
            if (dur < 0n) {
                throw new Error(lastError(Module) || 'Could not read the file duration.');
            }
            postMessage({ type: 'probe', durationUs: Number(dur) });
        });
    });
}

function doConvertRange(file, msg) {
    return loadModule().then(function (Module) {
        // Segment workers always stream via WORKERFS (see header).
        return withWorkerfs(Module, file, function (inputPath) {
            checkRet(Module, runConvertRange(Module, inputPath, msg));
            streamOut(Module);
            postMessage({ type: 'done' });
        });
    });
}

self.onmessage = function (ev) {
    var msg = ev.data || {};
    var fail = function (e) {
        postMessage({
            type: 'error',
            message: (e && e.message) ? e.message : String(e)
        });
    };

    if (msg.type === 'version') {
        loadModule().then(function (Module) {
            var ptr = Module.ccall('vidmp3_version', 'number', [], []);
            postMessage({ type: 'version', version: Module.UTF8ToString(ptr) });
        }).catch(fail);
    } else if (msg.type === 'convert') {
        if (!msg.file) {
            fail(new Error('No file was supplied to the converter worker.'));
            return;
        }
        doConvert(msg.file, msg.bitrateKbps || 192).catch(fail);
    } else if (msg.type === 'probe') {
        if (!msg.file) {
            fail(new Error('No file was supplied to the converter worker.'));
            return;
        }
        doProbe(msg.file).catch(fail);
    } else if (msg.type === 'convert-range') {
        if (!msg.file) {
            fail(new Error('No file was supplied to the converter worker.'));
            return;
        }
        doConvertRange(msg.file, msg).catch(fail);
    } else {
        fail(new Error('Unknown message type for vidmp3 worker: ' + msg.type));
    }
};
