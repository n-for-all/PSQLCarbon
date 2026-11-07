-- CreateTable
CREATE TABLE "QueryHistory" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sql" TEXT NOT NULL,
    "database" TEXT NOT NULL,
    "success" BOOLEAN NOT NULL,
    "error" TEXT,
    "rowCount" INTEGER,
    "durationMs" INTEGER,
    "connectionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    CONSTRAINT "QueryHistory_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SavedQuery" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "name" TEXT NOT NULL,
    "sql" TEXT NOT NULL,
    "database" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    CONSTRAINT "SavedQuery_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "QueryHistory_userId_connectionId_createdAt_idx" ON "QueryHistory"("userId", "connectionId", "createdAt");

-- CreateIndex
CREATE INDEX "SavedQuery_userId_connectionId_idx" ON "SavedQuery"("userId", "connectionId");

