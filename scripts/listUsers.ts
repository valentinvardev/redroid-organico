import 'dotenv/config';
import { prisma } from '@/lib/db';

async function main() {
  const users = await prisma.user.findMany({ select: { id: true, email: true } });
  console.log(JSON.stringify(users, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
