const fs = require('fs-extra');
const { v4: uuid } = require('uuid');
const path = require('path');
const { StringDecoder } = require('string_decoder');
const NodeID3 = require('node-id3')
const Mutex = require('async-mutex').Mutex;

const logger = require('./logger');
const CONSTS = require('./consts');
const youtubedl_api = require('./youtube-dl');
const config_api = require('./config');
const twitch_api = require('./twitch');
const { create } = require('xmlbuilder2');
const categories_api = require('./categories');
const utils = require('./utils');
const db_api = require('./db');
const files_api = require('./files');
const notifications_api = require('./notifications');
const archive_api = require('./archive');

const mutex = new Mutex();
let should_check_downloads = true;

const download_to_child_process = {};
const download_progress = {};

// only folders named like a download uid are ever removed from the temporary download folder
const TEMP_DIR_NAME_REGEX = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

if (db_api.database_initialized) {
    exports.setupDownloads();
} else {
    db_api.database_initialized_bs.subscribe(init => {
        if (init) exports.setupDownloads();
    });
}

/*

This file handles all the downloading functionality.

To download a file, we go through 4 steps. Here they are with their respective index & function:

0: Create the download
 - createDownload()
1: Get info for the download (we need this step for categories and archive functionality)
 - collectInfo()
2: Download the file
 - downloadQueuedFile()
3: Complete
 - N/A

We use checkDownloads() to move downloads through the steps and call their respective functions.

*/

exports.createDownload = async (url, type, options, user_uid = null, sub_id = null, sub_name = null, prefetched_info = null, paused = false) => {
    return await mutex.runExclusive(async () => {
        const download = {
            url: url,
            type: type,
            title: '',
            user_uid: user_uid,
            sub_id: sub_id,
            sub_name: sub_name,
            prefetched_info: prefetched_info,
            options: options,
            uid: uuid(),
            step_index: 0,
            paused: paused,
            running: false,
            finished_step: true,
            error: null,
            percent_complete: null,
            finished: false,
            timestamp_start: Date.now()
        };
        await db_api.insertRecordIntoTable('download_queue', download);
    
        should_check_downloads = true;
        return download;
    });
}

exports.pauseDownload = async (download_uid) => {
    const download = await db_api.getRecord('download_queue', {uid: download_uid});
    if (download['paused']) {
        logger.warn(`Download ${download_uid} is already paused!`);
        return false;
    } else if (download['finished']) {
        logger.verbose(`Download ${download_uid} could not be paused before completing.`);
        return false;
    } else {
        logger.info(`Pausing download ${download_uid}`);
    }

    killActiveDownload(download);
    const update_obj = {paused: true, running: false};
    // the download step runs again on resume and continues from the partial files
    if (download['step_index'] === 2) Object.assign(update_obj, {step_index: 1, finished_step: true});
    return await db_api.updateRecord('download_queue', {uid: download_uid}, update_obj);
}

exports.resumeDownload = async (download_uid) => {
    return await mutex.runExclusive(async () => {
        const download = await db_api.getRecord('download_queue', {uid: download_uid});
        if (!download['paused']) {
            logger.warn(`Download ${download_uid} is not paused!`);
            return false;
        }

        const success = db_api.updateRecord('download_queue', {uid: download_uid}, {paused: false});
        should_check_downloads = true;
        return success;
    })
}

exports.restartDownload = async (download_uid) => {
    const download = await db_api.getRecord('download_queue', {uid: download_uid});
    await exports.clearDownload(download_uid);
    const new_download = await exports.createDownload(download['url'], download['type'], download['options'], download['user_uid']);

    should_check_downloads = true;
    return new_download;
}

exports.cancelDownload = async (download_uid) => {
    const download = await db_api.getRecord('download_queue', {uid: download_uid});
    if (download['cancelled']) {
        logger.warn(`Download ${download_uid} is already cancelled!`);
        return false;
    } else if (download['finished']) {
        logger.verbose(`Download ${download_uid} could not be cancelled before completing.`);
        return false;
    } else {
        logger.info(`Cancelling download ${download_uid}`);
    }

    killActiveDownload(download);
    await handleDownloadError(download_uid, 'Cancelled', 'cancelled');
    await removeTempDir(download);
    return await db_api.updateRecord('download_queue', {uid: download_uid}, {cancelled: true});
}

