import { defineConfig } from 'vitest/config';
import { config } from 'dotenv';

// Load .env file
config();

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 30000, // 30 seconds for ingestion tests
    fileParallelism: false,
    env: {
      TEST_DATABASE_URL: process.env.TEST_DATABASE_URL || 'postgresql://localhost:5432/f1muse_test'
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      exclude: [
        'node_modules/',
        'dist/',
        '**/*.test.ts',
        'src/test/setup.ts'
      ]
    }
  }
});
