-- Per-account egress. A proxy belongs to a user and may be shared by several of
-- their accounts; each account points at zero or one.

-- CreateEnum
CREATE TYPE "ProxyType" AS ENUM ('HTTP', 'SOCKS5');

-- CreateTable
CREATE TABLE "proxies" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "type" "ProxyType" NOT NULL DEFAULT 'SOCKS5',
    "host" TEXT NOT NULL,
    "port" INTEGER NOT NULL,
    "username" TEXT,
    -- Same envelope as accounts.credentials: iv(12) || tag(16) || ciphertext.
    "password" BYTEA,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "proxies_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "proxies_userId_label_key" ON "proxies"("userId", "label");

-- CreateIndex
CREATE INDEX "proxies_userId_idx" ON "proxies"("userId");

-- AddForeignKey
ALTER TABLE "proxies" ADD CONSTRAINT "proxies_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "accounts" ADD COLUMN "proxyId" TEXT;

-- CreateIndex
CREATE INDEX "accounts_proxyId_idx" ON "accounts"("proxyId");

-- AddForeignKey
--
-- SET NULL, not RESTRICT: a RESTRICT here would also fire while Postgres
-- cascades a user deletion through both tables, whose order is not ours to
-- choose. Refusing to delete a proxy that accounts still use is enforced in
-- lib/proxy/service.ts, which is the only code path that deletes one.
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_proxyId_fkey" FOREIGN KEY ("proxyId") REFERENCES "proxies"("id") ON DELETE SET NULL ON UPDATE CASCADE;
