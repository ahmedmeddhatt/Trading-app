import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const GOLD_CATEGORIES = [
  { id: 'GOLD_24K', nameAr: 'عيار 24', nameEn: '24 Karat Gold', unit: 'gram', purity: 0.9999, weightGrams: null },
  { id: 'GOLD_21K', nameAr: 'عيار 21', nameEn: '21 Karat Gold', unit: 'gram', purity: 0.8750, weightGrams: null },
  { id: 'GOLD_18K', nameAr: 'عيار 18', nameEn: '18 Karat Gold', unit: 'gram', purity: 0.7500, weightGrams: null },
  { id: 'GOLD_14K', nameAr: 'عيار 14', nameEn: '14 Karat Gold', unit: 'gram', purity: 0.5833, weightGrams: null },
  { id: 'GOLD_BAR',   nameAr: 'سبيكة ذهب', nameEn: 'Gold Bar',      unit: 'gram',  purity: 0.9999, weightGrams: null },
  { id: 'GOLD_POUND', nameAr: 'جنيه ذهب',  nameEn: 'Gold Pound',    unit: 'piece', purity: 0.8750, weightGrams: 8.0 },
  { id: 'GOLD_OUNCE', nameAr: 'أونصة ذهب', nameEn: 'Gold Ounce',    unit: 'ounce', purity: 0.9999, weightGrams: 31.1035 },
];

async function main() {
  for (const cat of GOLD_CATEGORIES) {
    await prisma.goldCategory.upsert({
      where: { id: cat.id },
      update: { nameAr: cat.nameAr, nameEn: cat.nameEn, unit: cat.unit, purity: cat.purity, weightGrams: cat.weightGrams },
      create: cat,
    });
    console.log(`Upserted: ${cat.id} (${cat.nameEn})`);
  }
  console.log('Gold categories seeded successfully.');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
