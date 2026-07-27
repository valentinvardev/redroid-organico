-- The device's story has to match where it says it is: a session exiting in
-- Dallas with the clock in GMT-3 contradicts itself. Both hang off the proxy,
-- not the account, because the exit address is what decides the region.

ALTER TABLE "proxies"
  ADD COLUMN "timezone" TEXT,
  ADD COLUMN "locale" TEXT;
