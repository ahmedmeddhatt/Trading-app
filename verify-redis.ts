import Redis from 'ioredis';
import * as dotenv from 'dotenv';

dotenv.config();

const url = process.env.REDIS_URL ?? 'redis://localhost:6379';
const isTls = url.startsWith('rediss://');

const client = new Redis(url, {
  tls: isTls ? {} : undefined,
  maxRetriesPerRequest: 3,
  connectTimeout: 5000,
});

(async () => {
  try {
    const prices = await client.hgetall('market:prices');
    const count = prices ? Object.keys(prices).length : 0;
    console.log(JSON.stringify({ status: 'ok', url: url.replace(/:\/\/[^@]+@/, '://***@'), 'market:prices keys': count, sample: Object.keys(prices ?? {}).slice(0, 3) }));
  } catch (err) {
    console.error(JSON.stringify({ status: 'error', message: (err as Error).message }));
  } finally {
    await client.quit();
  }
})();
