const db_api = require('./db');
const config_api = require('./config');
const logger = require('./logger');
const utils = require('./utils');

const { v4: uuid } = require('uuid');

const fetch = require('node-fetch');
const { gotify } = require("gotify");

const NOTIFICATION_TYPE_TO_TITLE = {
    task_finished: 'Task finished',
    download_complete: 'Download complete',
    download_error: 'Download error'
}

const NOTIFICATION_TYPE_TO_BODY = {
    task_finished: (notification) => notification['data']['task_title'],
    download_complete: (notification) => {return `${notification['data']['file_title']}\nOriginal URL: ${notification['data']['original_url']}`},
    download_error: (notification) => {return `Error: ${notification['data']['download_error_message']}\nError code: ${notification['data']['download_error_type']}\n\nOriginal URL: ${notification['data']['download_url']}`}
}

const NOTIFICATION_TYPE_TO_URL = {
    task_finished: () => {return `${utils.getBaseURL()}/#/tasks`},
    download_complete: (notification) => {return `${utils.getBaseURL()}/#/player;uid=${notification['data']['file_uid']}`},
    download_error: () => {return `${utils.getBaseURL()}/#/downloads`},
}

const NOTIFICATION_TYPE_TO_THUMBNAIL = {
    task_finished: () => null,
    download_complete: (notification) => notification['data']['file_thumbnail'],
    download_error: () => null
}

exports.sendNotification = async (notification) => {
    // info necessary if we are using 3rd party APIs
    const type = notification['type'];

    const data = {
        title: NOTIFICATION_TYPE_TO_TITLE[type],
        body: NOTIFICATION_TYPE_TO_BODY[type](notification),
        type: type,
        url: NOTIFICATION_TYPE_TO_URL[type](notification),
        thumbnail: NOTIFICATION_TYPE_TO_THUMBNAIL[type](notification)
    }

    if (config_api.getConfigItem('ytdl_use_ntfy_API') && config_api.getConfigItem('ytdl_ntfy_topic_url')) {
        sendNtfyNotification(data);
    }
    if (config_api.getConfigItem('ytdl_use_gotify_API') && config_api.getConfigItem('ytdl_gotify_server_url') && config_api.getConfigItem('ytdl_gotify_app_token')) {
        sendGotifyNotification(data);
    }
    if (config_api.getConfigItem('ytdl_webhook_url')) {
        sendGenericNotification(data);
    }
    if (config_api.getConfigItem('ytdl_slack_webhook_url')) {
        sendSlackNotification(data);
    }

    await db_api.insertRecordIntoTable('notifications', notification);
    return notification;
}

exports.sendTaskNotification = async (task_obj, confirmed) => {
    if (!notificationEnabled('task_finished')) return;
    // workaround for tasks which are user_uid agnostic
    const user_uid = config_api.getConfigItem('ytdl_multi_user_mode') ? 'admin' : null;
    await db_api.removeAllRecords('notifications', {"data.task_key": task_obj.key});
    const data = {task_key: task_obj.key, task_title: task_obj.title, confirmed: confirmed};
    const notification = exports.createNotification('task_finished', ['view_tasks'], data, user_uid);
    return await exports.sendNotification(notification);
}

exports.sendDownloadNotification = async (file, user_uid) => {
    if (!notificationEnabled('download_complete')) return;
    const data = {file_uid: file.uid, file_title: file.title, file_thumbnail: file.thumbnailURL, original_url: file.url};
    const notification = exports.createNotification('download_complete', ['play'], data, user_uid);
    return await exports.sendNotification(notification);
}

exports.sendDownloadErrorNotification = async (download, user_uid, error_message, error_type = null) => {
    if (!notificationEnabled('download_error')) return;
    const data = {download_uid: download.uid, download_url: download.url, download_error_message: error_message, download_error_type: error_type};
    const notification = exports.createNotification('download_error', ['view_download_error', 'retry_download'], data, user_uid);
    return await exports.sendNotification(notification);
}

exports.createNotification = (type, actions, data, user_uid) => {
    const notification = {
        type: type,
        actions: actions,
        data: data,
        user_uid: user_uid,
        uid: uuid(),
        read: false,
        timestamp: Date.now()/1000
    }
    return notification;
}

function notificationEnabled(type) {
    return config_api.getConfigItem('ytdl_enable_notifications') && (config_api.getConfigItem('ytdl_enable_all_notifications') || config_api.getConfigItem('ytdl_allowed_notification_types').includes(type));
}

// ntfy

function sendNtfyNotification({body, title, type, url, thumbnail}) {
    logger.verbose('Sending notification to ntfy');
    fetch(config_api.getConfigItem('ytdl_ntfy_topic_url'), {
        method: 'POST',
        body: body,
        headers: {
            'Title': title,
            'Tags': type,
            'Click': url,
            'Attach': thumbnail
        }
    });
}

// Gotify

async function sendGotifyNotification({body, title, type, url, thumbnail}) {
    logger.verbose('Sending notification to gotify');
    await gotify({
        server: config_api.getConfigItem('ytdl_gotify_server_url'),
        app: config_api.getConfigItem('ytdl_gotify_app_token'),
        title: title,
        message: body,
        tag: type,
        priority: 5, // Keeping default from docs, may want to change this,
        extras: {
            "client::notification": {
                click: { url: url },
                bigImageUrl: thumbnail
            }
        }
      });
}

// Slack

function sendSlackNotification({body, title, type, url, thumbnail}) {
    const slack_webhook_url = config_api.getConfigItem('ytdl_slack_webhook_url');
    logger.verbose(`Sending slack notification to ${slack_webhook_url}`);
    const data = {
        blocks: [
            {
                type: "section",
                text: {
                    type: "mrkdwn",
                    text: `*${title}*`
                }
            },
            {
                type: "section",
                text: {
                    type: "plain_text",
                    text: body
                }
            }
        ]
    }

    // add thumbnail if exists
    if (thumbnail) {
        data['blocks'].push({
            type: "image",
            image_url: thumbnail,
            alt_text: "notification_thumbnail"
        });
    }

    data['blocks'].push(
        {
            type: "section",
            text: {
                type: "mrkdwn",
                text: `<${url}|${url}>`
            }
        },
        {
            type: "context",
            elements: [
                {
                    type: "mrkdwn",
                    text: `*ID:* ${type}`
                }
            ]
        }
    );

    fetch(slack_webhook_url, {
        method: 'POST',
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify(data),
    }).then(async (res) => {
        if (!res.ok) logger.error(`Failed to send slack notification: ${res.status} ${await res.text()}`);
    }).catch((err) => {
        logger.error(`Failed to send slack notification: ${err}`);
    });
}

// Generic

function sendGenericNotification(data) {
    const webhook_url = config_api.getConfigItem('ytdl_webhook_url');
    logger.verbose(`Sending generic notification to ${webhook_url}`);
    fetch(webhook_url, {
        method: 'POST',
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify(data),
    });
}