exports.clearDownload = async (download_uid) => {
    const download = await db_api.getRecord('download_queue', {uid: download_uid});
    const success = await db_api.removeRecord('download_queue', {uid: download_uid});
    if (download) await removeTempDir(download);
    return success;
}

exports.withLiveProgress = (download) => {
    const percent_complete = download_progress[download['uid']];
    return percent_complete === undefined ? {...download} : {...download, percent_complete: percent_complete};
}

async function handleDownloadError(download_uid, error_message, error_type = null) {
    if (!download_uid) return;
    const download = await db_api.getRecord('download_queue', {uid: download_uid});
    if (!download || download['error']) return;
    notifications_api.sendDownloadErrorNotification(download, download['user_uid'], error_message, error_type);
    await db_api.updateRecord('download_queue', {uid: download['uid']}, {error: error_message, finished: true, running: false, error_type: error_type});
}

exports.setupDownloads = async () => {
    await fixDownloadState();
    await exports.sweepTempDownloads();
    setInterval(checkDownloads, 1000);
}

function getTempRoot() {
    if (config_api.getConfigItem('ytdl_default_downloader') !== 'yt-dlp') return null;
    return config_api.getConfigItem('ytdl_temp_download_path') || null;
}

function getTempDir(download) {
    const temp_root = getTempRoot();
    return temp_root ? path.join(temp_root, download['uid']) : null;
}

async function removeTempDir(download) {
    const temp_dir = getTempDir(download);
    if (!temp_dir) return;
    try {
        await fs.remove(temp_dir);
    } catch (e) {
        logger.warn(`Failed to remove temporary download folder ${temp_dir}: ${e.message}`);
    }
}

// partial files are only kept for unfinished downloads, which continue from them
exports.sweepTempDownloads = async () => {
    try {
        const temp_root = getTempRoot();
        if (!temp_root || !(await fs.pathExists(temp_root))) return;

        const downloads = await db_api.getRecords('download_queue');
        const unfinished = new Set(downloads.filter(download => !download['finished']).map(download => download['uid']));

        for (const name of await fs.readdir(temp_root)) {
            if (!TEMP_DIR_NAME_REGEX.test(name) || unfinished.has(name)) continue;
            const temp_dir = path.join(temp_root, name);
            await fs.remove(temp_dir);
            logger.verbose(`Removed leftover temporary download folder ${temp_dir}`);
        }
    } catch (e) {
        logger.warn(`Failed to clean up the temporary download folder: ${e.message}`);
    }
}

function getDownloadProcessArgs(download) {
    if (config_api.getConfigItem('ytdl_default_downloader') !== 'yt-dlp') return [];

    const progress_template = `download:${CONSTS.DOWNLOAD_PROGRESS_PREFIX} %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s %(progress.filename)s`;
    const process_args = ['--progress', '--newline', '--progress-delta', '1', '--progress-template', progress_template];

    const temp_dir = getTempDir(download);
    const args_set_paths = download['args'].some(arg => arg === '-P' || arg === '--paths' || arg.startsWith('--paths='));
    if (temp_dir && !args_set_paths) process_args.push('--paths', `temp:${path.resolve(temp_dir)}`);

    return process_args;
}

