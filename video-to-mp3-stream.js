/*
 * video-to-mp3-stream.js - streaming + parallel JS wrapper for
 * vidmp3.wasm v4 (Kaalsoft VideoToMp3). Companion to vidmp3-worker.js.
 *
 * Same public API as v2/v3:
 *   const mp3Blob = await VideoToMp3Stream.convert(file, {
 *       bitrateKbps: 192,          // optional, default 192
 *       onProgress: (pct) => {}    // optional, 0..100, live
 *   });
 *   // mp3Blob is a Blob (type 'audio/mpeg'); throws Error on failure.
 *
 *   const v = await VideoToMp3Stream.version();  // "vidmp3-wasm 1.0 ..."
 *
 * What v4 adds: PARALLEL conversion for long files. Encoding time
 * grows with the audio's duration, so for files of 2 minutes or more
 * the wrapper first probes the duration, splits the audio into up to
 * 4 time segments, and encodes the segments SIMULTANEOUSLY in
 * separate workers (one per CPU core), then concatenates the MP3
 * segments in order. Every segment is encoded with the exact same
 * encoder settings as a single conversion, so quality is unchanged.
 *
 * Safety: if probing fails, the device reports a single core, the
 * file is short, or ANY segment fails, convert() transparently falls
 * back to the proven v3 single-worker conversion. The caller never
 * sees the parallel machinery.
 *
 * Page setup - all files in one folder, served over http(s) (or the
 * appassets scheme inside an app; file:// cannot load workers /
 * WebAssembly):
 *   <script src="video-to-mp3-stream.js"></script>
 *   (vidmp3-worker.js, vidmp3.js and vidmp3.wasm just need to be in
 *    the same folder - the workers load the glue themselves.)
 *
 * Conversions are serialized: calling convert() while one is running
 * queues the new one behind it.
 */

