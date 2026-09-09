import 'dotenv/config';
import bcrypt from 'bcrypt';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, Role } from '@prisma/client';

const connectionString =
  process.env.DATABASE_MIGRATION_URL ??
  process.env.DATABASE_URL;
const username =
  process.env.INITIAL_ADMIN_USERNAME;
const password =
  process.env.INITIAL_ADMIN_PASSWORD;
const name =
  process.env.INITIAL_ADMIN_NAME;
const email =
  process.env.INITIAL_ADMIN_EMAIL ||
  null;

if (!connectionString) {
  throw new Error(
    'DATABASE_MIGRATION_URL o DATABASE_URL no está definida',
  );
}

if (!username || !password || !name) {
  throw new Error(
    'Faltan variables para crear el administrador inicial',
  );
}

if (
  password.length < 12 ||
  Buffer.byteLength(
    password,
    'utf8',
  ) > 72
) {
  throw new Error(
    'INITIAL_ADMIN_PASSWORD debe tener al menos 12 caracteres y no superar 72 bytes',
  );
}

const adapter = new PrismaPg({
  connectionString,
});

const prisma = new PrismaClient({
  adapter,
});

async function main() {
  const existingUser =
    await prisma.user.findUnique({
      where: {
        username,
      },
    });

  if (existingUser) {
    console.log(
      `El usuario "${username}" ya existe.`,
    );
    return;
  }

  const passwordHash =
    await bcrypt.hash(
      password,
      12,
    );

  const user =
    await prisma.user.create({
      data: {
        username,
        passwordHash,
        name,
        email,
        role: Role.ADMIN,
        active: true,
      },
    });

  console.log(
    `Administrador "${user.username}" creado correctamente.`,
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
