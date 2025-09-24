type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LoggerOptions {
  level: LogLevel;
  format: 'json' | 'pretty';
}

const levelWeights: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

export class Logger {
  private readonly level: LogLevel;
  private readonly format: 'json' | 'pretty';

  constructor(options: LoggerOptions) {
    this.level = options.level;
    this.format = options.format;
  }

  private shouldLog(level: LogLevel): boolean {
    return levelWeights[level] >= levelWeights[this.level];
  }

  private formatMessage(level: LogLevel, message: string, metadata?: Record<string, unknown>) {
    if (this.format === 'json') {
      const payload = {
        level,
        message,
        metadata: metadata ?? null,
        timestamp: new Date().toISOString()
      };
      return JSON.stringify(payload);
    }

    const metadataText = metadata ? ` ${JSON.stringify(metadata)}` : '';
    return `[${new Date().toISOString()}] [${level.toUpperCase()}] ${message}${metadataText}`;
  }

  private write(level: LogLevel, message: string, metadata?: Record<string, unknown>) {
    if (!this.shouldLog(level)) return;
    const formatted = this.formatMessage(level, message, metadata);
    // eslint-disable-next-line no-console
    console.log(formatted);
  }

  debug(message: string, metadata?: Record<string, unknown>) {
    this.write('debug', message, metadata);
  }

  info(message: string, metadata?: Record<string, unknown>) {
    this.write('info', message, metadata);
  }

  warn(message: string, metadata?: Record<string, unknown>) {
    this.write('warn', message, metadata);
  }

  error(message: string, metadata?: Record<string, unknown>) {
    this.write('error', message, metadata);
  }
}
