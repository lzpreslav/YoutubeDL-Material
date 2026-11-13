# YoutubeDL-Material

[![GitHub issues badge](https://img.shields.io/github/issues/lzpreslav/YoutubeDL-Material)](https://github.com/lzpreslav/YoutubeDL-Material/issues)
[![License badge](https://img.shields.io/github/license/lzpreslav/YoutubeDL-Material)](https://github.com/lzpreslav/YoutubeDL-Material/blob/master/LICENSE.md)

YoutubeDL-Material is a Material Design frontend for [yt-dlp](https://github.com/yt-dlp/yt-dlp). It's coded using [Angular](https://angular.dev/) for the frontend, and [Node.js](https://nodejs.org/) on the backend.

Now with [Docker](#Docker) support!

<hr>

## Differences from upstream

This is a fork of [Tzahi12345/YoutubeDL-Material](https://github.com/Tzahi12345/YoutubeDL-Material) that targets container deployments. Backwards-incompatible changes:

* **`Host.url` is the full public URL.** Include the port unless it is the protocol default (`http://host:17442`, `https://ytdl.example.com`). `Host.port` now only sets the port the app listens on.
* **Discord and Telegram notifications removed**, along with their config keys, the `/api/telegramRequest` webhook, and their settings UI. Both pulled vulnerable dependencies that could not be patched here. ntfy, gotify, Slack and generic webhooks are unaffected.
* **Self-update removed.** The app can no longer update itself from the UI — pull a new image instead. yt-dlp binary updates are unaffected.
* **youtube-dlc support removed.** Unmaintained since 2021.
* **pm2 removed.** The container runtime supervises the process instead.
* **32-bit ARM images are no longer built.**
* **npm, npx and corepack are absent from the runtime image.** It only runs `node app.js`.
* **Logs go to stdout/stderr** with a `LEVEL:` prefix and no timestamp, so a log collector can classify and stamp them. `error.log` is gone; `combined.log` still contains errors and still backs the in-app log viewer.
* **Heroku and Electron targets removed.** Run the container image, or build from source.
* **The "Kill all downloads" button and `/api/killAllDownloads` are removed.** Pause or cancel downloads from the downloads page instead.
* **`/api/downloadVideosForSubscription` is removed.** Use `/api/checkSubscription`.

<hr>

## Getting Started

Check out the prerequisites, and go to the [installation](#Installing) section. Easy as pie!

Here's an image of what it'll look like once you're done:

<img src="https://i.imgur.com/C6vFGbL.png" width="800">

Dark mode:

<img src="https://i.imgur.com/vOtvH5w.png" width="800">

### Prerequisites

NOTE: If you would like to use Docker, you can skip down to the [Docker](#Docker) section for a setup guide.

Required dependencies:

* Node.js 24
* Python 3
* ffmpeg

Optional dependencies:

* AtomicParsley (for embedding thumbnails, package name `atomicparsley`)
* [Twitch Downloader CLI](https://github.com/lay295/TwitchDownloader) (for downloading Twitch VOD chats)

## Build it yourself

Clone the repository, then install the dependencies and build the frontend from the repository root:

```bash
npm install
npm run build
```

This puts the frontend in `backend/public`. Then install and start the backend, which serves the frontend as well:

```bash
cd backend
npm install
npm start
```

The configuration lives in `backend/appdata/default.json` and is created with default values on the first start. The app listens on the port set there, which defaults to `17442`.

If you want your instance to be available from outside your network, you can set up a [reverse proxy](https://github.com/Tzahi12345/YoutubeDL-Material/wiki/Reverse-Proxy-Setup).

## Docker

### Setup

Images are published to `ghcr.io/lzpreslav/youtubedl-material`.

1. Download [`compose.yml`](compose.yml) from this repository.
2. Run `docker compose pull` to download the image.
3. Run `docker compose up` to start it up. If successful, it should say "YoutubeDL-Material started on PORT 17442" or something similar. This tells you the *container-internal* port of the application. Please check your `compose.yml` file for the *external* port, which defaults to **8998**.
4. Make sure you can connect to the specified URL + *external* port, and if so, you are done!

### Custom UID/GID

To run the app as a specific user, start the container as that user. In your `compose.yml`:

```yml
user: "YOUR_UID:YOUR_GID"
```

The mounted folders must be writable by that user.

### Logging

The container logs to stdout/stderr in a format suited to container log collectors (Docker/podman `logs`, journald, syslog, Loki). Informational output goes to **stdout** and errors go to **stderr**; each line is prefixed with its log level (e.g. `INFO:`, `ERROR:`) so collectors can detect the level, and no timestamps are printed since the collector stamps each entry itself. The in-app log viewer is unaffected — full timestamped logs are always kept in `appdata/logs/`.

## MongoDB

For much better scaling with large datasets please run your YoutubeDL-Material instance with MongoDB backend rather than the json file-based default. It will fix a lot of performance problems (especially with datasets in the tens of thousands videos/audios)!

[Tutorial](https://github.com/Tzahi12345/YoutubeDL-Material/wiki/Setting-a-MongoDB-backend-to-use-as-database-provider-for-YTDL-M).

## API

[API Docs](https://youtubedl-material.stoplight.io/docs/youtubedl-material/Public%20API%20v1.yaml)

To get started, go to the settings menu and enable the public API from the *Extra* tab. You can generate an API key if one is missing.

Once you have enabled the API and have the key, you can start sending requests by adding the query param `apiKey=API_KEY`. Replace `API_KEY` with your actual API key, and you should be good to go! Nearly all of the backend should be at your disposal. View available endpoints in the link above.

## iOS Shortcut 

If you are using iOS, try YoutubeDL-Material more conveniently with a Shortcut. With this Shorcut, you can easily start downloading YouTube video with just two taps! (Or maybe three?)

You can download Shortcut [here.](https://routinehub.co/shortcut/10283/)

## Contributing

If you're interested in contributing, first: awesome! Second, please refer to the guidelines/setup information located in the [Contributing](https://github.com/Tzahi12345/YoutubeDL-Material/wiki/Contributing) wiki page, it's a helpful way to get you on your feet and coding away.

Pull requests are always appreciated! If you're a bit rusty with coding, that's no problem: we can always help you learn. And if that's too scary, that's OK too! You can create issues for features you'd like to see or bugs you encounter, it all helps this project grow.

If you're interested in translating the app into a new language, check out the [Translate](https://github.com/Tzahi12345/YoutubeDL-Material/wiki/Translate) wiki page.

## Authors

* **Isaac Grynsztein** (me!) - *Initial work*

Official translators:

* Spanish - tzahi12345
* German - UnlimitedCookies
* Chinese - TyRoyal

See also the list of [contributors](https://github.com/Tzahi12345/YoutubeDL-Material/graphs/contributors) who participated in this project.

## License

This project is licensed under the MIT License - see the [LICENSE.md](LICENSE.md) file for details

## Legal Disclaimer

This project is in no way affiliated with Google LLC, Alphabet Inc. or YouTube (or their subsidiaries) nor endorsed by them.

## Acknowledgments

* youtube-dl
* [AllTube](https://github.com/Rudloff/alltube) (for the inspiration)
