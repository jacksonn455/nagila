// @ts-check
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests',
  timeout: 30_000,
  retries: 0,
  reporter: 'list',

  webServer: {
    command: 'node scripts/serve.js',
    port: 4173,
    reuseExistingServer: !process.env.CI,
    timeout: 10_000,
  },

  use: {
    baseURL: 'http://localhost:4173',
    /* Desativa animações para testes mais rápidos e determinísticos */
    reducedMotion: 'reduce',
  },
});
