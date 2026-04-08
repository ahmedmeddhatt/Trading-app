export function validateRedisEnv(): void {
  const redisUrl = process.env.REDIS_URL ?? process.env.UPSTASH_REDIS_URL;

  if (!redisUrl) {
    const msg = 'REDIS_URL is not set';
    if (process.env.NODE_ENV === 'production') throw new Error(msg);
    console.warn(`[env-validation] ${msg}`);
    return;
  }

  const host =
    redisUrl.split('@')[1]?.split(':')[0] ??
    redisUrl.split('//')[1]?.split(':')[0] ??
    'unknown';
  console.log('Redis env validation: PASS');
  console.log(`  REDIS_URL: ${host}`);
}
