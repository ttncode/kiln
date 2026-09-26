const DEFAULT_TIMEOUT_MS = 5000;

module.exports = {
  port: Number(process.env.PORT ?? 3000),
  http: {
    timeoutMs: process.env.HTTP_TIMEOUT_MS ? Number(process.env.HTTP_TIMEOUT_MS) : undefined,
  },
  DEFAULT_TIMEOUT_MS,
};
