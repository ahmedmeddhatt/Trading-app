export function validateRedisEnv(): void {
  const errors: string[] = [];

  const upstashUrl = process.env.UPSTASH_REDIS_URL;
  const bullUrl = process.env.BULL_REDIS_URL;

  if (!upstashUrl) {
    errors.push('UPSTASH_REDIS_URL is not set');
  } else if (!upstashUrl.startsWith('rediss://')) {
    errors.push(
      `UPSTASH_REDIS_URL must start with rediss:// (TLS required for Upstash). ` +
      `Got: ${upstashUrl.split('://')[0]}://`,
    );
  } else if (upstashUrl.includes('railway') || upstashUrl.includes('localhost')) {
    errors.push(
      'UPSTASH_REDIS_URL appears to point to Railway or localhost, not Upstash.',
    );
  }

  if (!bullUrl) {
    errors.push(
      'BULL_REDIS_URL is not set — BullMQ will fall back to UPSTASH_REDIS_URL ' +
      'and exhaust the monthly quota in days',
    );
  } else if (bullUrl.includes('upstash')) {
    errors.push(
      'BULL_REDIS_URL points to Upstash — BullMQ must use Railway Redis, not Upstash',
    );
  }

  if (upstashUrl && bullUrl && upstashUrl === bullUrl) {
    errors.push(
      'UPSTASH_REDIS_URL and BULL_REDIS_URL are identical — they must point to different instances',
    );
  }

  if (errors.length > 0) {
    console.error('=== REDIS CONFIGURATION ERRORS ===');
    errors.forEach((e, i) => console.error(`  ${i + 1}. ${e}`));
    console.error('==================================');
    if (process.env.NODE_ENV === 'production') {
      throw new Error('Redis misconfiguration detected. Fix env vars before deploying.');
    }
    console.warn('Running with Redis misconfiguration (dev mode — not throwing)');
  } else {
    const upstashHost = upstashUrl?.split('@')[1]?.split(':')[0] ?? 'unknown';
    const bullHost =
      bullUrl?.split('@')[1]?.split(':')[0] ??
      bullUrl?.split('//')[1]?.split(':')[0] ??
      'unknown';
    console.log('Redis env validation: PASS');
    console.log(`  UPSTASH: ${upstashHost}`);
    console.log(`  BULL:    ${bullHost}`);
  }
}
