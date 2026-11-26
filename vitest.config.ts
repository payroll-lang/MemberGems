import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// The legacy harness reads dates with local getters, as Apps Script does in
// the script's time zone. Run everything in IST so both sides agree.
process.env.TZ = 'Asia/Kolkata';

export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    env: { TZ: 'Asia/Kolkata' },
  },
});
