#!/usr/bin/env node
// Sends the dev session token to the local desktop helper (loopback only).
if (!process.env.SESSION) {
  console.error('SESSION is not set; run `dev login` first');
  process.exit(1);
}
const res = await fetch('http://127.0.0.1:8765/session', { method: 'POST', body: process.env.SESSION, headers: { 'Content-Type': 'text/plain' } });
if (!res.ok) throw new Error(`helper answered ${res.status}`);
console.log('session handed to the helper');