(function () {
    'use strict';

    var PARALLEL_MIN_US = 120 * 1000000;  // parallel only for >= 2 min
    var MAX_SEGMENTS = 4;

    var worker = null;               // main worker (version/convert/probe)
    var current = null;              // the in-flight main-worker request
    var chain = Promise.resolve();   // serialization queue

    function startError(extra) {
        return new Error(
            'The converter worker could not start. vidmp3-worker.js, ' +
            'vidmp3.js and vidmp3.wasm must be served over http(s) (or ' +
            'the appassets scheme inside an app) - browsers block Web ' +
            'Workers and WebAssembly loaded from file:// pages.' +
            (extra ? ' (' + extra + ')' : ''));
    }

    function newWorker() {
        if (typeof Worker === 'undefined') {
            throw startError('Web Workers are not supported here.');
        }
        try {
            return new Worker('vidmp3-worker.js');
        } catch (e) {
            throw startError(e && e.message);
        }
    }

    /* ---------------- main worker (v3 behaviour + probe) ------------- */

    function ensureWorker() {
        if (worker) return worker;
        var w = newWorker();

        w.onmessage = function (ev) {
            var msg = ev.data || {};
            var cur = current;
            if (msg.type === 'progress') {
                if (cur && cur.onProgress) {
                    try { cur.onProgress(msg.pct); } catch (e) { /* ignore */ }
                }
            } else if (msg.type === 'chunk') {
                if (cur) cur.parts.push(msg.data);
            } else if (msg.type === 'version') {
                if (cur) { current = null; cur.resolve(msg.version); }
            } else if (msg.type === 'probe') {
                if (cur) { current = null; cur.resolve(msg.durationUs); }
            } else if (msg.type === 'done') {
                if (cur) {
                    current = null;
                    cur.resolve(new Blob(cur.parts, { type: 'audio/mpeg' }));
                }
            } else if (msg.type === 'error') {
                if (cur) {
                    current = null;
                    cur.reject(new Error(msg.message || 'Conversion failed.'));
                }
            }
        };
        w.onerror = function (e) {
            var cur = current;
            current = null;
            worker = null; // recreate on next call
            try { w.terminate(); } catch (ignore) { /* ignore */ }
            if (cur) cur.reject(startError(e && e.message ? e.message : ''));
        };

        worker = w;
        return w;
    }

    function request(buildMessage) {
        return new Promise(function (resolve, reject) {
            current = { resolve: resolve, reject: reject, onProgress: null, parts: [] };
            var pending = current;
            try {
                var w = ensureWorker();
                var msg = buildMessage();
                if (msg && msg.__onProgress) {
                    pending.onProgress = msg.__onProgress;
                    delete msg.__onProgress;
                }
                w.postMessage(msg);
            } catch (e) {
                if (current === pending) current = null;
                reject(e);
            }
        });
    }

    function enqueue(fn) {
        var result = chain.then(fn);
        chain = result.then(function () { }, function () { });
        return result;
    }

    function singleConvert(file, bitrateKbps, onProgress) {
        return request(function () {
            return {
                type: 'convert',
                file: file,
                bitrateKbps: bitrateKbps,
                __onProgress: onProgress
            };
        });
    }

    function probeDuration(file) {
        return request(function () {
            return { type: 'probe', file: file };
        });
    }

    /* ---------------- parallel segment conversion ------------------ */

    function runSegment(index, file, bitrateKbps, startUs, endUs, onSegProgress) {
        return new Promise(function (resolve, reject) {
            var w;
            try {
                w = newWorker();
            } catch (e) {
                reject(e);
                return;
            }
            var parts = [];
            var settled = false;
            function finish(fn, val) {
                if (settled) return;
                settled = true;
                try { w.terminate(); } catch (e) { /* ignore */ }
                fn(val);
            }
            w.onmessage = function (ev) {
                var msg = ev.data || {};
                if (msg.type === 'progress') {
                    onSegProgress(index, msg.pct);
                } else if (msg.type === 'chunk') {
                    parts.push(msg.data);
                } else if (msg.type === 'done') {
                    finish(resolve, parts);
                } else if (msg.type === 'error') {
                    finish(reject, new Error(msg.message || 'Segment conversion failed.'));
                }
            };
            w.onerror = function (e) {
                finish(reject, startError(e && e.message ? e.message : ''));
            };
            try {
                w.postMessage({
                    type: 'convert-range',
                    file: file,
                    bitrateKbps: bitrateKbps,
                    startUs: startUs,
                    endUs: endUs,
                    writeId3: index === 0 ? 1 : 0,
                    segIndex: index
                });
            } catch (e) {
                finish(reject, e);
            }
        });
    }

    function parallelConvert(file, bitrateKbps, onProgress, durationUs, segCount) {
        var bounds = [];
        var i;
        for (i = 0; i <= segCount; i++) {
            bounds.push(Math.floor(durationUs * i / segCount));
        }
        var segPcts = [];
        var lastOverall = -1;
        for (i = 0; i < segCount; i++) segPcts.push(0);

        function segProgress(index, pct) {
            segPcts[index] = pct;
            if (!onProgress) return;
            var acc = 0;
            for (var j = 0; j < segCount; j++) {
                acc += segPcts[j] * (bounds[j + 1] - bounds[j]);
            }
            var overall = Math.floor(acc / durationUs);
            if (overall > lastOverall) {
                lastOverall = overall;
                try { onProgress(overall); } catch (e) { /* ignore */ }
            }
        }

        var jobs = [];
        for (i = 0; i < segCount; i++) {
            jobs.push(runSegment(i, file, bitrateKbps,
                bounds[i], bounds[i + 1], segProgress));
        }
        return Promise.all(jobs).then(function (segParts) {
            var all = [];
            for (var j = 0; j < segParts.length; j++) {
                for (var k = 0; k < segParts[j].length; k++) {
                    all.push(segParts[j][k]);
                }
            }
            if (onProgress && lastOverall < 100) {
                try { onProgress(100); } catch (e) { /* ignore */ }
            }
            return new Blob(all, { type: 'audio/mpeg' });
        });
    }

    /* ---------------- public API ------------------------------------ */

    /**
     * Convert a video (or audio) File to an MP3 Blob.
     * Long files are converted in parallel across CPU cores when
     * possible, with an automatic fallback to single conversion.
     * @param {File|Blob} file - a File from <input type="file">.
     * @param {Object} [options]
     * @param {number} [options.bitrateKbps=192]
     * @param {function(number)} [options.onProgress] - receives 0..100.
     * @returns {Promise<Blob>} MP3 blob (type 'audio/mpeg').
     */
    function convert(file, options) {
        options = options || {};
        var bitrateKbps = options.bitrateKbps || 192;
        var onProgress = typeof options.onProgress === 'function'
            ? options.onProgress : null;
        if (!file || typeof file.size !== 'number') {
            return Promise.reject(new Error(
                'convert() expects a File (or Blob) - e.g. from an <input type="file">.'));
        }
        return enqueue(function () {
            var cores = 0;
            try {
                cores = (typeof navigator !== 'undefined' &&
                    navigator.hardwareConcurrency) || 0;
            } catch (e) { /* ignore */ }

            if (cores < 2) {
                return singleConvert(file, bitrateKbps, onProgress);
            }
            return probeDuration(file).then(function (durationUs) {
                if (!durationUs || durationUs < PARALLEL_MIN_US) {
                    return singleConvert(file, bitrateKbps, onProgress);
                }
                var segCount = Math.min(MAX_SEGMENTS, cores);
                return parallelConvert(file, bitrateKbps, onProgress,
                    durationUs, segCount).catch(function () {
                        // Any parallel failure: proven single path.
                        return singleConvert(file, bitrateKbps, onProgress);
                    });
            }, function () {
                // Probe failed: proven single path.
                return singleConvert(file, bitrateKbps, onProgress);
            });
        });
    }

    /**
     * @returns {Promise<string>} version string of the native module.
     */
    function version() {
        return enqueue(function () {
            return request(function () { return { type: 'version' }; });
        });
    }

    var api = { convert: convert, version: version };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    } else {
        (typeof window !== 'undefined' ? window : globalThis).VideoToMp3Stream = api;
    }
})();
