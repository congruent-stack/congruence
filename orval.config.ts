import { defineConfig } from 'orval';

export default defineConfig({
  congruence: {
    input: './packages/api-client/openapi.json',
    output: {
      target: './packages/api-client/src/generated/client.ts',
      client: 'fetch',
      mode: 'single',
      override: {
        mutator: { path: './packages/api-client/src/fetch.ts', name: 'apiFetch' },
        fetch: { includeHttpResponseReturnType: false },
      },
    },
  },
});
