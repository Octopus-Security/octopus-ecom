'use strict';
/**
 * redact.js — content-based redaction for every log line. A smaller sibling of
 * octopus-router's redact.js: known token shapes plus the EXACT value of every
 * sealed secret and credential env var, whatever shape they have.
 */
const PATTERNS = [
  ['GitHub token',     /\bgh[pousr]_[A-Za-z0-9]{30,}/g],
  ['GitHub PAT',       /github_pat_[A-Za-z0-9_]{50,}/g],
  ['Anthropic key',    /sk-ant-[A-Za-z0-9_-]{20,}/g],
  ['OpenRouter key',   /sk-or-v1-[A-Za-z0-9]{20,}/g],
  ['OpenAI key',       /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/g],
  ['Slack token',      /xox[baprs]-[A-Za-z0-9-]{10,}/g],
  ['AWS access key',   /AKIA[0-9A-Z]{16}/g],
  ['Google API key',   /AIza[A-Za-z0-9_-]{35}/g],
  ['Bearer token',     /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi],
  ['PEM private key',  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g],
  ['JWT',              /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g],
];

const MIN_EXACT = 8;
const marker = label => `[REDACTED ${label}]`;

/** getExact: () => string[] of secret values, read at call time (secrets change at runtime). */
function makeRedactor(getExact = () => []) {
  function redactText(text) {
    if (typeof text !== 'string' || !text) return text;
    let out = text;
    let exact = [];
    try { exact = getExact() || []; } catch { /* never let redaction break logging */ }
    for (const v of exact) {
      if (typeof v === 'string' && v.length >= MIN_EXACT && out.includes(v)) out = out.split(v).join(marker('credential'));
    }
    for (const [label, re] of PATTERNS) {
      re.lastIndex = 0;
      out = out.replace(re, marker(label));
    }
    return out;
  }
  return { redactText };
}

module.exports = { makeRedactor, PATTERNS, marker };
