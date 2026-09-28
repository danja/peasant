import { defineProfile } from './generic.js';

// UNVERIFIED: no local server has been probed from here.
//
// A local llama.cpp server (`llama-server`), which speaks the OpenAI shape.
//
// It usually serves exactly one model and reports it under whatever name it was
// started with, so the catch-all preference is the only sensible one.
export default defineProfile({
  name: 'llamacpp',
  baseUrl: 'http://127.0.0.1:8080/v1',
  keyVar: 'LLAMACPP_API_KEY',
  baseUrlVar: 'LLAMACPP_BASE_URL',
  modelVar: 'LLAMACPP_MODEL',

  // The window is whatever `llama-server -c` was given, which its catalogue
  // does not report. LLAMA_ARG_CTX_SIZE is the variable llama-server reads in
  // place of -c, so the same line configures both.
  contextWindowVar: 'LLAMA_ARG_CTX_SIZE',
  requiresKey: false,
  autoEnable: false,
  verified: false,
  prefer: [/./],
});
