// Sample raw error shapes that each provider can throw.
// Adapters classify these into TrackerErrorCode before handing to BaseTracker.normalizeError.

export const githubExecaErrorLike = {
  shortMessage: 'Command failed: gh issue list',
  stderr: 'gh: Bad credentials',
  stdout: '',
  exitCode: 1,
  failed: true,
};

export const githubRateLimitErrorLike = {
  shortMessage: 'Command failed: gh issue list',
  stderr: 'API rate limit exceeded for installation 12345',
  stdout: '',
  exitCode: 1,
};

export const linearMcpUnauthorized = {
  code: -32001,
  message: 'unauthorized',
};

export const linearMcpNotFound = {
  code: -32602,
  message: 'not found',
};

export const notionEtagMismatch = {
  httpStatus: 412,
  message: 'precondition failed: etag mismatch',
};

export const notionRateLimit = {
  httpStatus: 429,
  message: 'rate limit',
  retryAfterMs: 5000,
};
