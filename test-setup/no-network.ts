// CI rule: no network in tests. Any code that reaches the real global fetch fails at once.
globalThis.fetch = () => Promise.reject(new Error('network is disabled in tests'));
