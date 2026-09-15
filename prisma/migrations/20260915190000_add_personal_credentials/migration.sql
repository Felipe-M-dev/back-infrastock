CREATE TABLE "PersonalCredential" (
    "id" SERIAL NOT NULL,
    "ownerId" INTEGER NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "username" VARCHAR(254) NOT NULL,
    "location" VARCHAR(500),
    "notes" VARCHAR(2000),
    "encryptedPassword" TEXT NOT NULL,
    "iv" TEXT NOT NULL,
    "authTag" TEXT NOT NULL,
    "keyVersion" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PersonalCredential_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "PersonalCredential_ownerId_name_idx" ON "PersonalCredential"("ownerId", "name");
ALTER TABLE "PersonalCredential" ADD CONSTRAINT "PersonalCredential_ownerId_fkey"
    FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
