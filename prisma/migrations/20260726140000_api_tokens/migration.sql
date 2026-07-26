-- Bearer tokens for server-to-server access. Only the SHA-256 is stored, the
-- same way sessions are, so a dump of this table cannot be replayed.

CREATE TABLE "api_tokens" (
  "id"         TEXT NOT NULL,
  "userId"     TEXT NOT NULL,
  "name"       TEXT NOT NULL,
  "tokenHash"  TEXT NOT NULL,
  "lastUsedAt" TIMESTAMP(3),
  "expiresAt"  TIMESTAMP(3),
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "api_tokens_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "api_tokens_tokenHash_key" ON "api_tokens"("tokenHash");
CREATE INDEX "api_tokens_userId_idx" ON "api_tokens"("userId");

ALTER TABLE "api_tokens"
  ADD CONSTRAINT "api_tokens_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
