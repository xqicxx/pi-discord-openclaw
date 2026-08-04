// Transport 层验证：discord-gateway（identify/heartbeat/resume/MESSAGE_CREATE/断线重连）
import { DiscordGateway } from '../src/transport/discord-gateway.ts';

let pass = 0, fail = 0;
function assert(cond, label) {
  if (cond) { pass++; console.log('  ✅', label); }
  else { fail++; console.log('  ❌', label); }
}

/** 模拟 WebSocket：记录发送，手动注入接收事件。 */
class FakeSocket {
  static OPEN = 1;
  readyState = FakeSocket.OPEN;
  sent = [];
  listeners = {};
  constructor(url) { this.url = url; FakeSocket.last = this; }
  addEventListener(ev, fn) { (this.listeners[ev] ??= []).push(fn); }
  emit(ev, data) { for (const fn of this.listeners[ev] ?? []) fn(typeof data === 'string' ? { data } : data); }
  send(payload) { this.sent.push(JSON.parse(payload)); }
  close() { this.readyState = 3; }
}

// 1. Hello → Identify（token/intents/properties）
{
  FakeSocket.last = null;
  const gw = new DiscordGateway({ token: 'tok', intents: 513, createSocket: (url) => new FakeSocket(url) });
  gw.connect();
  const sock = FakeSocket.last;
  sock.emit('open', {});
  sock.emit('message', { data: JSON.stringify({ op: 10, d: { heartbeat_interval: 45000 } }) });
  assert(sock.sent.length === 1 && sock.sent[0].op === 2, 'Hello 后发送 Identify (op=2)');
  assert(sock.sent[0].d.token === 'tok' && sock.sent[0].d.intents === 513, 'Identify 带 token/intents');
  assert(sock.sent[0].d.properties?.browser === 'pi-discord-openclaw', 'Identify properties');
  gw.disconnect();
}

// 2. READY → events.ready（session_id 保存，可 resume）
{
  FakeSocket.last = null;
  const gw = new DiscordGateway({ token: 't', intents: 0, createSocket: (url) => new FakeSocket(url) });
  let ready = null;
  gw.events.on('ready', (d) => { ready = d; });
  gw.connect();
  const sock = FakeSocket.last;
  sock.emit('open', {});
  sock.emit('message', { data: JSON.stringify({ op: 10, d: { heartbeat_interval: 45000 } }) });
  sock.emit('message', { data: JSON.stringify({ op: 0, t: 'READY', s: 1, d: { session_id: 's1', resume_gateway_url: 'wss://resume.example' } }) });
  assert(ready?.session_id === 's1', 'READY 事件触发');
  assert(gw.isConnected === true, 'connected=true');
  gw.disconnect();
}

// 3. Heartbeat：interval 触发 op=1 携带 sequence；ACK 后继续
{
  FakeSocket.last = null;
  const gw = new DiscordGateway({ token: 't', intents: 0, createSocket: (url) => new FakeSocket(url) });
  gw.connect();
  const sock = FakeSocket.last;
  sock.emit('open', {});
  sock.emit('message', { data: JSON.stringify({ op: 10, d: { heartbeat_interval: 30 } }) });
  // 清掉 identify
  sock.sent.length = 0;
  await new Promise(r => setTimeout(r, 50));
  assert(sock.sent.some(p => p.op === 1), 'heartbeat 定时发送 op=1');
  sock.emit('message', { data: JSON.stringify({ op: 11, d: null }) });
  await new Promise(r => setTimeout(r, 50));
  const hbs = sock.sent.filter(p => p.op === 1);
  assert(hbs.length >= 2, `ACK 后继续心跳（${hbs.length} 次）`);
  gw.disconnect();
}

// 4. MESSAGE_CREATE → events.messageCreate
{
  FakeSocket.last = null;
  const gw = new DiscordGateway({ token: 't', intents: 0, createSocket: (url) => new FakeSocket(url) });
  let msg = null;
  gw.events.on('messageCreate', (m) => { msg = m; });
  gw.connect();
  const sock = FakeSocket.last;
  sock.emit('open', {});
  sock.emit('message', { data: JSON.stringify({ op: 0, t: 'MESSAGE_CREATE', s: 5, d: { id: 'm1', channel_id: 'c1', content: 'hello', author: { id: 'u1', username: 'x', bot: false } } }) });
  assert(msg?.id === 'm1' && msg?.channel_id === 'c1' && msg?.content === 'hello', 'MESSAGE_CREATE 分发');
  gw.disconnect();
}

// 5. resume：断线（非 fatal）→ 指数退避重连，resume=true 时 Hello 后发 Resume
{
  FakeSocket.last = null;
  let connects = 0;
  const gw = new DiscordGateway({ token: 't', intents: 0, createSocket: (url) => { connects++; return new FakeSocket(url); } });
  gw.connect();
  let sock = FakeSocket.last;
  sock.emit('open', {});
  sock.emit('message', { data: JSON.stringify({ op: 10, d: { heartbeat_interval: 45000 } }) });
  sock.emit('message', { data: JSON.stringify({ op: 0, t: 'READY', s: 2, d: { session_id: 's9', resume_gateway_url: 'wss://resume.example' } }) });
  // 触发 close（1006 非 fatal）→ 自动重连（退避 1s）
  sock.readyState = 3;
  sock.emit('close', { code: 1006 });
  await new Promise(r => setTimeout(r, 1200));
  assert(connects >= 2, `断线后自动重连（${connects} 次连接）`);
  sock = FakeSocket.last;
  sock.emit('open', {});
  sock.emit('message', { data: JSON.stringify({ op: 10, d: { heartbeat_interval: 45000 } }) });
  assert(sock.sent.some(p => p.op === 6 && p.d.session_id === 's9'), 'resume 发送 Resume (op=6) 带 session_id');
  gw.disconnect();
}

// 6. fatal close code → events.fatal（不再重连）
{
  FakeSocket.last = null;
  const gw = new DiscordGateway({ token: 't', intents: 0, createSocket: (url) => new FakeSocket(url) });
  let fatal = null;
  gw.events.on('fatal', (c) => { fatal = c; });
  gw.connect();
  const sock = FakeSocket.last;
  sock.emit('open', {});
  sock.emit('message', { data: JSON.stringify({ op: 10, d: { heartbeat_interval: 45000 } }) });
  sock.readyState = 3;
  sock.emit('close', { code: 4004 }); // AuthenticationFailed
  assert(fatal === 4004, 'fatal 关闭码 4004 → fatal 事件');
  gw.disconnect();
}

console.log(`\ngateway tests: ${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);
