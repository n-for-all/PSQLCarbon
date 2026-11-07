-- CreateTable
CREATE TABLE "ChatSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "title" TEXT NOT NULL,
    "database" TEXT NOT NULL,
    "messages" TEXT NOT NULL DEFAULT '[]',
    "connectionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    CONSTRAINT "ChatSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ChatMemory" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "content" TEXT NOT NULL,
    "database" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    CONSTRAINT "ChatMemory_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- AlterTable
ALTER TABLE "User" ADD COLUMN "aiWriteMode" TEXT NOT NULL DEFAULT 'ask';

-- CreateIndex
CREATE INDEX "ChatSession_userId_connectionId_idx" ON "ChatSession"("userId", "connectionId");

-- CreateIndex
CREATE INDEX "ChatMemory_userId_connectionId_database_idx" ON "ChatMemory"("userId", "connectionId", "database");

