import 'dotenv/config';
import { prisma } from '@/lib/db';

async function main() {
  const accounts = await prisma.account.findMany({
    select: {
      id: true,
      name: true,
      platform: true,
      status: true,
      userId: true,
      credentials: true,
    },
  });
  console.log(JSON.stringify(accounts, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
