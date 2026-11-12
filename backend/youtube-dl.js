const fs = require('fs-extra');
const fetch = require('node-fetch');
const path = require('path');
const execa = require('execa');
const kill = require('tree-kill');

const logger = require('./logger');
const utils = require('./utils');
const CONSTS = require('./consts');
const config_api = require('./config.js');

const is_windows = process.platform === 'win32';

exports.youtubedl_forks = {
    'youtube-dl': {
        'download_url': 'https://github.com/ytdl-org/youtube-dl/releases/latest/download/youtube-dl',
        'tags_url': 'https://api.github.com/repos/ytdl-org/youtube-dl/tags'
    },
    'yt-dlp': {
        'download_url': 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp',
        'tags_url': 'https://api.github.com/repos/yt-dlp/yt-dlp/tags'
    }
}

exports.runYoutubeDL = async (url, args, customDownloadHandler = null) => {
    const output_file_path = getYoutubeDLPath();
    if (!fs.existsSync(output_file_path)) await exports.checkForYoutubeDLUpdate();
    let callback = null;
    let child_process = null;
    if (customDownloadHandler) {
        callback = runYoutubeDLCustom(url, args, customDownloadHandler);
    } else {
        ({callback, child_process} = await runYoutubeDLProcess(url, args));
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
const runYoutubeDLProcess = async (url, args, youtubedl_fork = config_api.getConfigItem('ytdl_default_downloader')) => {
    const youtubedl_path = getYoutubeDLPath(youtubedl_fork);
    const binary_exists = fs.existsSync(youtubedl_path);
    if (!binary_exists) {
        const err = `Could not find path for ${youtubedl_fork} at ${youtubedl_path}`;
        logger.error(err);
        return;
    }
    const child_process = execa(getYoutubeDLPath(youtubedl_fork), [url, ...args], {maxBuffer: Infinity});
    const callback = new Promise(async resolve => {
        try {
            const {stdout, stderr} = await child_process;
            const output_lines = stdout.trim().split(/\r?\n/).filter(line => !line.startsWith(CONSTS.DOWNLOAD_PROGRESS_PREFIX));
            const parsed_output = utils.parseOutputJSON(output_lines, stderr);
            resolve({parsed_output, err: stderr});
        } catch (e) {
            resolve({parsed_output: null, err: e})
        }
    });
    return {child_process, callback}
}

function getYoutubeDLPath(youtubedl_fork = config_api.getConfigItem('ytdl_default_downloader')) {
    const binary_file_name = youtubedl_fork + (is_windows ? '.exe' : '');
    const binary_path = path.join('appdata', 'bin', binary_file_name);
    return binary_path;
}

exports.killYoutubeDLProcess = async (child_process) => {
    kill(child_process.pid, 'SIGKILL');
}

exports.binaryExists = (youtubedl_fork = config_api.getConfigItem('ytdl_default_downloader')) => {
    return fs.existsSync(getYoutubeDLPath(youtubedl_fork));
}

exports.checkForYoutubeDLUpdate = async () => {
    const selected_fork = config_api.getConfigItem('ytdl_default_downloader');
    const output_file_path = getYoutubeDLPath();
    // get current version, details are keyed by fork so each one keeps its own version
    const current_app_details = fs.existsSync(CONSTS.DETAILS_BIN_PATH) ? fs.readJSONSync(CONSTS.DETAILS_BIN_PATH) : {};
    if (!current_app_details[selected_fork]) {
        logger.warn(`Failed to get ${selected_fork} binary details at location '${CONSTS.DETAILS_BIN_PATH}'. Generating file...`);
        updateDetailsJSON(CONSTS.OUTDATED_YOUTUBEDL_VERSION, selected_fork, output_file_path);
    }
    const current_version = current_app_details[selected_fork] ? current_app_details[selected_fork]['version'] : null;

    const latest_version = await exports.getLatestUpdateVersion(selected_fork);
    // keep running the binary we have rather than redownloading blindly when the version check fails
    if (!latest_version) return;

    // if the binary does not exist, or if the fork has been updated, redownload
    if (fs.existsSync(output_file_path) && current_version === latest_version) return;

    logger.info(`Updating ${selected_fork} binary to '${output_file_path}', downloading...`);
    await exports.updateYoutubeDL(latest_version);
}

exports.updateYoutubeDL = async (latest_update_version, custom_output_path = null) => {
    await fs.ensureDir(path.join('appdata', 'bin'));
    const default_downloader = config_api.getConfigItem('ytdl_default_downloader');
    await downloadLatestYoutubeDLBinaryGeneric(default_downloader, latest_update_version, custom_output_path);
}

async function downloadLatestYoutubeDLBinaryGeneric(youtubedl_fork, new_version, custom_output_path = null) {
    const file_ext = is_windows ? '.exe' : '';

    // build the URL
    const download_url = `${exports.youtubedl_forks[youtubedl_fork]['download_url']}${file_ext}`;
    const output_path = custom_output_path || getYoutubeDLPath(youtubedl_fork);
    // download to a temp file and rename, writing in place would fail while the binary is running
    // and would leave a truncated binary behind if the download dies halfway
    const temp_path = `${output_path}.part`;

    try {
        await utils.fetchFile(download_url, temp_path, `${youtubedl_fork} ${new_version}`);
        await fs.chmod(temp_path, 0o755);
        await fs.move(temp_path, output_path, {overwrite: true});

        updateDetailsJSON(new_version, youtubedl_fork, output_path);
    } catch (e) {
        logger.error(`Failed to download new ${youtubedl_fork} version: ${new_version}`);
        logger.error(e);
        await fs.remove(temp_path).catch(() => {});
        return;
    }
}

exports.getLatestUpdateVersion = async (youtubedl_fork) => {
    const tags_url = exports.youtubedl_forks[youtubedl_fork]['tags_url'];
    return new Promise(resolve => {
        fetch(tags_url, {method: 'Get'})
        .then(async res => res.json())
        .then(async (json) => {
            if (!json || !json[0]) {
                logger.error(`Failed to check ${youtubedl_fork} version for an update.`)
                resolve(null);
                return;
            }
            const latest_update_version = json[0]['name'];
            resolve(latest_update_version);
        })
        .catch(err => {
            logger.error(`Failed to check ${youtubedl_fork} version for an update.`)
            logger.error(err);
            resolve(null);
        });
    });
}

function updateDetailsJSON(new_version, fork, output_path) {
    const file_ext = is_windows ? '.exe' : '';
    const details_json = fs.existsSync(CONSTS.DETAILS_BIN_PATH) ? fs.readJSONSync(CONSTS.DETAILS_BIN_PATH) : {};
    if (!details_json[fork]) details_json[fork] = {};
    const fork_json = details_json[fork];
    fork_json['version'] = new_version;
    fork_json['downloader'] = fork;
    fork_json['path'] = output_path; // unused
    fork_json['exec'] = fork + file_ext; // unused
    fs.writeJSONSync(CONSTS.DETAILS_BIN_PATH, details_json);
}
