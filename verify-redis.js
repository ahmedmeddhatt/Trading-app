"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const ioredis_1 = __importDefault(require("ioredis"));
const dotenv = __importStar(require("dotenv"));
dotenv.config();
const url = process.env.REDIS_URL ?? 'redis://localhost:6379';
const isTls = url.startsWith('rediss://');
const client = new ioredis_1.default(url, {
    tls: isTls ? {} : undefined,
    maxRetriesPerRequest: 3,
    connectTimeout: 5000,
});
(async () => {
    try {
        const prices = await client.hgetall('market:prices');
        const count = prices ? Object.keys(prices).length : 0;
        console.log(JSON.stringify({ status: 'ok', url: url.replace(/:\/\/[^@]+@/, '://***@'), 'market:prices keys': count, sample: Object.keys(prices ?? {}).slice(0, 3) }));
    }
    catch (err) {
        console.error(JSON.stringify({ status: 'error', message: err.message }));
    }
    finally {
        await client.quit();
    }
})();
//# sourceMappingURL=verify-redis.js.map