// Progress is read from the lines yt-dlp prints for each file it downloads, one video is usually
// several files (video, audio, subtitles), so their bytes are summed against the expected total.
function trackDownloadProgress(download, child_process) {
    const expected_file_size = download['expected_file_size'];
    const files = {};
    const decoder = new StringDecoder('utf8');
    let buffered = '';
    child_process.stdout.on('data', chunk => {
        const lines = (buffered + decoder.write(chunk)).split(/\r?\n/);
        buffered = lines.pop();
        for (const line of lines) {
            if (!line.startsWith(CONSTS.DOWNLOAD_PROGRESS_PREFIX)) continue;
            const [downloaded, total, total_estimate, ...filename] = line.slice(CONSTS.DOWNLOAD_PROGRESS_PREFIX.length).trim().split(' ');
            files[filename.join(' ')] = {downloaded: Number(downloaded) || 0, total: Number(total) || Number(total_estimate) || 0};

            const file_progresses = Object.values(files);
            const downloaded_size = file_progresses.reduce((sum, file) => sum + file.downloaded, 0);
            const total_size = expected_file_size || file_progresses.reduce((sum, file) => sum + file.total, 0);
            if (total_size) download_progress[download['uid']] = Math.min(downloaded_size / total_size * 100, 100).toFixed(2);
        }
    });
}

async function fixDownloadState() {
    const downloads = await db_api.getRecords('download_queue');
    downloads.sort((download1, download2) => download1.timestamp_start - download2.timestamp_start);
    const running_downloads = downloads.filter(download => !download['finished'] && !download['error']);
    for (let i = 0; i < running_downloads.length; i++) {
        const running_download = running_downloads[i];
        const update_obj = {finished_step: true, paused: true, running: false};
        if (running_download['step_index'] > 0) {
            update_obj['step_index'] = running_download['step_index'] - 1;
        }
        await db_api.updateRecord('download_queue', {uid: running_download['uid']}, update_obj);
    }
}

async function checkDownloads() {
    if (!should_check_downloads) return;

    const downloads = await db_api.getRecords('download_queue');
    downloads.sort((download1, download2) => download1.timestamp_start - download2.timestamp_start);

    await mutex.runExclusive(async () => {
        // avoid checking downloads unnecessarily, but double check that should_check_downloads is still true
        const running_downloads = downloads.filter(download => !download['paused'] && !download['finished']);
        if (running_downloads.length === 0) {
            should_check_downloads = false;
            logger.verbose('Disabling checking downloads as none are available.');
        }
        return;
    });

    let running_downloads_count = downloads.filter(download => download['running']).length;
    const waiting_downloads = downloads.filter(download => !download['paused'] && download['finished_step'] && !download['finished']);
    for (let i = 0; i < waiting_downloads.length; i++) {
        const waiting_download = waiting_downloads[i];
        const max_concurrent_downloads = config_api.getConfigItem('ytdl_max_concurrent_downloads');
        if (max_concurrent_downloads < 0 || running_downloads_count >= max_concurrent_downloads) break;

        if (waiting_download['finished_step'] && !waiting_download['finished']) {
            if (waiting_download['sub_id']) {
                const sub_missing = !(await db_api.getRecord('subscriptions', {id: waiting_download['sub_id']}));
                if (sub_missing) {
                    handleDownloadError(waiting_download['uid'], `Download failed as subscription with id '${waiting_download['sub_id']}' is missing!`, 'sub_id_missing');
                    continue;
                }
            }
            // move to next step
            running_downloads_count++;
            if (waiting_download['step_index'] === 0) {
                exports.collectInfo(waiting_download['uid']);
            } else if (waiting_download['step_index'] === 1) {
                exports.downloadQueuedFile(waiting_download['uid']);
            }
        }
    }
}

function killActiveDownload(download) {
    const child_process = download_to_child_process[download['uid']];
    if (download['step_index'] === 2 && child_process) {
        youtubedl_api.killYoutubeDLProcess(child_process);
        delete download_to_child_process[download['uid']];
    }
}

