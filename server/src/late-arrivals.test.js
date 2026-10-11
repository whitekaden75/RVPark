import test from 'node:test';
import assert from 'node:assert/strict';
import { getParkClock, getAutomaticLateArrivalDate, buildLateArrivalMessage, createLateArrivalTexts } from './late-arrivals.js';

const booking = (overrides = {}) => ({ id: 12, status: 'active', created_at: '2026-10-11T00:05:00Z',
  first_name: 'Alex', last_name: 'Morgan', phone_number: '5415550101', notes: '',
  siteStays: [{ id: 100, site_number: 'A1', arrival_date: '2026-10-10', leave_date: '2026-10-13' }],
  checkIns: [], ...overrides });

test('automatic texts use 5 PM Pacific including the exact cutoff, daylight saving and winter time', () => {
  assert.deepEqual(getParkClock('2026-10-11T00:00:00Z'), { date: '2026-10-10', hour: 17 });
  assert.equal(getAutomaticLateArrivalDate(booking({ created_at: '2026-10-10T23:59:59Z' })), null);
  assert.equal(getAutomaticLateArrivalDate(booking({ created_at: '2026-10-11T00:00:00Z' })), '2026-10-10');
  assert.equal(getAutomaticLateArrivalDate(booking({ created_at: '2026-12-11T01:00:00Z',
    siteStays: [{ arrival_date: '2026-12-10' }] })), '2026-12-10');
  assert.equal(getAutomaticLateArrivalDate(booking({ created_at: '2026-12-11T00:59:59Z',
    siteStays: [{ arrival_date: '2026-12-10' }] })), null);
});

test('next-day arrivals, earlier bookings, canceled and ordinary pending bookings are excluded', () => {
  assert.equal(getAutomaticLateArrivalDate(booking({ siteStays: [{ arrival_date: '2026-10-11' }] })), null);
  assert.equal(getAutomaticLateArrivalDate(booking({ created_at: '2026-10-10T00:05:00Z' })), null);
  assert.equal(getAutomaticLateArrivalDate(booking({ status: 'canceled' })), null);
  assert.equal(getAutomaticLateArrivalDate(booking({ status: 'pending' })), null);
  assert.equal(getAutomaticLateArrivalDate(booking({ status: 'pending', notes: 'AFTER-HOURS DRIVE-UP — cash envelope' })), '2026-10-10');
  assert.equal(getAutomaticLateArrivalDate(booking({ created_at: null })), null);
  assert.equal(getAutomaticLateArrivalDate(booking({ created_at: 'invalid' })), null);
  assert.equal(getAutomaticLateArrivalDate(booking({ siteStays: [{ arrival_date: '2026-10-10' }, { arrival_date: '2026-10-01' }] })), null);
});

