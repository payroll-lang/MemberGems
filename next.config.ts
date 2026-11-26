import type { NextConfig } from 'next';

// Every page in this portal depends on the signed-in user, so pages render per
// request. Cache Components / Partial Prefetching are left off deliberately.
const nextConfig: NextConfig = {
  poweredByHeader: false,
  serverExternalPackages: ['@node-rs/argon2', 'firebase-admin'],
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'same-origin' },
          { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ];
  },
};

export default nextConfig;
