CREATE TABLE "PrinterSyncJob" (
  "trayKey" TEXT NOT NULL PRIMARY KEY,
  "id" TEXT NOT NULL,
  "spoolId" INTEGER NOT NULL,
  "operation" TEXT NOT NULL,
  "state" TEXT NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" DATETIME NOT NULL,
  "sawEmpty" BOOLEAN NOT NULL DEFAULT false,
  "presentSince" DATETIME,
  "presentTag" TEXT,
  "baseline" TEXT NOT NULL DEFAULT '{}',
  "result" TEXT NOT NULL DEFAULT '{}',
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "PrinterSyncJob_id_key" ON "PrinterSyncJob"("id");
