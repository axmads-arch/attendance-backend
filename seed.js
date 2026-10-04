const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const prisma = new PrismaClient();

async function main() {
  const company = await prisma.company.create({
    data: { name: 'Mening ishxonam', latitude: 41.3111, longitude: 69.2797, radiusM: 30 },
  });
  console.log('Kompaniya yaratildi:', company.id);

  const shifts = await prisma.shift.createMany({
    data: [
      { name: '1-smena', startTime: '08:00', endTime: '16:00', crossesMidnight: false, companyId: company.id },
      { name: '2-smena', startTime: '16:00', endTime: '24:00', crossesMidnight: false, companyId: company.id },
      { name: '3-smena (tungi)', startTime: '00:00', endTime: '08:00', crossesMidnight: false, companyId: company.id },
      { name: 'Kechki tungi', startTime: '20:00', endTime: '08:00', crossesMidnight: true, companyId: company.id },
    ],
  });
  console.log('Smenalar yaratildi:', shifts.count);

  const passwordHash = await bcrypt.hash('parol123', 10);
  const manager = await prisma.manager.create({
    data: { name: 'Bosh menejer', phone: '+998900000000', passwordHash, role: 'owner', companyId: company.id },
  });
  console.log('Menejer yaratildi:', manager.phone, '(parol: parol123)');
  console.log('\n✅ Company ID =', company.id);
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
