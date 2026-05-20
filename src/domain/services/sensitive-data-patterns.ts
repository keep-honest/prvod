/**
 * Registry of regex patterns for detecting sensitive data in LLM-generated narration output.
 *
 * Pattern sources:
 *   - detect-secrets (Yelp)
 *   - trufflehog (Truffle Security)
 *   - gitleaks
 */

export interface SensitiveDataPattern {
  id: string;
  category: 'credential' | 'pii';
  pattern: RegExp;
  description: string;
  validate?: (match: string) => boolean;
}

/**
 * Luhn algorithm for credit card number validation.
 * Strips non-digit characters before checking.
 */
export function luhnCheck(cardNumber: string): boolean {
  const digits = cardNumber.replace(/\D/g, '');
  if (digits.length === 0) return false;

  let sum = 0;
  let alternate = false;

  for (let i = digits.length - 1; i >= 0; i--) {
    let n = parseInt(digits[i], 10);
    if (alternate) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alternate = !alternate;
  }

  return sum % 10 === 0;
}

export const SENSITIVE_DATA_PATTERNS: readonly SensitiveDataPattern[] = [
  // ── Credentials ──────────────────────────────────────────────

  {
    id: 'aws_access_key',
    category: 'credential',
    pattern: /AKIA[0-9A-Z]{16}/,
    description: 'AWS access key ID',
  },
  {
    id: 'github_token_classic',
    category: 'credential',
    pattern: /ghp_[0-9a-zA-Z]{36}/,
    description: 'GitHub classic personal access token',
  },
  {
    id: 'github_token_fine_grained',
    category: 'credential',
    pattern: /github_pat_[0-9a-zA-Z_]{82}/,
    description: 'GitHub fine-grained personal access token',
  },
  {
    id: 'openai_api_key_legacy',
    category: 'credential',
    pattern: /sk-[a-zA-Z0-9]{20,}T3BlbkFJ[a-zA-Z0-9]{20,}/,
    description: 'OpenAI API key (legacy format)',
  },
  {
    id: 'openai_api_key_project',
    category: 'credential',
    pattern: /sk-proj-[a-zA-Z0-9\-_]{80,}/,
    description: 'OpenAI API key (project-scoped format)',
  },
  {
    id: 'anthropic_api_key',
    category: 'credential',
    pattern: /sk-ant-[a-zA-Z0-9\-_]{80,}/,
    description: 'Anthropic API key',
  },
  {
    id: 'slack_token',
    category: 'credential',
    pattern: /xox[bpors]-[0-9a-zA-Z-]{10,}/,
    description: 'Slack bot, user, or workspace token',
  },
  {
    id: 'bearer_token',
    category: 'credential',
    pattern: /Bearer\s+[a-zA-Z0-9\-._~+/]{20,}/,
    description: 'HTTP Bearer authorization token',
  },
  {
    id: 'connection_string_postgres',
    category: 'credential',
    pattern: /postgres(ql)?:\/\/[^\s]+:[^\s]+@[^\s]+/,
    description: 'PostgreSQL connection string with credentials',
  },
  {
    id: 'connection_string_mongodb',
    category: 'credential',
    pattern: /mongodb(\+srv)?:\/\/[^\s]+:[^\s]+@[^\s]+/,
    description: 'MongoDB connection string with credentials',
  },
  {
    id: 'connection_string_redis',
    category: 'credential',
    pattern: /redis:\/\/[^\s]*:[^\s]+@[^\s]+/,
    description: 'Redis connection string with credentials',
  },
  {
    id: 'generic_uri_with_credentials',
    category: 'credential',
    pattern: /[a-z]+:\/\/[^:\s]+:[^@\s]+@[^\s]+/,
    description: 'URI containing embedded credentials',
  },
  {
    id: 'env_var_assignment',
    category: 'credential',
    pattern:
      /\b(DATABASE_URL|AWS_SECRET_ACCESS_KEY|API_KEY|SECRET_KEY|PRIVATE_KEY|ACCESS_TOKEN|AUTH_TOKEN|PASSWORD)\s*=\s*\S+/i,
    description: 'Environment variable assignment with sensitive key name',
  },
  {
    id: 'private_key_block',
    category: 'credential',
    pattern: /-----BEGIN\s+(RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/,
    description: 'PEM-encoded private key header',
  },

  // ── PII ──────────────────────────────────────────────────────

  {
    id: 'credit_card',
    category: 'pii',
    pattern:
      /\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13}|6(?:011|5[0-9]{2})[0-9]{12})\b/,
    description: 'Credit card number (Visa, Mastercard, Amex, Discover)',
    validate: (match: string) => luhnCheck(match),
  },
  {
    id: 'ssn',
    category: 'pii',
    pattern: /\b\d{3}-\d{2}-\d{4}\b/,
    description: 'US Social Security Number',
  },
  {
    id: 'email_address',
    category: 'pii',
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/,
    description: 'Email address',
  },
  {
    id: 'phone_us',
    category: 'pii',
    pattern:
      /\b(?:\+?1[-.\s]?)?\(?[0-9]{3}\)?[-.\s]?[0-9]{3}[-.\s]?[0-9]{4}\b/,
    description: 'US phone number',
  },
] as const;

/** Pre-compiled global regex variants — avoids recompiling on every scan call. */
const SENSITIVE_DATA_PATTERNS_GLOBAL: ReadonlyArray<{ entry: SensitiveDataPattern; re: RegExp }> =
  SENSITIVE_DATA_PATTERNS.map((entry) => ({
    entry,
    re: new RegExp(entry.pattern.source, entry.pattern.flags.includes("g") ? entry.pattern.flags : entry.pattern.flags + "g"),
  }));

export interface SensitiveDataMatch {
  pattern: SensitiveDataPattern;
  match: RegExpExecArray;
  validated: boolean;
}

/**
 * Scans content against all registered patterns and returns matches with positions.
 * Runs optional post-match validators (e.g. Luhn check for credit cards).
 */
export function matchSensitiveData(content: string): SensitiveDataMatch[] {
  const results: SensitiveDataMatch[] = [];

  for (const { entry, re } of SENSITIVE_DATA_PATTERNS_GLOBAL) {
    re.lastIndex = 0;
    let result: RegExpExecArray | null;

    while ((result = re.exec(content)) !== null) {
      const validated = entry.validate
        ? entry.validate(result[0])
        : true;

      results.push({
        pattern: entry,
        match: result,
        validated,
      });
    }
  }

  return results;
}