exports.collectInfo = async (download_uid) => {
    const download = await db_api.getRecord('download_queue', {uid: download_uid});
    if (download['paused']) {
        return;
    }
    logger.verbose(`Collecting info for download ${download_uid}`);
    await db_api.updateRecord('download_queue', {uid: download_uid}, {step_index: 1, finished_step: false, running: true});

    const url = download['url'];
    const type = download['type'];
    const options = download['options'];

    if (download['user_uid'] && !options.customFileFolderPath) {
        let usersFileFolder = config_api.getConfigItem('ytdl_users_base_path');
        const user_path = path.join(usersFileFolder, download['user_uid'], type);
        options.customFileFolderPath = user_path + path.sep;
    }

    let args = await exports.generateArgs(url, type, options, download['user_uid']);

    // get video info prior to download
    let info = download['prefetched_info'] ? download['prefetched_info'] : await exports.getVideoInfoByURL(url, args, download_uid);

    if (!info || info.length === 0) {
        // info failed, error presumably already recorded
        return;
    }

    // in subscriptions we don't care if archive mode is enabled, but we already removed archived videos from subs by this point
    const useYoutubeDLArchive = config_api.getConfigItem('ytdl_use_youtubedl_archive');
    if (useYoutubeDLArchive && !options.ignoreArchive && info.length === 1) {
        const info_obj = info[0];
        const exists_in_archive = await archive_api.existsInArchive(info_obj['extractor'], info_obj['id'], type, download['user_uid'], download['sub_id']);
        if (exists_in_archive) {
            const error = `File '${info_obj['title']}' already exists in archive! Disable the archive or override to continue downloading.`;
            logger.warn(error);
            if (download_uid) {
                await handleDownloadError(download_uid, error, 'exists_in_archive');
                return;
            }
        }
    }

    let category = null;

    // check if it fits into a category. If so, then get info again using new args
    if (info.length === 1 || config_api.getConfigItem('ytdl_allow_playlist_categorization')) category = await categories_api.categorize(info);

    // set custom output if the category has one and re-retrieve info so the download manager has the right file name
    if (category && category['custom_output']) {
        options.customOutput = category['custom_output'];
        options.noRelativePath = true;
        args = await exports.generateArgs(url, type, options, download['user_uid']);
        info = await exports.getVideoInfoByURL(url, args, download_uid);
    }

    const stripped_category = category ? {name: category['name'], uid: category['uid']} : null;

    const expected_file_size = utils.getExpectedFileSize(info);

    const title = info.length > 1 ? info[0]['playlist_title'] || info[0]['playlist'] : info[0]['title'];
    await db_api.updateRecord('download_queue', {uid: download_uid}, {args: args,
                                                                    finished_step: true,
                                                                    running: false,
                                                                    options: options,
                                                                    expected_file_size: expected_file_size,
                                                                    title: title,
                                                                    category: stripped_category,
                                                                    prefetched_info: null
                                                                });
}

