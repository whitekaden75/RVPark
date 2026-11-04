import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('./index.js', import.meta.url), 'utf8');
function fixture() {
  let handler;
  const events = [], intents = [], handoffs = [];
  const reader = { id: 'tmr_test', status: 'online' };
  const start = source.indexOf('app.post("/api/reservations/:id/terminal-payments",');
  const end = source.indexOf('\napp.get("/api/stripe/terminal/payments/:paymentIntentId",', start);
  vm.runInNewContext(source.slice(start, end), {
    app: { post: (_path, fn) => { handler = fn; } }, ensureStripeConfigured: () => true,
    toAmountCents: value => Math.round(Number(value) * 100), stripeMotoEnabled: true,
    syncOpenStripePayments: async () => {}, fetchReservationDetails: async () => ({ id: 42, customer_id: 30, status: 'active', siteStays: [] }),
    resolveStripeTerminalReader: async () => reader, openEndedStayDate: '9999-12-31',
    serializeTerminalReader: value => value, presentSimulatedTerminalPayment: async value => value,
    pool: { query: async () => { events.push('payment record'); } },
    terminalCardStorage: {
      prepare: async body => { if (body.storageAccepted !== true) throw Object.assign(new Error('Guest approval required'), { status: 400 }); events.push('prepare'); return { customer: 'cus_guest' }; },
      remember: async () => { events.push('consent record'); },
    },
    stripe: { paymentIntents: { create: async params => { events.push('create'); intents.push(params); return { id: 'pi_test', currency: 'usd' }; } },
      terminal: { readers: { processPaymentIntent: async (_id, params) => { events.push('reader'); handoffs.push(params); return reader; } } } },
  });
  const call = async body => {
    const res = { code: 200, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
    await handler({ params: { id: '42' }, body: { amount: '218.97', ...body }, adminUser: { id: 7 } }, res); return res;
  };
  return { call, events, intents, handoffs, reader };
}

test('Remember card saves consent before handoff and requests a reusable card on the same payment', async () => {
  const f = fixture();
  assert.equal((await f.call({ rememberCard: true, storageAccepted: true })).code, 202);
  assert.deepEqual(f.events, ['prepare', 'create', 'payment record', 'consent record', 'reader']);
  assert.equal(f.intents[0].customer, 'cus_guest');
  assert.equal(f.intents[0].setup_future_usage, 'off_session');
  assert.equal(f.intents[0].metadata.remember_card, 'true');
  assert.equal(f.intents[0].amount, 21897);
  assert.equal(f.handoffs[0].process_config.allow_redisplay, 'always');
});

test('leaving Remember card off creates a one-time payment without saving anything', async () => {
  const f = fixture();
  assert.equal((await f.call({ rememberCard: false })).code, 202);
  assert.deepEqual(f.events, ['create', 'payment record', 'reader']);
  assert.equal(f.intents[0].customer, undefined);
  assert.equal(f.intents[0].setup_future_usage, undefined);
  assert.equal(f.handoffs[0].process_config.allow_redisplay, undefined);
});

test('missing approval and an offline reader cannot initiate a remembering payment', async () => {
  const f = fixture();
  assert.equal((await f.call({ rememberCard: true, storageAccepted: false })).code, 400);
  assert.equal(f.intents.length, 0);
  f.reader.status = 'offline';
  assert.equal((await f.call({ rememberCard: true, storageAccepted: true })).code, 409);
  assert.equal(f.intents.length, 0);
});
