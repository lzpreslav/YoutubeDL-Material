const fs = require('fs-extra');
const fetch = require('node-fetch');
const path = require('path');
const execa = require('execa');
const kill = require('tree-kill');

const logger = require('./logger');
const utils = require('./utils');
const CONSTS = require('./consts');

const is_windows = process.platform === 'win32';

const DOWNLOADER = 'yt-dlp';
const DOWNLOAD_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';
const LATEST_RELEASE_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest';

exports.runYoutubeDL = async (url, args, customDownloadHandler = null) => {
    if (!exports.binaryExists()) await exports.checkForYoutubeDLUpdate();
    let callback = null;
    let child_process = null;
    if (customDownloadHandler) {
        callback = runYoutubeDLCustom(url, args, customDownloadHandler);
    } else {
        ({callback, child_process} = await exports.runYoutubeDLProcess(url, args));
    }

    return {child_process, callback};
}

// Run youtube-dl directly (not cancellable)
const runYoutubeDLCustom = async (url, args, customDownloadHandler) => {
    const downloadHandler = customDownloadHandler;
    return new Promise(resolve => {
        downloadHandler(url, args, {maxBuffer: Infinity}, async function(err, output) {
            const parsed_output = utils.parseOutputJSON(output, err);
            resolve({parsed_output, err});
        });
    });
}

// Run youtube-dl in a subprocess (cancellable)
exports.runYoutubeDLProcess = async (url, args, binary_path = getYoutubeDLPath()) => {
    if (!fs.existsSync(binary_path)) {
        logger.error(`Could not find ${DOWNLOADER} at ${binary_path}`);
        return;
    }
    const child_process = execa(binary_path, [url, ...args], {maxBuffer: Infinity});
    const callback = new Promise(async resolve => {
        try {
            const {stdout, stderr} = await child_process;
            resolve({parsed_output: parseProcessOutput(stdout, stderr), err: stderr});
        } catch (e) {
            // yt-dlp exits non-zero when any video fails, the videos it did get through are still printed
            const partial_output = typeof e.stdout === 'string' ? parseProcessOutput(e.stdout, null) : null;
            resolve({parsed_output: null, partial_output, err: e})
        }
    });
    return {child_process, callback}
}

function parseProcessOutput(stdout, stderr) {
    const output_lines = stdout.trim().split(/\r?\n/).filter(line => !line.startsWith(CONSTS.DOWNLOAD_PROGRESS_PREFIX));
    return utils.parseOutputJSON(output_lines, stderr);
}

function getYoutubeDLPath() {
    return path.join('appdata', 'bin', DOWNLOADER + (is_windows ? '.exe' : ''));
}

exports.killYoutubeDLProcess = async (child_process) => {
    kill(child_process.pid, 'SIGKILL');
}

exports.binaryExists = () => {
    return fs.existsSync(getYoutubeDLPath());
}

exports.checkForYoutubeDLUpdate = async () => {
    const output_file_path = getYoutubeDLPath();
    // the details file is keyed by downloader name
    const current_app_details = fs.existsSync(CONSTS.DETAILS_BIN_PATH) ? fs.readJSONSync(CONSTS.DETAILS_BIN_PATH) : {};
    if (!current_app_details[DOWNLOADER]) {
        logger.warn(`Failed to get ${DOWNLOADER} binary details at location '${CONSTS.DETAILS_BIN_PATH}'. Generating file...`);
        updateDetailsJSON(CONSTS.OUTDATED_YOUTUBEDL_VERSION, output_file_path);
    }
    const current_version = current_app_details[DOWNLOADER] ? current_app_details[DOWNLOADER]['version'] : null;

    const latest_version = await exports.getLatestUpdateVersion();
    const binary_exists = fs.existsSync(output_file_path);
    // keep running the binary we have rather than redownloading blindly when the version check fails
    if (binary_exists && (!latest_version || current_version === latest_version)) return;

    logger.info(`Updating ${DOWNLOADER} binary to '${output_file_path}', downloading...`);
    // a download of unknown version is recorded as outdated, so the next successful check replaces it
    await exports.updateYoutubeDL(latest_version || CONSTS.OUTDATED_YOUTUBEDL_VERSION);
}

exports.updateYoutubeDL = async (new_version, custom_output_path = null) => {
    await fs.ensureDir(path.join('appdata', 'bin'));
    const download_url = `${DOWNLOAD_URL}${is_windows ? '.exe' : ''}`;
    const output_path = custom_output_path || getYoutubeDLPath();
    // download to a temp file and rename, writing in place would fail while the binary is running
    // and would leave a truncated binary behind if the download dies halfway
    const temp_path = `${output_path}.part`;

    try {
        await utils.fetchFile(download_url, temp_path, `${DOWNLOADER} ${new_version}`);
        await fs.chmod(temp_path, 0o755);
        await fs.move(temp_path, output_path, {overwrite: true});

        updateDetailsJSON(new_version, output_path);
    } catch (e) {
        logger.error(`Failed to download new ${DOWNLOADER} version: ${new_version}`);
        logger.error(e);
        await fs.remove(temp_path).catch(() => {});
        return;
    }
}

exports.getLatestUpdateVersion = async () => {
    try {
        // the latest release redirects to its tag, which unlike the GitHub API is not rate limited per IP
        const res = await fetch(LATEST_RELEASE_URL, {method: 'HEAD', redirect: 'manual'});
        const location = res.headers.get('location') || '';
        const version = location.split('/releases/tag/')[1];
        if (version) return version;
        logger.error(`Failed to check ${DOWNLOADER} version for an update.`);
    } catch (err) {
        logger.error(`Failed to check ${DOWNLOADER} version for an update.`);
        logger.error(err);
    }
    return null;
}

function updateDetailsJSON(new_version, output_path) {
    const details_json = fs.existsSync(CONSTS.DETAILS_BIN_PATH) ? fs.readJSONSync(CONSTS.DETAILS_BIN_PATH) : {};
    details_json[DOWNLOADER] = {version: new_version, downloader: DOWNLOADER, path: output_path};
    fs.writeJSONSync(CONSTS.DETAILS_BIN_PATH, details_json);
}
