import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Alert, Dialog, DialogContent, DialogTitle, useMediaQuery } from "@mui/material";
import "./message-inbox.css";

function Icon({ name }) {
  const paths = {
    back: <path d="m14 6-6 6 6 6" />,
    send: <path d="M12 19V5m-6 6 6-6 6 6" />,
    compose: <><path d="M13 5H5v14h14v-8M15 4l5 5M10 14l4-1 7-7-4-4-7 7-1 5Z" /></>,
    info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v6m0-10v1" /></>,
    close: <path d="m6 6 12 12M6 18 18 6" />,
  };
  return <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

const phoneKey = value => String(value || "").replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
const isOutbound = message => String(message.direction || "").startsWith("outbound");
const timestamp = message => new Date(message.dateSent || 0).getTime() || 0;
const unread = message => message.direction === "inbound" && message.status !== "read";

function shortTime(value) {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) return "Pending";
  return date.toDateString() === new Date().toDateString()
    ? date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : date.toLocaleDateString([], { month: "short", day: "numeric" });
}

export default function MessageInbox({ messages, customers, selectedNumber, onSelect, onBack,
  newMessageOpen, onNewMessageOpen, onNewMessageClose, form, setForm, onSend,
  isSending, configured, isLoading, hasMore, onLoadMore, onSync, error, formatPhone }) {
  const isMobile = useMediaQuery("(max-width: 759px)");
  const [search, setSearch] = useState("");
  const [showStay, setShowStay] = useState(false);
  const [drafts, setDrafts] = useState({});
  const [viewport, setViewport] = useState(null);
  const historyRef = useRef(null);
  const inputRef = useRef(null);
  const scrollState = useRef({ key: "", latest: "", viewportHeight: null });
  const nearBottom = useRef(true);

  const conversations = useMemo(() => {
    const grouped = new Map();
    for (const message of messages) {
      const number = isOutbound(message) ? message.to : message.from;
      if (!number) continue;
      const key = phoneKey(number);
      if (!grouped.has(key)) grouped.set(key, { key, number, messages: [], bookings: [] });
      grouped.get(key).messages.push(message);
    }
    for (const conversation of grouped.values()) {
      conversation.messages.sort((a, b) => timestamp(a) - timestamp(b) || a.sid.localeCompare(b.sid));
      conversation.latest = conversation.messages.at(-1);
      conversation.bookings = [...conversation.messages].reverse().find(message => message.bookings?.length)?.bookings || [];
      const guest = conversation.bookings[0] || customers.find(customer => phoneKey(customer.phone_number) === conversation.key);
      conversation.name = `${guest?.first_name || ""} ${guest?.last_name || ""}`.trim() || formatPhone(conversation.number);
      conversation.initials = guest ? `${guest.first_name?.[0] || ""}${guest.last_name?.[0] || ""}` || "?" : "#";
      conversation.unreadCount = conversation.messages.filter(unread).length;
    }
    return [...grouped.values()].sort((a, b) => timestamp(b.latest) - timestamp(a.latest));
  }, [messages, customers, formatPhone]);
  const selected = conversations.find(conversation => conversation.key === phoneKey(selectedNumber));
  const draftKey = selected?.key || "";
  const reply = drafts[draftKey] || "";
  const filtered = conversations.filter(conversation => `${conversation.name} ${conversation.number} ${formatPhone(conversation.number)} ${conversation.latest.body || ""}`.toLowerCase().includes(search.toLowerCase().trim()));
  const unreadCount = conversations.filter(conversation => conversation.unreadCount).length;

  useEffect(() => { setShowStay(false); }, [selectedNumber]);

  // Use the visible viewport so the reply bar stays above a phone's keyboard.
  useEffect(() => {
    if (!isMobile || (!selectedNumber && !newMessageOpen) || !window.visualViewport) return;
    const visual = window.visualViewport;
    const update = () => setViewport({ height: visual.height, top: visual.offsetTop });
    update();
    visual.addEventListener("resize", update);
    visual.addEventListener("scroll", update);
    return () => { visual.removeEventListener("resize", update); visual.removeEventListener("scroll", update); };
  }, [isMobile, selectedNumber, newMessageOpen]);

  const latestSid = selected?.latest.sid || "";
  useLayoutEffect(() => {
    const history = historyRef.current;
    if (!history) return;
    const changedThread = scrollState.current.key !== draftKey;
    const resized = scrollState.current.viewportHeight !== viewport?.height;
    if (changedThread || resized || (scrollState.current.latest !== latestSid && nearBottom.current)) {
      history.scrollTop = history.scrollHeight;
      nearBottom.current = true;
    }
    scrollState.current = { key: draftKey, latest: latestSid, viewportHeight: viewport?.height };
  }, [draftKey, latestSid, isMobile, viewport?.height]);

  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.style.height = "0px";
    input.style.height = `${Math.min(input.scrollHeight, 120)}px`;
  }, [reply, draftKey, isMobile]);

  async function sendReply(event) {
    event.preventDefault();
    if (!selected || !reply.trim() || isSending) return;
    const sent = await onSend({ to: selected.number, body: reply });
    if (sent) {
      setDrafts(current => ({ ...current, [draftKey]: current[draftKey] === reply ? "" : current[draftKey] }));
      if (historyRef.current) historyRef.current.scrollTop = historyRef.current.scrollHeight;
    }
  }

  async function sendNew(event) {
    event.preventDefault();
    if (!form.to.trim() || !form.body.trim() || isSending) return;
    const sent = await onSend(form);
    if (sent) { setForm({ to: "", body: "" }); onNewMessageClose(); onSelect({ number: sent.to }); }
  }

  const mobileDialogStyle = { "& .MuiDialog-paper": { margin: 0, width: "100%", maxWidth: "none", maxHeight: "none", height: viewport ? `${viewport.height}px` : "100dvh", position: "absolute", top: viewport?.top || 0, borderRadius: 0 } };
  const thread = selected ? <section className="messaging-thread" aria-label={`Conversation with ${selected.name}`}>
    <header className="messaging-thread-header">
      <button type="button" className="messaging-icon-button messaging-back" aria-label="Back to contacts" onClick={() => { scrollState.current.key = ""; onBack(); }}><Icon name="back" /></button>
      <span className="messaging-avatar" aria-hidden="true">{selected.initials}</span>
      <div className="messaging-thread-name"><strong id="messaging-thread-title" title={selected.name}>{selected.name}</strong><small>{formatPhone(selected.number)}</small></div>
      <button type="button" className="messaging-stay-button" aria-label={showStay ? "Hide stay information" : "Show stay information"} aria-expanded={showStay} aria-controls="messaging-stay-information" onClick={() => setShowStay(value => !value)}><Icon name="info" /><span>Stay</span></button>
    </header>
    {showStay ? <div id="messaging-stay-information" className="messaging-stay-info">
      <strong>Stay information</strong>
      {selected.bookings.length ? selected.bookings.map(booking => <div key={`${booking.customer_id}-${booking.reservation_id || "guest"}`}>
        <strong>{booking.first_name} {booking.last_name}</strong>
        {booking.reservation_id ? <><span>Booking #{booking.reservation_id} · {booking.status}</span>{booking.stays?.map((stay, index) => <span key={index}>Site {stay.site} · {stay.arrival} – {stay.departure === "9999-12-31" ? "Open-ended" : stay.departure}</span>)}<span>Total: ${Number(booking.total_price || 0).toFixed(2)} · Paid: ${Number(booking.amount_paid || 0).toFixed(2)}</span></> : <span>No bookings found for this guest.</span>}
      </div>) : <p>No matching stay information for this contact.</p>}
    </div> : null}
    <div className="messaging-bubbles" ref={historyRef} onScroll={event => { const node = event.currentTarget; nearBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80; }}>
      {hasMore ? <button className="messaging-text-button messaging-load" type="button" disabled={isLoading} onClick={onLoadMore}>{isLoading ? "Loading…" : "Load older messages"}</button> : null}
      {selected.messages.map(message => <article key={message.sid} className={`messaging-message ${isOutbound(message) ? "outbound" : "inbound"}`} aria-label={isOutbound(message) ? "Sent message" : "Received message"}>
        <div className="messaging-bubble">
          {message.body ? <p>{message.body}</p> : null}
          {message.mediaCount > 0 ? <p className="messaging-attachment">{message.mediaCount} attachment(s) · Media viewing is not available yet.</p> : null}
          {message.errorCode ? <p role="status">Delivery error: {message.errorCode}</p> : null}
        </div>
        <time title={new Date(message.dateSent).toLocaleString()}>{shortTime(message.dateSent)}</time>
      </article>)}
    </div>
    {error ? <Alert severity="error" className="messaging-error">{error}</Alert> : null}
    <form className="messaging-reply" onSubmit={sendReply}>
      <textarea ref={inputRef} rows="1" maxLength="1500" aria-label={`Message ${selected.name}`} placeholder="Text message" value={reply} onChange={event => setDrafts(current => ({ ...current, [draftKey]: event.target.value }))} />
      <button type="submit" className="messaging-send" aria-label={isSending ? "Sending message" : "Send message"} disabled={isSending || !reply.trim() || configured === false}><Icon name="send" /><span className="messaging-send-label">{isSending ? "Sending…" : "Send"}</span></button>
    </form>
  </section> : <div className="messaging-empty-thread"><Icon name="compose" /><h3>Your conversations</h3><p>Select a contact to read and reply.</p></div>;

  return <>
    <section className="messaging-inbox" aria-label="Text message inbox">
      <aside className="messaging-sidebar" aria-label="Contacts">
        <div className="messaging-sidebar-heading"><div><h3>Messages</h3><small>{unreadCount ? `${unreadCount} unread conversation${unreadCount === 1 ? "" : "s"}` : "You're all caught up"}</small></div><button type="button" className="messaging-icon-button" aria-label="Start a new message" onClick={onNewMessageOpen}><Icon name="compose" /></button></div>
        <div className="messaging-search"><input type="search" aria-label="Search conversations" placeholder="Search name or message" value={search} onChange={event => setSearch(event.target.value)} /></div>
        <nav className="messaging-contacts" aria-label="Conversations">
          {filtered.map(conversation => <button key={conversation.key} type="button" className={`messaging-contact ${selected?.key === conversation.key ? "selected" : ""}`} aria-current={selected?.key === conversation.key ? "true" : undefined} onClick={() => onSelect(conversation)}>
            <span className="messaging-avatar" aria-hidden="true">{conversation.initials}</span>
            <span className="messaging-contact-copy"><span className="messaging-contact-title"><strong>{conversation.name}</strong><time title={new Date(conversation.latest.dateSent).toLocaleString()}>{shortTime(conversation.latest.dateSent)}</time></span><span className="messaging-contact-preview"><span>{isOutbound(conversation.latest) ? "You: " : ""}{conversation.latest.body || (conversation.latest.mediaCount ? "Attachment" : "New message")}</span>{conversation.unreadCount ? <b className="messaging-unread" aria-label={`${conversation.unreadCount} unread messages`}>{conversation.unreadCount}</b> : null}</span></span>
          </button>)}
          {!filtered.length ? <p className="messaging-list-empty">{isLoading ? "Loading messages…" : search ? "No matching conversations." : "No messages yet. Start a new conversation above."}</p> : null}
        </nav>
        <footer className="messaging-sidebar-footer">{hasMore ? <button type="button" className="messaging-text-button" disabled={isLoading} onClick={onLoadMore}>Load older messages</button> : null}<button type="button" className="messaging-text-button" disabled={isLoading || !configured} onClick={onSync}>Sync history</button></footer>
      </aside>
      {!isMobile ? thread : null}
    </section>
    {isMobile ? <Dialog fullScreen open={Boolean(selected)} onClose={onBack} aria-labelledby="messaging-thread-title" sx={mobileDialogStyle}>{thread}</Dialog> : null}
    <Dialog open={newMessageOpen} onClose={isSending ? undefined : onNewMessageClose} fullScreen={isMobile} fullWidth maxWidth="sm" aria-labelledby="messaging-compose-title" sx={isMobile ? mobileDialogStyle : undefined}>
      <DialogTitle id="messaging-compose-title" className="messaging-compose-heading">New message<button type="button" className="messaging-icon-button" aria-label="Close new message" onClick={onNewMessageClose} disabled={isSending}><Icon name="close" /></button></DialogTitle>
      <DialogContent><form className="messaging-compose" onSubmit={sendNew}>
        <label>Guest mobile number<input autoFocus type="tel" inputMode="tel" autoComplete="tel" list="text-message-customer-phones" placeholder="(541) 555-1234" value={form.to} onChange={event => setForm(current => ({ ...current, to: formatPhone(event.target.value) }))} /></label>
        <datalist id="text-message-customer-phones">{customers.filter(customer => customer.phone_number).map(customer => <option key={customer.id} value={formatPhone(customer.phone_number)}>{customer.first_name} {customer.last_name}</option>)}</datalist>
        <label>Message<textarea rows="6" maxLength="1500" placeholder="Type your message…" value={form.body} onChange={event => setForm(current => ({ ...current, body: event.target.value }))} /></label>
        <small>{form.body.length} / 1,500 characters · STOP and HELP instructions are added automatically.</small>
        {error ? <Alert severity="error">{error}</Alert> : null}
        <button type="submit" className="messaging-send" disabled={isSending || !form.to.trim() || !form.body.trim() || configured === false}>{isSending ? "Sending…" : "Send text message"}<Icon name="send" /></button>
      </form></DialogContent>
    </Dialog>
  </>;
}
