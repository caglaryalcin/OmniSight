const AGENT_COMMAND_WAIT_DEFAULT_SECONDS = 10;
const AGENT_COMMAND_WAIT_MIN_SECONDS = 1;
const AGENT_COMMAND_WAIT_MAX_SECONDS = 55;

function agentCommandWaitMs(value) {
  const seconds = Number(value) || AGENT_COMMAND_WAIT_DEFAULT_SECONDS;
  return Math.min(Math.max(seconds, AGENT_COMMAND_WAIT_MIN_SECONDS), AGENT_COMMAND_WAIT_MAX_SECONDS) * 1000;
}

function requestSlowLimitMs(route, { status = 200, slowApiMs, slowRequestMs, expectedWaitMs = 0 } = {}) {
  const baseLimit = String(route || '').startsWith('/api/') ? Number(slowApiMs) : Number(slowRequestMs);
  const successfulLongPoll = route === '/api/agent/commands' && Number(status) >= 200 && Number(status) < 300;
  if (!successfulLongPoll) return baseLimit;
  const waitMs = Number(expectedWaitMs);
  if (!Number.isFinite(waitMs) || waitMs <= 0) return baseLimit;
  return Math.max(baseLimit, waitMs + baseLimit);
}

function requestDiagnosticKind(status, durationMs, slowLimitMs) {
  if (Number(status) >= 500) return 'error';
  return Number(durationMs) >= Number(slowLimitMs) ? 'slow' : '';
}

module.exports = { agentCommandWaitMs, requestSlowLimitMs, requestDiagnosticKind };