exports.downloadQueuedFile = async(download_uid, customDownloadHandler = null) => {
    const download = await db_api.getRecord('download_queue', {uid: download_uid});
    if (download['paused']) {
        return;
    }
    logger.verbose(`Downloading ${download_uid}`);
    return new Promise(async resolve => {
        const audioFolderPath = config_api.getConfigItem('ytdl_audio_folder_path');
        const videoFolderPath = config_api.getConfigItem('ytdl_video_folder_path');
        const usersFolderPath = config_api.getConfigItem('ytdl_users_base_path');
        await db_api.updateRecord('download_queue', {uid: download_uid}, {step_index: 2, finished_step: false, running: true});

        const url = download['url'];
        const type = download['type'];
        const options = download['options'];
        const args = download['args'];
        const category = download['category'];
        let fileFolderPath = type === 'audio' ? audioFolderPath : videoFolderPath;
        if (options.customFileFolderPath) {
            fileFolderPath = options.customFileFolderPath;
        } else if (download['user_uid']) {
            fileFolderPath = path.join(usersFolderPath, download['user_uid'], type);
        }
        fs.ensureDirSync(fileFolderPath);

        const start_time = Date.now();

        const file_objs = [];
        // download file
        let {child_process, callback} = await youtubedl_api.runYoutubeDL(url, [...args, ...getDownloadProcessArgs(download)], customDownloadHandler);
        if (child_process) {
            download_to_child_process[download['uid']] = child_process;
            trackDownloadProgress(download, child_process);
        }
        const {parsed_output, err} = await callback;
        const last_percent_complete = download_progress[download['uid']];
        delete download_progress[download['uid']];
        let end_time = Date.now();
        let difference = (end_time - start_time)/1000;
        logger.debug(`${type === 'audio' ? 'Audio' : 'Video'} download delay: ${difference} seconds.`);
        if (!parsed_output) {
            const errored_download = await db_api.getRecord('download_queue', {uid: download_uid});
            if (!errored_download || errored_download['error_type'] === 'cancelled') {
                await removeTempDir(download);
                resolve(false);
                return;
            }
            if (last_percent_complete) await db_api.updateRecord('download_queue', {uid: download_uid}, {percent_complete: last_percent_complete});
            if (errored_download['paused']) {
                resolve(false);
                return;
            }
            const detail = utils.getCleanYoutubeDLError(err);
            logger.error(`Download failed for ${url}: ${detail}`);
            await handleDownloadError(download_uid, detail, 'unknown_error');
            await removeTempDir(download);
            resolve(false);
            return;
        } else if (parsed_output) {
            if (parsed_output.length === 0 || parsed_output[0].length === 0) {
                // ERROR!
                const error_message = `No output received for video download, check if it exists in your archive.`;
                await handleDownloadError(download_uid, error_message, 'no_output');
                logger.warn(error_message);
                resolve(false);
                return;
            }

            for (const output_json of parsed_output) {
                if (!output_json) {
                    continue;
                }

                // get filepath with no extension
                const filepath_no_extension = utils.removeFileExtension(output_json['_filename']);

                const ext = type === 'audio' ? '.mp3' : '.mp4';
                var full_file_path = filepath_no_extension + ext;
                var file_name = filepath_no_extension.substring(fileFolderPath.length, filepath_no_extension.length);

                if (type === 'video' && url.includes('twitch.tv/videos/') && url.split('twitch.tv/videos/').length > 1
                    && config_api.getConfigItem('ytdl_twitch_auto_download_chat')) {
                        let vodId = url.split('twitch.tv/videos/')[1];
                        vodId = vodId.split('?')[0];
                        twitch_api.downloadTwitchChatByVODID(vodId, file_name, type, download['user_uid']);
                }

                // renames file if necessary due to bug
                if (!fs.existsSync(output_json['_filename']) && fs.existsSync(output_json['_filename'] + '.webm')) {
                    try {
                        fs.renameSync(output_json['_filename'] + '.webm', output_json['_filename']);
                        logger.verbose('Renamed ' + file_name + '.webm to ' + file_name);
                    } catch(e) {
                        logger.error(`Failed to rename file ${output_json['_filename']} to its appropriate extension.`);
                    }
                }

                if (type === 'audio') {
                    let tags = {
                        title: output_json['title'],
                        artist: output_json['artist'] ? output_json['artist'] : output_json['uploader']
                    }
                    let success = NodeID3.write(tags, utils.removeFileExtension(output_json['_filename']) + '.mp3');
                    if (!success) logger.error('Failed to apply ID3 tag to audio file ' + output_json['_filename']);
                }

                if (config_api.getConfigItem('ytdl_generate_nfo_files')) {
                    exports.generateNFOFile(output_json, `${filepath_no_extension}.nfo`);
                }

                if (options.cropFileSettings) {
                    await utils.cropFile(full_file_path, options.cropFileSettings.cropFileStart, options.cropFileSettings.cropFileEnd, ext);
                }

                // registers file in DB
                const file_obj = await files_api.registerFileDB(full_file_path, type, download['user_uid'], category, download['sub_id'] ? download['sub_id'] : null, options.cropFileSettings);

                await archive_api.addToArchive(output_json['extractor'], output_json['id'], type, output_json['title'], download['user_uid'], download['sub_id']);

                notifications_api.sendDownloadNotification(file_obj, download['user_uid']);

                file_objs.push(file_obj);
            }

            let container = null;

            if (file_objs.length > 1) {
                // create playlist
                container = await files_api.createPlaylist(download['title'], file_objs.map(file_obj => file_obj.uid), download['user_uid']);
            } else if (file_objs.length === 1) {
                container = file_objs[0];
            } else {
                const error_message = 'Downloaded file failed to result in metadata object.';
                logger.error(error_message);
                await handleDownloadError(download_uid, error_message, 'no_metadata');
            }

            const file_uids = file_objs.map(file_obj => file_obj.uid);
            await db_api.updateRecord('download_queue', {uid: download_uid}, {finished_step: true, finished: true, running: false, step_index: 3, percent_complete: 100, file_uids: file_uids, container: container});
            await removeTempDir(download);
            resolve(file_uids);
        }
    });
}

