import { DraftStream } from '../src/draft/draft-stream.ts';
const sent = []; const edited = [];
const s = new DraftStream({ throttleMs: 30, chunkSize: 50, transport: {
  sendMessage: async (t) => { sent.push(t); console.log('SEND:', JSON.stringify(t.slice(0,20))); return sent.length; },
  editMessage: async (id, t) => { edited.push(t); console.log('EDIT:', JSON.stringify(t.slice(0,20))); },
  deleteMessage: async () => {},
  sendChatAction: async () => {},
}});
s.update('hello');
console.log('update queued, pending timer set');
await new Promise((res) => setTimeout(res, 200));
console.log('after 200ms: sent=', sent.length, 'edited=', edited.length, 'messageId=', s.messageId());
await s.stop();
console.log('after stop: sent=', sent.length, 'edited=', edited.length);
