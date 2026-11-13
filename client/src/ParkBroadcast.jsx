import { useEffect, useRef, useState } from 'react';
import { Alert, Dialog, DialogActions, DialogContent, DialogTitle } from '@mui/material';

const storageKey = 'rvpark-park-announcement';
const draftKey = 'rvpark-park-announcement-draft';
const read = key => { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } };
const save = (key, value) => { try { value == null ? localStorage.removeItem(key) : localStorage.setItem(key, JSON.stringify(value)); } catch { /* Storage may be unavailable. */ } };

function ParkIcon() {
  return <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m3 10 15-5v14L3 14v-4ZM18 9l3-1v8l-3-1M6 15l1 5h4l-2-4M3 10H1v4h2" /></svg>;
}

export default function ParkBroadcast({ apiRequest, configured, onSent }) {
  const [audience, setAudience] = useState(null);
  const [body, setBody] = useState(() => read(draftKey) || '');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reviewing, setReviewing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [request, setRequest] = useState(() => read(storageKey));
  const [result, setResult] = useState(null);
  const inFlight = useRef(false);
  const onSentRef = useRef(onSent);
  onSentRef.current = onSent;
  const busy = submitting || Boolean(request && (!result || result.state === 'sending'));
  const recipients = audience?.recipients || [];

  async function refresh() {
    setLoading(true);
    setError('');
    try { setAudience(await apiRequest('/messages/park-broadcasts/preview')); }
    catch (failure) { setAudience(null); setError(failure.message); }
    finally { setLoading(false); }
  }

  useEffect(() => { void refresh(); }, []);
  useEffect(() => { save(draftKey, body); }, [body]);

  // Keep the request ID through navigation and lost responses. Status checks
  // never create a new broadcast or automatically resend a message.
  useEffect(() => {
    if (!request || submitting || result && result.state !== 'sending') return;
    let cancelled = false;
    let timer;
    async function poll() {
      try {
        const current = await apiRequest(`/messages/park-broadcasts/${request.id}`);
        if (cancelled) return;
        setResult(current);
        setError('');
        if (current.state !== 'sending') {
          onSentRef.current?.();
          return;
        }
      } catch (failure) {
        if (cancelled) return;
        setError(failure.status === 404 ? 'The send has not been recorded yet. Use “Check send status” to safely try the same request again.' : `${failure.message} Your announcement ID is saved; check its status before starting another.`);
      }
      timer = setTimeout(poll, 2500);
    }
    void poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [request, result?.state, submitting]);

  async function submit(savedRequest) {
    if (inFlight.current) return;
    inFlight.current = true;
    setSubmitting(true);
    setError('');
    const next = savedRequest || { id: crypto.randomUUID(), body: body.trim(), fingerprint: audience.fingerprint };
    save(storageKey, next);
    setRequest(next);
    setReviewing(false);
    try {
      const current = await apiRequest('/messages/park-broadcasts', { method: 'POST', body: JSON.stringify(next) });
      setResult(current);
      if (current.state !== 'sending') onSentRef.current?.();
    } catch (failure) {
      if (failure.status === 400 || failure.status === 409) {
        // These responses precede acceptance; a lost response retains its ID.
        setRequest(null);
        save(storageKey, null);
        if (failure.status === 409) await refresh();
      }
      setError(failure.message);
    } finally { inFlight.current = false; setSubmitting(false); }
  }

  function reset() {
    setRequest(null); setResult(null); setBody(''); setError('');
    save(storageKey, null); save(draftKey, null);
    void refresh();
  }

  const queued = result?.results.filter(row => row.state === 'queued').length || 0;
  const finished = result?.results.filter(row => !['waiting', 'sending'].includes(row.state)).length || 0;
  const needsAttention = result?.results.filter(row => ['failed', 'review'].includes(row.state) || row.message).length || 0;
  const parkDate = audience ? new Date(`${audience.date}T12:00:00`).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) : '';

  return <section className="park-broadcast" aria-labelledby="park-broadcast-title">
    <header className="park-broadcast-header">
      <span className="park-broadcast-icon"><ParkIcon /></span>
      <div><span className="messaging-eyebrow">PARK ANNOUNCEMENT</span><h3 id="park-broadcast-title">Text everyone in the park</h3><p>Keep daily guests, monthlies, and yearlies in the loop.</p></div>
      <span className="park-broadcast-private">Individual texts · Private replies</span>
    </header>
    <div className="park-broadcast-grid">
      <aside className="park-broadcast-audience" aria-label="Announcement recipients">
        <span className="messaging-eyebrow">CURRENTLY STAYING</span>
        <div className="park-broadcast-count" aria-live="polite"><strong>{loading ? '…' : audience?.recipientCount ?? '—'}</strong><span>mobile {audience?.recipientCount === 1 ? 'number' : 'numbers'}<small>{parkDate ? `${parkDate} · Pacific time` : 'Based on current stay dates'}</small></span></div>
        <div className="park-broadcast-tags">{['Daily', 'Monthly', 'Yearly'].map(type => <span key={type}>{type} <b>{recipients.filter(row => row.eligible && row.stayType === type).length}</b></span>)}</div>
        <p>Includes active stays covering today. Checkout dates are excluded. Shared numbers receive one text.</p>
        <button type="button" className="messaging-text-button" onClick={refresh} disabled={loading || busy}>{loading ? 'Loading recipients…' : '↻ Refresh recipients'}</button>
        {audience ? <details className="park-broadcast-recipient-details"><summary>Review guests {audience.skippedCount ? `· ${audience.skippedCount} skipped` : `(${recipients.length})`}</summary><ul>{recipients.map(guest => <li key={guest.id}><strong>{guest.name}<span className="park-broadcast-type">{guest.stayType}</span></strong><span>Site {guest.sites.join(', ')} · {guest.phone || 'No mobile number'}</span><small className={!guest.eligible ? 'park-broadcast-skipped' : ''}>{guest.skipReason || 'Included'}</small></li>)}</ul>{!recipients.length ? <p>No active stays cover today.</p> : null}</details> : null}
      </aside>
      <div className="park-broadcast-editor">
        {result ? <div className="park-broadcast-results" role="status" aria-live="polite">
          <h4>{result.state === 'sending' ? 'Sending your park update…' : result.state === 'review' ? 'Announcement needs review' : 'Announcement finished'}</h4>
          <p>{queued} {queued === 1 ? 'text' : 'texts'} queued{result.state === 'sending' ? ` · ${finished} of ${result.results.length} processed` : ` · ${needsAttention} need attention`}</p>
          {result.state === 'sending' ? <progress aria-label="Announcement progress" value={finished} max={result.results.length || 1} /> : null}
          <blockquote>{result.body}</blockquote>
          <details><summary>Delivery results ({result.results.length})</summary><ul>{result.results.map(guest => <li key={guest.phone}><strong>{guest.name}</strong><span>{guest.phone} · {guest.state}</span>{guest.message ? <small>{guest.message}</small> : null}</li>)}</ul></details>
          <small>Queued texts have been accepted for delivery. Replies appear in your inbox.</small>
          {result.state !== 'sending' ? <button type="button" className="messaging-send" onClick={reset}>New announcement</button> : null}
        </div> : <>
          <label className="park-broadcast-message-label" htmlFor="park-announcement-body">Your message<span>One update, sent to each guest separately.</span></label>
          <textarea id="park-announcement-body" rows="4" maxLength="1500" placeholder="Hi everyone! A quick update from the Riverpark office…" value={body} disabled={busy} onChange={event => setBody(event.target.value)} />
          <div className="park-broadcast-editor-note"><span>STOP and HELP instructions are added automatically.</span><span>{body.length.toLocaleString()} / 1,500</span></div>
          <footer className="park-broadcast-send-row"><small>Guests who opted out or have no valid number are skipped.</small><button type="button" className="messaging-send" disabled={busy || loading || !audience?.recipientCount || !body.trim() || configured !== true} onClick={() => setReviewing(true)}>Review &amp; send <span aria-hidden="true">↗</span></button></footer>
        </>}
        {error ? <Alert severity="warning">{error}</Alert> : null}
        {request && (error || !result) ? <button type="button" className="messaging-text-button" disabled={submitting} onClick={() => submit(request)}>{submitting ? 'Checking…' : 'Check send status'}</button> : null}
      </div>
    </div>
    <Dialog open={reviewing} onClose={() => setReviewing(false)} fullWidth maxWidth="sm" aria-labelledby="park-broadcast-review-title">
      <DialogTitle id="park-broadcast-review-title">Send to {audience?.recipientCount} mobile {audience?.recipientCount === 1 ? 'number' : 'numbers'}?</DialogTitle>
      <DialogContent className="park-broadcast-review"><p>Daily, monthly, and yearly guests with active stays for {parkDate}. Each guest receives an individual text.</p><blockquote>{body.trim()}</blockquote><small>Reply STOP to unsubscribe or HELP for assistance.</small></DialogContent>
      <DialogActions><button type="button" className="messaging-text-button" onClick={() => setReviewing(false)}>Keep editing</button><button type="button" className="messaging-send" disabled={submitting || configured !== true} onClick={() => submit()}>Send announcement</button></DialogActions>
    </Dialog>
  </section>;
}
