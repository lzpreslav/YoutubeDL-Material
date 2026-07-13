const winston = require('winston');

const debugMode = process.env.YTDL_MODE === 'debug';

// Timestamped format for the log files - the in-app log viewer reads combined.log.
const fileFormat = winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ level, message, timestamp }) => `${timestamp} ${level.toUpperCase()}: ${message}`)
);

// Console: no timestamp (the container log collector stamps each entry itself). The level
// prefix is kept so collectors can detect the level from the message.
const consoleFormat = winston.format.printf(({ level, message }) => `${level.toUpperCase()}: ${message}`);

const logger = winston.createLogger({
    level: 'info',
    format: fileFormat,
    defaultMeta: {},
    transports: [
      // Write all logs (down to the active level) to `combined.log` - the in-app log viewer reads it.
      new winston.transports.File({ filename: 'appdata/logs/combined.log' }),
      new winston.transports.Console({
          level: debugMode ? 'debug' : 'info',
          format: consoleFormat,
          stderrLevels: ['error'],
          name: 'console'
      })
    ]
});

module.exports = logger;
