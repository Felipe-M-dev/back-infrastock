ALTER TABLE "OperatingSystem"
ADD COLUMN "eolProductKey" TEXT;

ALTER TABLE "Software"
ADD COLUMN "eolProductKey" TEXT;

CREATE INDEX "OperatingSystem_eolProductKey_idx"
ON "OperatingSystem"("eolProductKey");

CREATE INDEX "Software_eolProductKey_idx"
ON "Software"("eolProductKey");
