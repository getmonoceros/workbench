#!/usr/bin/env node
// Tiny multi-port HTTP server for testing `monoceros add-port` /
// Traefik routing. Drop this file into a Dev-Container and run it —
// each requested port replies with JSON so you can verify which port
// answered.
//
// Usage (defaults: 3000/api, 5173/frontend, 6006/storybook):
//   node serve-ports.mjs
//
// Custom ports:
//   node serve-ports.mjs 8080 9000
//
// Custom labels:
//   node serve-ports.mjs 3000:api 5173:frontend 6006:storybook 9229:debug

import { createServer } from 'node:http';

const DEFAULTS = [
  { port: 3000, label: 'api' },
  { port: 5173, label: 'frontend' },
  { port: 6006, label: 'storybook' },
];

function parseArgs(argv) {
  if (argv.length === 0) return DEFAULTS;
  return argv.map((raw) => {
    const [portStr, label] = raw.split(':');
    const port = Number(portStr);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`invalid port: ${raw}`);
    }
    return { port, label: label ?? 'service' };
  });
}

let listeners;
try {
  listeners = parseArgs(process.argv.slice(2));
} catch (err) {
  console.error(`serve-ports: ${err.message}`);
  console.error('try: node serve-ports.mjs 3000:api 5173:frontend');
  process.exit(2);
}

for (const { port, label } of listeners) {
  const server = createServer((req, res) => {
    const body = JSON.stringify(
      {
        success: true,
        port,
        label,
        method: req.method,
        path: req.url,
        host: req.headers.host ?? null,
        timestamp: new Date().toISOString(),
      },
      null,
      2,
    );
    res.setHeader('content-type', 'application/json');
    res.setHeader('cache-control', 'no-store');
    res.end(body + '\n');
  });

  server.on('error', (err) => {
    console.error(`serve-ports[${port}]: ${err.message}`);
    process.exit(1);
  });

  server.listen(port, '0.0.0.0', () => {
    console.log(`serve-ports[${label}]: listening on 0.0.0.0:${port}`);
  });
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`\nserve-ports: ${signal} received, exiting`);
    process.exit(0);
  });
}
