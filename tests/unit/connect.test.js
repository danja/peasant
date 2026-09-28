// connect() turning configuration into clients, against a local fake server
// reached through the ollama profile -- the one provider whose base URL may be
// plaintext loopback, so nothing here touches the network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from '../../src/provider/connect.js';
import { FakeProvider } from './lib/FakeProvider.js';

async function fake(t) {
  const f = await new FakeProvider({ models: ['qwen2.5-coder:7b'] }).start();
  t.after(() => f.stop());
  return f;
}

test('a stated context window reaches the client when the model comes from the catalogue', async (t) => {
  const f = await fake(t);
  const { clients } = await connect({
    PEASANT_PROVIDERS: 'ollama', OLLAMA_BASE_URL: f.baseUrl, OLLAMA_CONTEXT_LENGTH: '16384',
  });
  assert.equal(clients[0].model, 'qwen2.5-coder:7b');
  assert.equal(clients[0].contextWindow, 16384,
    'the catalogue lookup must not overwrite a window the user stated');
});

test('a stated context window reaches the client when the model is named', async (t) => {
  const f = await fake(t);
  const { clients } = await connect({
    PEASANT_PROVIDERS: 'ollama', OLLAMA_BASE_URL: f.baseUrl,
    OLLAMA_MODEL: 'qwen2.5-coder:7b', OLLAMA_CONTEXT_LENGTH: '8192',
  });
  assert.equal(clients[0].contextWindow, 8192);
});

test('with nothing stated and nothing in the catalogue, the window is unknown', async (t) => {
  const f = await fake(t);
  const { clients } = await connect({ PEASANT_PROVIDERS: 'ollama', OLLAMA_BASE_URL: f.baseUrl });
  assert.equal(clients[0].contextWindow, null);
});
