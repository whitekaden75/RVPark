import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

test('terminal submission uses only this guest’s Remember card choice and clears it after handoff', async () => {
  const source = readFileSync(new URL('./App.jsx', import.meta.url), 'utf8');
  const start = source.indexOf('  async function startTerminalPayment(');
  const end = source.indexOf('\n  async function sendCheckInBalanceToTerminal(', start);
  const requests = [];
  let choices = { 42: true, 43: false }, payment;
  const context = vm.createContext({ terminalRememberCards: choices,
    setTerminalPaymentError() {}, setPaymentLinkErrorMessage() {}, setSuccessMessage() {}, setStartingTerminalReservationId() {}, setTerminalReader() {},
    setTerminalRememberCards: update => { choices = update(choices); }, setTerminalPayment: value => { payment = value; },
    apiRequest: async (path, options) => { requests.push({ path, body: JSON.parse(options.body) }); return { paymentIntentId: 'pi_test', amount: '218.97', reader: {} }; },
  });
  vm.runInContext(`${source.slice(start, end)}\nthis.send = startTerminalPayment;`, context);
  await context.send({ id: 42 }, '218.97');
  assert.equal(requests[0].body.rememberCard, true);
  assert.equal(requests[0].body.storageAccepted, true);
  assert.equal(choices[42], false);
  assert.equal(payment.paymentIntentId, 'pi_test');
  await context.send({ id: 43 }, '55');
  assert.equal(requests[1].body.rememberCard, false);
  assert.equal(requests[1].body.storageAccepted, false);
  await context.send({ id: 42 }, '55', 'card', { rememberCard: false });
  assert.equal(requests[2].body.rememberCard, false);
});
