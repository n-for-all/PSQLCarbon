-- AlterTable
ALTER TABLE "User" ADD COLUMN "openAiApiKey" TEXT;
ALTER TABLE "User" ADD COLUMN "openAiBaseUrl" TEXT;
ALTER TABLE "User" ADD COLUMN "openAiModel" TEXT;

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_DbConnection" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "allowDiskUse" BOOLEAN NOT NULL DEFAULT true,
    "connectionString" TEXT NOT NULL,
    "tls" BOOLEAN NOT NULL DEFAULT false,
    "tlsAllowInvalidCertificates" BOOLEAN NOT NULL DEFAULT false,
    "tlsCAFile" TEXT NOT NULL,
    "tlsCertificateKeyFile" TEXT NOT NULL,
    "tlsCertificateKeyFilePassword" TEXT NOT NULL,
    "maxPoolSize" INTEGER NOT NULL DEFAULT 4,
    "whitelist" TEXT NOT NULL,
    "blacklist" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    CONSTRAINT "DbConnection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_DbConnection" ("allowDiskUse", "blacklist", "connectionString", "id", "maxPoolSize", "name", "tls", "tlsAllowInvalidCertificates", "tlsCAFile", "tlsCertificateKeyFile", "tlsCertificateKeyFilePassword", "userId", "whitelist") SELECT "allowDiskUse", "blacklist", "connectionString", "id", "maxPoolSize", "name", "tls", "tlsAllowInvalidCertificates", "tlsCAFile", "tlsCertificateKeyFile", "tlsCertificateKeyFilePassword", "userId", "whitelist" FROM "DbConnection";
DROP TABLE "DbConnection";
ALTER TABLE "new_DbConnection" RENAME TO "DbConnection";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

