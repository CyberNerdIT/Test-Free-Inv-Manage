import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createUser } from '../src/auth.js';
import { setRaw } from '../src/settings.js';
import { notifyPurchase } from '../src/services/notify.js';

function mockSmtp() {
  const captured = { rcpt: [] };
  const server = net.createServer((sock) => {
    sock.setEncoding('utf8');
    let buf = '', inData = false;
    sock.write('220 mock\r\n');
    sock.on('data', (c) => {
      buf += c; let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (inData) { if (line === '.') { inData = false; sock.write('250 OK\r\n'); } continue; }
        const u = line.toUpperCase();
        if (u.startsWith('EHLO')) sock.write('250 mock\r\n');
        else if (u.startsWith('MAIL FROM')) sock.write('250 OK\r\n');
        else if (u.startsWith('RCPT TO')) { captured.rcpt.push(line); sock.write('250 OK\r\n'); }
        else if (u === 'DATA') { inData = true; sock.write('354 go\r\n'); }
        else if (u === 'QUIT') { sock.write('221 bye\r\n'); sock.end(); }
        else sock.write('250 OK\r\n');
      }
    });
    sock.on('error', () => {});
  });
  return { server, captured };
}

test('email purchase notifications are sent to the admin account email', async () => {
  createUser({ username: 'admin', password: 'supersecret1', role: 'admin', email: 'owner@example.com' });
  const { server, captured } = mockSmtp();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();

  setRaw('notify_channel', 'email');
  setRaw('smtp_host', '127.0.0.1');
  setRaw('smtp_port', String(port));
  setRaw('smtp_from', 'shop@example.com');

  const summary = await notifyPurchase({
    item_title: 'Test item', total_price: 100,
    customer_name: 'Buyer', customer_username: 'buyer',
  });
  server.close();

  assert.match(summary, /email: sent/);
  assert.ok(captured.rcpt.some((r) => /owner@example\.com/.test(r)), 'RCPT TO should be the admin email');
});
