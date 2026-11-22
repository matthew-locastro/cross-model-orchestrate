// Antigravity's headless result contract. The short form is one JSON envelope;
// the long-prompt form is NDJSON whose final result event contains that same
// envelope.

import { ANTIGRAVITY_MODEL_RE } from './config.mjs';

export const AGY_ARGV_PROMPT_LIMIT = 100_000;

export function isAntigravityModel(model) {
  return typeof model === 'string' && ANTIGRAVITY_MODEL_RE.test(model);
}

export function isLongAgyPrompt(prompt) {
  return Buffer.byteLength(prompt ?? '', 'utf8') > AGY_ARGV_PROMPT_LIMIT;
}

function resultEnvelope(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed?.event === 'result') return parsed.result ?? null;
    return parsed;
  } catch { /* stream-json has more than one JSON value */ }

  let result = null;
  for (const line of trimmed.split('\n')) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event?.event === 'result') result = event.result ?? null;
    } catch {
      return null;
    }
  }
  return result;
}

export function parseAntigravityStdout(stdout) {
  const envelope = resultEnvelope(stdout);
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    return { status: null, text: '', usage: null, structuredOutput: null, error: '', envelope: null };
  }
  const error = typeof envelope.error === 'string'
    ? envelope.error
    : envelope.error == null ? '' : JSON.stringify(envelope.error);
  return {
    status: typeof envelope.status === 'string' ? envelope.status : null,
    text: envelope.status === 'SUCCESS' && typeof envelope.response === 'string'
      ? envelope.response.trim()
      : '',
    usage: envelope.usage && typeof envelope.usage === 'object' ? envelope.usage : null,
    structuredOutput: envelope.structured_output ?? null,
    error,
    envelope,
  };
}

/** Classify only Antigravity transport/envelope evidence, never response text. */
export function classifyAntigravityFailure(result, parsed) {
  const diagnostic = `${result.stderr ?? ''}\n${parsed.error ?? ''}\n${parsed.envelope?.finished_reason ?? ''}`;
  if (result.timedOut || result.code === 3 || /\bprint_timeout\b/i.test(diagnostic)) return 'timeout';
  if (/\b(?:RESOURCE_EXHAUSTED|quota|rate[ _-]?limit(?:ed)?|429)\b/i.test(diagnostic)) return 'rate-limit';
  if (/\b(?:auth(?:entication)?|oauth|log[ -]?in|logged out|signed out|not signed in)\b/i.test(diagnostic)) {
    return 'signed-out';
  }
  if (result.signal) return 'transient';
  if (result.code !== 0) return 'fatal';
  return parsed.status === 'SUCCESS' ? 'none' : 'fatal';
}

export function antigravitySoftDenyWarning(stderr = '') {
  const line = stderr.split('\n').find((candidate) => (
    /soft[- ]?den(?:y|ied)/i.test(candidate)
    || (/\b(?:approval|permission)\b/i.test(candidate) && /\b(?:denied|unavailable|headless)\b/i.test(candidate))
  ));
  return line?.trim() || null;
}

export function antigravityInput(prompt) {
  return `${JSON.stringify({ event: 'user', message: { content: prompt } })}\n`;
}

export function isJsonObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
