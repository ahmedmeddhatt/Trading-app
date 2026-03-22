"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const client_1 = require("@prisma/client");
const decimal_js_1 = __importDefault(require("decimal.js"));
const prisma = new client_1.PrismaClient();
async function main() {
    const transactions = await prisma.transaction.findMany({
        orderBy: { createdAt: 'asc' },
    });
    if (!transactions.length) {
        console.log('No transactions found.');
        return;
    }
    console.log(`Found ${transactions.length} transactions. Clearing positions & realized gains...`);
    await prisma.realizedGain.deleteMany({});
    await prisma.position.deleteMany({});
    console.log('Cleared.');
    const state = {};
    for (const t of transactions) {
        const key = `${t.userId}:${t.symbol}`;
        const qty = new decimal_js_1.default(t.quantity.toString());
        const px = new decimal_js_1.default(t.price.toString());
        const fees = new decimal_js_1.default(t.fees?.toString() ?? '0');
        if (t.type === client_1.TransactionType.BUY) {
            const buyCost = qty.mul(px).add(fees);
            if (!state[key]) {
                state[key] = { qty, avgPrice: buyCost.div(qty), totalInvested: buyCost };
            }
            else {
                const s = state[key];
                const newQty = s.qty.add(qty);
                const newInv = s.totalInvested.add(buyCost);
                state[key] = { qty: newQty, avgPrice: newInv.div(newQty), totalInvested: newInv };
            }
        }
        else {
            if (!state[key]) {
                console.warn(`WARN: SELL without position for ${t.symbol} user ${t.userId} — skipping`);
                continue;
            }
            const s = state[key];
            const profit = px.sub(s.avgPrice).mul(qty).sub(fees);
            await prisma.realizedGain.create({
                data: {
                    userId: t.userId,
                    symbol: t.symbol,
                    quantity: qty.toFixed(8),
                    sellPrice: px.toFixed(8),
                    avgPrice: s.avgPrice.toFixed(8),
                    profit: profit.toFixed(8),
                    fees: fees.toFixed(8),
                },
            });
            const newQty = s.qty.sub(qty);
            if (newQty.isZero()) {
                state[key] = { qty: new decimal_js_1.default(0), avgPrice: s.avgPrice, totalInvested: new decimal_js_1.default(0) };
            }
            else {
                state[key] = { qty: newQty, avgPrice: s.avgPrice, totalInvested: newQty.mul(s.avgPrice) };
            }
        }
    }
    let created = 0;
    for (const [key, s] of Object.entries(state)) {
        if (s.qty.isZero())
            continue;
        const [userId, ...symbolParts] = key.split(':');
        const symbol = symbolParts.join(':');
        await prisma.position.upsert({
            where: { userId_symbol: { userId, symbol } },
            update: { totalQuantity: s.qty.toFixed(8), averagePrice: s.avgPrice.toFixed(8), totalInvested: s.totalInvested.toFixed(8) },
            create: { userId, symbol, totalQuantity: s.qty.toFixed(8), averagePrice: s.avgPrice.toFixed(8), totalInvested: s.totalInvested.toFixed(8) },
        });
        console.log(`  Position: ${symbol} qty=${s.qty.toFixed(2)} avg=${s.avgPrice.toFixed(2)}`);
        created++;
    }
    console.log(`\nDone. ${created} positions rebuilt.`);
}
main().catch(console.error).finally(() => prisma.$disconnect());
//# sourceMappingURL=rebuild-positions.js.map