// helper functions

exports.generateArgs = async (url, type, options, user_uid = null, simulated = false) => {
    const default_downloader = config_api.getConfigItem('ytdl_default_downloader');

    if (!simulated && (default_downloader === 'youtube-dl')) {
        logger.warn('It is recommended you use yt-dlp! To prevent failed downloads, change the downloader in your settings menu to yt-dlp and restart your instance.')
    }

    const audioFolderPath = config_api.getConfigItem('ytdl_audio_folder_path');
    const videoFolderPath = config_api.getConfigItem('ytdl_video_folder_path');
    const usersFolderPath = config_api.getConfigItem('ytdl_users_base_path');

    const videopath = config_api.getConfigItem('ytdl_default_file_output') ? config_api.getConfigItem('ytdl_default_file_output') : '%(title)s';
    const globalArgs = config_api.getConfigItem('ytdl_custom_args');
    const useCookies = config_api.getConfigItem('ytdl_use_cookies');
    const is_audio = type === 'audio';

    let fileFolderPath = type === 'audio' ? audioFolderPath : videoFolderPath; // TODO: fix
    if (options.customFileFolderPath) {
        fileFolderPath = options.customFileFolderPath;
    } else if (user_uid) {
        fileFolderPath = path.join(usersFolderPath, user_uid, fileFolderPath);
    }

    if (options.customFileFolderPath) fileFolderPath = options.customFileFolderPath;

    const customArgs = options.customArgs;
    let customOutput = options.customOutput;
    const customQualityConfiguration = options.customQualityConfiguration;

    // video-specific args
    const selectedHeight = options.selectedHeight;
    const maxHeight = options.maxHeight;
    const heightParam = selectedHeight || maxHeight;

    // audio-specific args
    const maxBitrate = options.maxBitrate;

    const youtubeUsername = options.youtubeUsername;
    const youtubePassword = options.youtubePassword;

    let downloadConfig = null;
    let qualityPath = (is_audio && !options.skip_audio_args) ? ['-f', 'bestaudio'] : ['-f', 'bestvideo+bestaudio', '--merge-output-format', 'mp4'];
    const is_youtube = url.includes('youtu');
    if (!is_audio && !is_youtube) {
        // tiktok videos fail when using the default format
        qualityPath = null;
    }

    if (customArgs) {
        downloadConfig = customArgs.split(',,');
    } else {
        if (customQualityConfiguration) {
            qualityPath = ['-f', customQualityConfiguration, '--merge-output-format', 'mp4'];
        } else if (heightParam && heightParam !== '' && !is_audio) {
            const heightFilter = (maxHeight && default_downloader === 'yt-dlp') ? ['-S', `res:${heightParam}`] : ['-f', `best[height${maxHeight ? '<' : ''}=${heightParam}]+bestaudio`]
            qualityPath = [...heightFilter, '--merge-output-format', 'mp4'];
        } else if (is_audio) {
            qualityPath = ['--audio-quality', maxBitrate ? maxBitrate : '0']
        }

        if (customOutput) {
            customOutput = options.noRelativePath ? customOutput : path.join(fileFolderPath, customOutput);
            downloadConfig = ['-o', `${customOutput}.%(ext)s`, '--write-info-json', '--print-json'];
        } else {
            downloadConfig = ['-o', path.join(fileFolderPath, videopath + (is_audio ? '.%(ext)s' : '.mp4')), '--write-info-json', '--print-json'];
        }

        if (qualityPath) downloadConfig.push(...qualityPath);

        if (is_audio && !options.skip_audio_args) {
            downloadConfig.push('-x');
            downloadConfig.push('--audio-format', 'mp3');
        }

        if (youtubeUsername && youtubePassword) {
            downloadConfig.push('--username', youtubeUsername, '--password', youtubePassword);
        }

        if (useCookies) {
            if (await fs.pathExists(path.join(__dirname, 'appdata', 'cookies.txt'))) {
                downloadConfig.push('--cookies', path.join('appdata', 'cookies.txt'));
            } else {
                logger.warn('Cookies file could not be found. You can either upload one, or disable \'use cookies\' in the Advanced tab in the settings.');
            }
        }

        const useDefaultDownloadingAgent = config_api.getConfigItem('ytdl_use_default_downloading_agent');
        const customDownloadingAgent = config_api.getConfigItem('ytdl_custom_downloading_agent');
        if (!useDefaultDownloadingAgent && customDownloadingAgent) {
            downloadConfig.splice(0, 0, '--external-downloader', customDownloadingAgent);
        }

        if (config_api.getConfigItem('ytdl_include_thumbnail')) {
            downloadConfig.push('--write-thumbnail');
        }

        if (globalArgs && globalArgs !== '') {
            // adds global args
            if (downloadConfig.indexOf('-o') !== -1 && globalArgs.split(',,').indexOf('-o') !== -1) {
                // if global args has an output, replce the original output with that of global args
                const original_output_index = downloadConfig.indexOf('-o');
                downloadConfig.splice(original_output_index, 2);
            }
            downloadConfig = downloadConfig.concat(globalArgs.split(',,'));
        }

        if (options.additionalArgs && options.additionalArgs !== '') {
            downloadConfig = utils.injectArgs(downloadConfig, options.additionalArgs.split(',,'));
        }

        const rate_limit = config_api.getConfigItem('ytdl_download_rate_limit');
        if (rate_limit && downloadConfig.indexOf('-r') === -1 && downloadConfig.indexOf('--limit-rate') === -1) {
            downloadConfig.push('-r', rate_limit);
        }
        
        if (default_downloader === 'yt-dlp') {
            downloadConfig = utils.filterArgs(downloadConfig, ['--print-json']);

            // in yt-dlp -j --no-simulate is preferable
            downloadConfig.push('--no-clean-info-json', '-j', '--no-simulate');
        }

    }

    // filter out incompatible args
    downloadConfig = filterArgs(downloadConfig, is_audio);

    if (!simulated) logger.verbose(`${default_downloader} args being used: ${downloadConfig.join(',')}`);
    return downloadConfig;
}

