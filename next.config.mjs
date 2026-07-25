/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    /**
     * These are native/server-only and must not go through the webpack bundle.
     * Bundling bullmq also drags in its optional @valkey/valkey-glide client,
     * which is not installed and produces a spurious "Module not found".
     */
    serverComponentsExternalPackages: [
      'bullmq',
      'ioredis',
      '@prisma/client',
      '@prisma/adapter-pg',
      'pg',
    ],
  },
};

export default nextConfig;
