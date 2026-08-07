import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { sendMail } from '../src/services/smtp.js';

// Spin up a tiny mock SMTP server that speaks enough of the protocol
// (EHLO, AUTH LOGIN, MAIL/RCPT/DATA) to validate our client's conversation.
function mockServer() {
  const captured = { rcpt: [], mailFrom: null, data: '', authUser: null, authPass: null };
  const server = net.createServer((sock) => {
    sock.setEncoding('utf8');
    let buf = '';
    let inData = false;
    let authStep = 0; // 1 = expecting username, 2 = expecting password
    sock.write('220 mock ESMTP\r\n');
    sock.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (inData) {
          if (line === '.') { inData = false; sock.write('250 OK: queued\r\n'); }
          else captured.data += line + '\n';
          continue;
        }
        if (authStep === 1) { captured.authUser = Buffer.from(line, 'base64').toString(); authStep = 2; sock.write('334 UGFzc3dvcmQ6\r\n'); continue; }
        if (authStep === 2) { captured.authPass = Buffer.from(line, 'base64').toString(); authStep = 0; sock.write('235 Authentication succeeded\r\n'); continue; }
        const cmd = line.toUpperCase();
        if (cmd.startsWith('EHLO')) sock.write('250-mock\r\n250 AUTH LOGIN\r\n');
        else if (cmd.startsWith('AUTH LOGIN')) { authStep = 1; sock.write('334 VXNlcm5hbWU6\r\n'); }
        else if (cmd.startsWith('MAIL FROM')) { captured.mailFrom = line; sock.write('250 OK\r\n'); }
        else if (cmd.startsWith('RCPT TO')) { captured.rcpt.push(line); sock.write('250 OK\r\n'); }
        else if (cmd === 'DATA') { inData = true; sock.write('354 Start mail input\r\n'); }
        else if (cmd === 'QUIT') { sock.write('221 Bye\r\n'); sock.end(); }
        else sock.write('250 OK\r\n');
      }
    });
    sock.on('error', () => {});
  });
  return { server, captured };
}

test('sendMail completes the SMTP conversation and delivers the message', async () => {
  const { server, captured } = mockServer();
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const { port } = server.address();
  try {
    await sendMail(
      { host: '127.0.0.1', port, secure: false, user: 'me@x.com', pass: 'secret' },
      { from: 'me@x.com', to: 'admin@x.com', subject: 'New purchase request', text: 'Hello\n.dotline\nWorld' }
    );
  } finally {
    server.close();
  }
  assert.equal(captured.authUser, 'me@x.com');
  assert.equal(captured.authPass, 'secret');
  assert.match(captured.mailFrom, /me@x\.com/);
  assert.ok(captured.rcpt.some((r) => /admin@x\.com/.test(r)));
  assert.match(captured.data, /Subject: New purchase request/);
  assert.match(captured.data, /Hello/);
  assert.match(captured.data, /World/);
  // dot-stuffing: our '.dotline' must be sent on the wire as '..dotline'
  // (the receiver un-stuffs it back to '.dotline'; our mock captures raw).
  assert.match(captured.data, /\n\.\.dotline/);
});