exports.getVideoInfoByURL = async (url, args = [], download_uid = null) => {
    // remove bad args
    const temp_args = utils.filterArgs(args, ['--no-simulate']);
    const new_args = [...temp_args];

    const archiveArgIndex = new_args.indexOf('--download-archive');
    if (archiveArgIndex !== -1) {
        new_args.splice(archiveArgIndex, 2);
    }

    new_args.push('--dump-json');

    let {callback} = await youtubedl_api.runYoutubeDL(url, new_args);
    const {parsed_output, err} = await callback;
    if (!parsed_output || parsed_output.length === 0) {
        const detail = utils.getCleanYoutubeDLError(err);
        logger.error(`Failed to retrieve info for ${url}: ${detail}`);
        if (download_uid) {
            await handleDownloadError(download_uid, detail, 'info_retrieve_failed');
        }
        return null;
    }

    return parsed_output;
}

function filterArgs(args, isAudio) {
    const video_only_args = ['--add-metadata', '--embed-subs', '--xattrs'];
    const audio_only_args = ['-x', '--extract-audio', '--embed-thumbnail'];
    return utils.filterArgs(args, isAudio ? video_only_args : audio_only_args);
}

exports.generateNFOFile = (info, output_path) => {
    const nfo_obj = {
        episodedetails: {
            title: info['fulltitle'],
            episode: info['playlist_index'] ? info['playlist_index'] : undefined,
            premiered: utils.formatDateString(info['upload_date']),
            plot: `${info['uploader_url']}\n${info['description']}\n${info['playlist_title'] ? info['playlist_title'] : ''}`,
            director: info['artist'] ? info['artist'] : info['uploader']
        }
    };
    const doc = create(nfo_obj);
    const xml = doc.end({ prettyPrint: true });
    fs.writeFileSync(output_path, xml);
}
