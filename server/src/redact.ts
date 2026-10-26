// Secret redaction and prompt-injection heuristics applied to untrusted content
// before it is stored as memory or broadcast to other participants.

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED:private-key]'],
  [/\bnio_[A-Za-z0-9]{8,}_[A-Za-z0-9_-]{16,}\b/g, '[REDACTED:nio-key]'],
  [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}\b/g, '[REDACTED:api-key]'],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b/g, '[REDACTED:github-token]'],
  [/\bgithub_pat_[A-Za-z0-9_]{40,}\b/g, '[REDACTED:github-token]'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, '[REDACTED:slack-token]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED:aws-key]'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, '[REDACTED:google-key]'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED:jwt]'],
  [/\b(Bearer)\s+[A-Za-z0-9._~+/-]{20,}=*/gi, '$1 [REDACTED]'],
  [/\b((?:password|passwd|secret|api[_-]?key|access[_-]?token)\s*[:=]\s*)(["']?)[^\s"']{6,}\2/gi, '$1[REDACTED]'],
  [/\b(postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/([^:\s/]+):[^@\s/]+@/gi, '$1://$2:[REDACTED]@'],
];

export interface RedactionResult {
  text: string;
  redacted: boolean;
}

export function redactSecrets(input: string): RedactionResult {
  let text = input;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    text = text.replace(pattern, replacement);
  }
  return { text, redacted: text !== input };
}

const INJECTION_PATTERNS: RegExp[] = [
  /\b(ignore|disregard|forget)\s+(all\s+|any\s+)?(the\s+)?(previous|prior|above|earlier|system)\s+(instructions|prompts?|rules|messages)/i,
  /\byou\s+are\s+now\s+(a|an|the|in)\b/i,
  /\b(new|updated|override)\s+system\s+(prompt|instructions)\b/i,
  /<\|?(im_start|im_end|system)\|?>/i,
  /\b(always|must)\s+(run|execute)\s+(the\s+following\s+)?(command|shell|script)/i,
  /\bgrant\s+(yourself|the\s+agent)\s+(admin|root|full)\s+(access|privileges|permissions)/i,
];

/** Returns true when content looks like it tries to steer an agent. Such content is never auto-committed. */
export function looksLikeInjection(input: string): boolean {
  return INJECTION_PATTERNS.some((p) => p.test(input));
}
