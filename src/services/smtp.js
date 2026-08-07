// Minimal SMTP client (node:net / node:tls) — enough to send a plain-text
// notification email. Supports implicit TLS (465), STARTTLS (587/25), and
// AUTH LOGIN / PLAIN. No external dependencies.
import net from 'node:net';
import tls from 'node:tls';

function makeReader(socket) {
  let buf = '';
  let pending = null;
  const flush = () => {
    if (!pending) return;
    const lines = buf.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      // The final line of an SMTP reply has a space (not '-') after the code.
      if (/^\d{3} /.test(lines[i])) {
        const code = parseInt(lines[i].slice(0, 3), 10);
        const text = lines.slice(0, i + 1).join('\n');
        // Drop consumed lines from the buffer.
        buf = lines.slice(i + 1).join('\r\n');
        const p = pending; pending = null;
        p.resolve({ code, text });
        return;
      }
    }
  };
  socket.on('data', (d) => { buf += d.toString('utf8'); flush(); });
  return () => new Promise((resolve, reject) => { pending = { resolve, reject }; flush(); });
}

const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64');

function expect(r, ok, step) {
  if (!ok.includes(r.code)) throw new Error(`SMTP ${step} failed: ${r.text.split('\n')[0]}`);
}

export async function sendMail(cfg, { from, to, subject, text, html }) {
  const host = cfg.host;
  const port = cfg.port || (cfg.secure ? 465 : 587);
  const clientName = 'inventory-manager';

  let socket = cfg.secure
    ? tls.connect({ host, port, servername: host })
    : net.connect({ host, port });
  socket.setTimeout(15000);

  await new Promise((res, rej) => {
    socket.once(cfg.secure ? 'secureConnect' : 'connect', res);
    socket.once('error', rej);
    socket.once('timeout', () => rej(new Error('SMTP connection timed out')));
  });

  let read = makeReader(socket);
  const send = (s) => socket.write(s + '\r\n');

  try {
    expect(await read(), [220], 'greeting');
    send(`EHLO ${clientName}`);
    let ehlo = await read();
    expect(ehlo, [250], 'EHLO');

    if (!cfg.secure && /STARTTLS/i.test(ehlo.text)) {
      send('STARTTLS');
      expect(await read(), [220], 'STARTTLS');
      socket = tls.connect({ socket, servername: host });
      await new Promise((res, rej) => { socket.once('secureConnect', res); socket.once('error', rej); });
      read = makeReader(socket);
      send(`EHLO ${clientName}`);
      expect(await read(), [250], 'EHLO(tls)');
    }

    if (cfg.user && cfg.pass) {
      send('AUTH LOGIN');
      expect(await read(), [334], 'AUTH');
      send(b64(cfg.user));
      expect(await read(), [334], 'AUTH user');
      send(b64(cfg.pass));
      expect(await read(), [235], 'AUTH pass');
    }

    send(`MAIL FROM:<${from}>`);
    expect(await read(), [250], 'MAIL FROM');
    send(`RCPT TO:<${to}>`);
    expect(await read(), [250, 251], 'RCPT TO');
    send('DATA');
    expect(await read(), [354], 'DATA');

    const contentType = html ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8';
    const headers = [
      `From: ${from}`,
      `To: ${to}`,
      `Subject: ${subject}`,
      'MIME-Version: 1.0',
      `Content-Type: ${contentType}`,
    ].join('\r\n');
    // Dot-stuff any lines beginning with '.'
    const body = String(html || text).replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
    socket.write(headers + '\r\n\r\n' + body + '\r\n.\r\n');
    expect(await read(), [250], 'message body');

    send('QUIT');
    socket.end();
    return true;
  } finally {
    try { socket.destroy(); } catch { /* ignore */ }
  }
}