test('automatic message reuses arrival instructions and includes the remaining-balance link when provided', () => {
  const text = buildLateArrivalMessage(booking(), '2026-10-10', { url: 'https://example.com/?pay=signed', bankAmount: 120, cardAmount: 130 });
  assert.match(text, /Welcome Alex Morgan - Site #A1/);
  assert.match(text, /gray bin/);
  assert.match(text, /Card payment \(secure link\): \$130\.00/);
  assert.match(text, /Cash or check: \$120\.00/);
  assert.match(text, /https:\/\/example.com\/\?pay=signed/);
  assert.doesNotMatch(buildLateArrivalMessage(booking(), '2026-10-10'), /Card payment/);
});

function harness({ reservation = booking(), sendError, saveError = false, configured = true, now = '2026-10-11T00:10:00Z' } = {}) {
  const log = new Map(), sent = [], queries = [];
  const pool = { async query(sql, values = []) {
    queries.push({ sql, values });
    const key = `${values[0]}:${values[1]}`;
    if (sql.includes('SELECT sid FROM text_messages')) return { rows: [], rowCount: 0 };
    if (sql.includes('INSERT INTO late_arrival_texts')) {
      const previous = log.get(key);
      if (previous && !(previous.state === 'failed' && (!values[2] || previous.retryable && previous.attempts < 3 && previous.old))) {
        return { rows: [], rowCount: 0 };
      }
      log.set(key, { state: 'sending', attempts: (previous?.attempts || 0) + 1 });
      return { rows: [{ reservation_id: values[0] }], rowCount: 1 };
    }
    if (sql.includes("SET state='sent'")) {
      if (saveError) throw new Error('Database connection lost after provider acceptance');
      Object.assign(log.get(key), { state: 'sent', sid: values[2] });
    } else if (sql.includes('SET state=$3')) {
      Object.assign(log.get(key), { state: values[2], message: values[3], retryable: values[4] });
    } else if (sql.includes('SELECT r.id FROM reservations')) return { rows: [{ id: reservation.id }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  }};
  const service = createLateArrivalTexts({ pool, getReservation: async () => reservation,
    normalizePhone: phone => phone ? `+1${phone}` : '', configured: () => configured,
    now: () => new Date(now), createPaymentLink: async () => null, logger: { error() {} },
    send: async message => { sent.push(message); if (sendError) throw sendError; return { sid: 'SMaccepted' }; },
  });
  return { service, sent, log, queries };
}

test('simultaneous webhook and manual sends share one claim; later retries cannot send twice', async () => {
  const { service, sent, log } = harness();
  const results = await Promise.all([service.sendReservation(12), service.sendReservation(12, { automatic: false, customBody: 'Custom directions' })]);
  assert.deepEqual(results.map(result => result.state).sort(), ['sent', 'skipped']);
  assert.equal(sent.length, 1);
  assert.equal(log.get('12:2026-10-10').state, 'sent');
  assert.equal((await service.sendReservation(12)).state, 'skipped');
  assert.equal(sent.length, 1);
});

test('opt-outs, missing phones, checked-in guests and unconfigured messaging never send', async () => {
  for (const options of [
    { reservation: booking({ notes: 'Guest did not opt in to text messages.' }) },
    { reservation: booking({ phone_number: '' }) },
    { reservation: booking({ checkIns: [{ reservationSiteStayId: 100 }] }) },
    { configured: false },
    { now: '2026-10-12T00:10:00Z' },
  ]) {
    const { service, sent, log } = harness(options);
    assert.equal((await service.sendReservation(12)).state, 'skipped');
    assert.equal(sent.length, 0);
    assert.equal(log.size, 0);
  }
});

test('a return visit is not blocked by a check-in for an earlier stay', async () => {
  const { service, sent } = harness({ reservation: booking({ created_at: '2026-10-01T00:10:00Z',
    checkIns: [{ reservationSiteStayId: 90 }], siteStays: [
      { id: 90, arrival_date: '2026-09-30', leave_date: '2026-10-01' },
      { id: 100, site_number: 'A1', arrival_date: '2026-10-10', leave_date: '2026-10-13' },
    ] }) });
  assert.equal((await service.sendReservation(12, { automatic: false, customBody: 'Office directions' })).state, 'sent');
  assert.equal(sent[0].body, 'Office directions');
});

test('uncertain provider delivery and failed post-send storage never automatically resend', async () => {
  for (const options of [{ sendError: new Error('Response lost') }, { saveError: true }]) {
    const { service, sent } = harness(options);
    assert.equal((await service.sendReservation(12)).state, 'review');
    assert.equal((await service.sendReservation(12)).state, 'skipped');
    assert.equal(sent.length, 1);
  }
});

test('only explicit throttling is automatically retryable and it waits before retrying', async () => {
  const { service, sent, log } = harness({ sendError: Object.assign(new Error('Rate limited'), { status: 429 }) });
  assert.equal((await service.sendReservation(12)).state, 'failed');
  assert.equal(log.get('12:2026-10-10').retryable, true);
  assert.equal((await service.sendReservation(12)).state, 'skipped');
  log.get('12:2026-10-10').old = true;
  assert.equal((await service.sendReservation(12)).state, 'failed');
  assert.equal(sent.length, 2);
  const rejected = harness({ sendError: Object.assign(new Error('Guest opted out at provider'), { status: 400 }) });
  await rejected.service.sendReservation(12);
  assert.equal(rejected.log.get('12:2026-10-10').retryable, false);
});

test('startup scan sends only after 5 PM and uses the same durable claims as direct sends', async () => {
  const early = harness({ now: '2026-10-10T23:00:00Z' });
  assert.deepEqual(await early.service.scan(), []);
  assert.equal(early.queries.length, 0);
  const late = harness();
  assert.equal((await late.service.scan())[0].state, 'sent');
  await late.service.scan();
  assert.equal(late.sent.length, 1);
});
