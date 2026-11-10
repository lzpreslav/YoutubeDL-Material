const { spawn } = require('child_process');
const fs = require('fs-extra');

const logger = require('./logger');

// 1x and 2x of the small, medium and large file card widths
exports.ALLOWED_WIDTHS = [150, 200, 300, 400, 600];

const CACHE_MAX_BYTES = 20 * 1024 * 1024;
const MAX_INPUT_BYTES = 2 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 512 * 1024;
const FFMPEG_TIMEOUT_MS = 5000;
const MAX_CONCURRENT_RESIZES = 2;

const cache = new Map();
let cache_bytes = 0;
const in_flight = new Map();

let active_resizes = 0;
const resize_queue = [];

function cacheGet(key) {
    const entry = cache.get(key);
    if (!entry) return null;
    cache.delete(key);
    cache.set(key, entry);
    return entry;
}

function cacheSet(key, entry) {
    cache.set(key, entry);
    cache_bytes += entry.buffer.length;
    for (const [old_key, old_entry] of cache) {
        if (cache_bytes <= CACHE_MAX_BYTES) break;
        cache.delete(old_key);
        cache_bytes -= old_entry.buffer.length;
    }
}

async function withResizeSlot(fn) {
    if (active_resizes >= MAX_CONCURRENT_RESIZES) {
        await new Promise(resolve => resize_queue.push(resolve));
    }
    active_resizes++;
    try {
        return await fn();
    } finally {
        active_resizes--;
        const next = resize_queue.shift();
        if (next) next();
    }
}

async function detectDemuxer(file_path) {
    const handle = await fs.open(file_path, 'r');
    try {
        const header = Buffer.alloc(12);
        await fs.read(handle, header, 0, 12, 0);
        if (header.toString('ascii', 0, 4) === 'RIFF' && header.toString('ascii', 8, 12) === 'WEBP') return 'webp_pipe';
        if (header[0] === 0xFF && header[1] === 0xD8 && header[2] === 0xFF) return 'jpeg_pipe';
        if (header.toString('hex', 0, 8) === '89504e470d0a1a0a') return 'png_pipe';
        return null;
    } finally {
        await fs.close(handle);
    }
}

function runFfmpeg(file_path, demuxer, width) {
    return new Promise((resolve, reject) => {
        const args = [
            '-nostdin', '-hide_banner', '-loglevel', 'error',
            '-protocol_whitelist', 'file',
            '-f', demuxer,
            '-i', `file:${file_path}`,
            '-frames:v', '1',
            '-vf', `scale=w=min(iw\\,${width}):h=-2`,
            '-c:v', 'libwebp', '-quality', '75',
            '-f', 'webp', 'pipe:1'
        ];
        const child = spawn(process.env.FFMPEG_PATH || 'ffmpeg', args, {stdio: ['ignore', 'pipe', 'pipe']});
        const chunks = [];
        let output_bytes = 0;
        let stderr = '';
        let failure = null;

        const timer = setTimeout(() => {
            failure = new Error(`timed out after ${FFMPEG_TIMEOUT_MS}ms`);
            child.kill('SIGKILL');
        }, FFMPEG_TIMEOUT_MS);

        child.stdout.on('data', chunk => {
            output_bytes += chunk.length;
            if (output_bytes > MAX_OUTPUT_BYTES) {
                failure = new Error('output too large');
                child.kill('SIGKILL');
                return;
            }
            chunks.push(chunk);
        });
        child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-500); });
        child.on('error', err => { failure = err; });
        child.on('close', code => {
            clearTimeout(timer);
            if (failure) reject(failure);
            else if (code !== 0 || output_bytes === 0) reject(new Error(`ffmpeg exited with code ${code}: ${stderr.trim()}`));
            else resolve(Buffer.concat(chunks));
        });
    });
}

async function createResizedThumbnail(file_path, width) {
    const demuxer = await detectDemuxer(file_path);
    if (!demuxer) throw new Error('unsupported image format');
    return await withResizeSlot(() => runFfmpeg(file_path, demuxer, width));
}

// Returns {buffer, etag} for the resized thumbnail, or null when the original should be served instead.
exports.getResizedThumbnail = async (real_path, width) => {
    if (!exports.ALLOWED_WIDTHS.includes(width)) return null;
    const stat = await fs.stat(real_path);
    if (stat.size > MAX_INPUT_BYTES) return null;

    const key = `${real_path}|${stat.mtimeMs}|${stat.size}|${width}`;
    const cached = cacheGet(key);
    if (cached) return cached;

    if (!in_flight.has(key)) {
        in_flight.set(key, createResizedThumbnail(real_path, width)
            .then(buffer => {
                const entry = {buffer, etag: `"${width}-${stat.size}-${Math.floor(stat.mtimeMs)}"`};
                cacheSet(key, entry);
                return entry;
            })
            .catch(err => {
                logger.warn(`Failed to resize thumbnail ${real_path}: ${err.message}`);
                return null;
            })
            .finally(() => in_flight.delete(key)));
    }
    return await in_flight.get(key);
}
