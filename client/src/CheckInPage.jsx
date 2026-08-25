import { useMemo, useRef, useState } from "react";

const parkRules = [
  "This property is privately owned. Management reserves the right to refuse service to anyone and is not responsible for accidents, injuries, or loss of money or valuables of any kind.",
  "I agree to read and comply with all campground rules and regulations provided by the office and/or posted on the park map or brochure.",
  "Riverpark RV Resort is not liable for damage to any vehicle, RV, trailer, or personal property.",
  "Grass is watered nightly between 8:00 PM and 6:00 AM.",
];

const discountOptions = ["AAA", "Good Sam", "Veterans", "AARP"];

function formatDate(value) {
  if (!value) return "Not set";
  return new Date(`${value}T12:00:00`).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function getArrivalStay(reservation, date) {
  return (reservation.siteStays || []).find(
    (stay) => stay.arrival_date === date
  );
}

function getDefaultRvType(reservation) {
  if (reservation.motorhome_class_a) return "Motor home — Class A";
  if (reservation.motorhome_class_c) return "Motor home — Class C";
  return reservation.rv_kind || "";
}

function formatCurrency(value) {
  const amount = Number(value);

  if (!Number.isFinite(amount)) return "Not set";

  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(amount);
}

function getCheckInCardBalance(reservation) {
  if (
    reservation?.cardRemainingBalance !== null &&
    reservation?.cardRemainingBalance !== undefined
  ) {
    return Math.max(Number(reservation.cardRemainingBalance) || 0, 0);
  }

  const standardBalance = Number(reservation?.remainingBalance || 0);

  if (standardBalance <= 0) return 0;

  const amountWithCardPricing = standardBalance * 1.03;
  return (
    Math.round((Math.ceil(amountWithCardPricing - 0.99) + 0.99) * 100) / 100
  );
}

function getCheckInBankBalance(reservation) {
  const storedBankBalance = Number(reservation?.bankRemainingBalance);

  if (storedBankBalance > 0) return storedBankBalance;

  const selectedBalance = Number(reservation?.remainingBalance);

  if (selectedBalance > 0) return selectedBalance;

  const cardBalance = getCheckInCardBalance(reservation);
  const bankTotal = Number(reservation?.bankTotalPrice);
  const cardTotal = Number(reservation?.cardTotalPrice);

  if (cardBalance > 0 && bankTotal > 0 && cardTotal > 0) {
    return Math.round(cardBalance * (bankTotal / cardTotal) * 100) / 100;
  }

  if (cardBalance > 0) {
    for (let candidate = Math.floor(cardBalance); candidate > 0; candidate -= 1) {
      const amountWithCardPricing = candidate * 1.03;
      const candidateCardPrice =
        Math.round(
          (Math.ceil(amountWithCardPricing - 0.99) + 0.99) * 100
        ) / 100;

      if (candidateCardPrice === cardBalance) return candidate;
      if (cardBalance - candidate > 10) break;
    }
  }

  return 0;
}

function createCheckInForm(reservation) {
  const selectedDiscounts = (reservation.requestedDiscounts || []).map(
    (discount) => (discount === "Vets" ? "Veterans" : discount)
  );

  return {
    guestCount: "1",
    homeState: "",
    postalCode: "",
    rvMake: "",
    rvYear: "",
    rvType: getDefaultRvType(reservation),
    discountMemberships: selectedDiscounts.filter((discount) =>
      discountOptions.includes(discount)
    ),
    guestNotes: "",
    signedName: `${reservation.first_name || ""} ${reservation.last_name || ""}`.trim(),
    signatureDataUrl: "",
    rulesAccepted: false,
  };
}

function SignaturePad({ value, onChange }) {
  const canvasRef = useRef(null);
  const drawingRef = useRef(false);
  const hasInkRef = useRef(Boolean(value));

  function getPoint(event) {
    const canvas = canvasRef.current;
    const bounds = canvas.getBoundingClientRect();
    return {
      x: ((event.clientX - bounds.left) / bounds.width) * canvas.width,
      y: ((event.clientY - bounds.top) / bounds.height) * canvas.height,
    };
  }

  function startDrawing(event) {
    const canvas = canvasRef.current;
    const context = canvas.getContext("2d");
    const point = getPoint(event);
    drawingRef.current = true;
    hasInkRef.current = true;
    canvas.setPointerCapture(event.pointerId);
    context.beginPath();
    context.moveTo(point.x, point.y);
    context.lineWidth = 5;
    context.lineCap = "round";
    context.lineJoin = "round";
    context.strokeStyle = "#183b35";
  }

  function draw(event) {
    if (!drawingRef.current) return;
    const canvas = canvasRef.current;
    const context = canvas.getContext("2d");
    const point = getPoint(event);
    context.lineTo(point.x, point.y);
    context.stroke();
  }

  function finishDrawing() {
    if (!drawingRef.current) return;
    drawingRef.current = false;
    if (hasInkRef.current) onChange(canvasRef.current.toDataURL("image/png"));
  }

  function clearSignature() {
    const canvas = canvasRef.current;
    canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
    hasInkRef.current = false;
    onChange("");
  }

  return (
    <div className="signature-pad-shell">
      <canvas
        ref={canvasRef}
        className="signature-pad"
        width="1200"
        height="340"
        aria-label="Signature pad"
        onPointerDown={startDrawing}
        onPointerMove={draw}
        onPointerUp={finishDrawing}
        onPointerCancel={finishDrawing}
      />
      <span className="signature-line-label">Sign above this line</span>
      <button type="button" className="signature-clear" onClick={clearSignature}>
        Clear signature
      </button>
    </div>
  );
}

function CompletedCheckIn({ reservation, onBack }) {
  const checkIn = reservation.checkIn;

  return (
    <section className="checkin-kiosk-card checkin-complete-card">
      <div className="checkin-success-mark">✓</div>
      <p className="checkin-eyebrow">Checked in</p>
      <h2>Welcome, {reservation.first_name}</h2>
      <p>
        Site {getArrivalStay(reservation, reservation.siteStays?.[0]?.arrival_date)?.site_number || reservation.siteStays?.[0]?.site_number || "—"}
        {" • "}
        {new Date(checkIn.checkedInAt).toLocaleString()}
      </p>
      <div className="checkin-complete-signature">
        <span>Signed by {checkIn.signedName}</span>
        <img src={checkIn.signatureDataUrl} alt={`${checkIn.signedName}'s signature`} />
      </div>
      <button type="button" className="primary-button checkin-large-button" onClick={onBack}>
        Back to today’s arrivals
      </button>
    </section>
  );
}

export default function CheckInPage({
  reservations,
  today,
  isLoading = false,
  onSubmit,
  onOpenReservation,
  onLoadReservation,
  terminalReader,
  terminalPayment,
  terminalError,
  onSendToTerminal,
  onRecordOfficePayment,
  onRetryTerminal,
  onCancelTerminal,
}) {
  const [activeReservationId, setActiveReservationId] = useState(null);
  const [form, setForm] = useState(null);
  const [errorMessage, setErrorMessage] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isRecordingPayment, setIsRecordingPayment] = useState(false);
  const [officePaymentAmount, setOfficePaymentAmount] = useState("");
  const [isCashCheckOpen, setIsCashCheckOpen] = useState(false);
  const [search, setSearch] = useState("");

  const arrivals = useMemo(
    () =>
      reservations
        .filter(
          (reservation) =>
            reservation.status !== "canceled" &&
            (reservation.siteStays || []).some(
              (stay) => stay.arrival_date === today
            )
        )
        .filter((reservation) => {
          const query = search.trim().toLowerCase();
          if (!query) return true;
          const stay = getArrivalStay(reservation, today);
          return [
            reservation.first_name,
            reservation.last_name,
            reservation.phone_number,
            stay?.site_number,
          ]
            .filter(Boolean)
            .join(" ")
            .toLowerCase()
            .includes(query);
        })
        .sort((a, b) => Number(getArrivalStay(a, today)?.site_number || 0) - Number(getArrivalStay(b, today)?.site_number || 0)),
    [reservations, search, today]
  );
  const activeReservation = reservations.find(
    (reservation) => reservation.id === activeReservationId
  );

  async function beginCheckIn(reservation) {
    setErrorMessage("");

    try {
      const completeReservation =
        reservation.checkIn && !reservation.checkIn.signatureDataUrl
          ? await onLoadReservation(reservation.id)
          : reservation;
      setActiveReservationId(completeReservation.id);
      setForm(createCheckInForm(completeReservation));
      setIsCashCheckOpen(false);
      const bankBalance = getCheckInBankBalance(completeReservation);
      setOfficePaymentAmount(bankBalance > 0 ? bankBalance.toFixed(2) : "");
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (error) {
      setErrorMessage(error.message);
    }
  }

  async function recordCashCheckPayment(tenderType) {
    const amount = Number(officePaymentAmount);

    if (!Number.isFinite(amount) || amount <= 0) {
      setErrorMessage("Enter a cash or check amount greater than zero.");
      return;
    }

    setErrorMessage("");
    setIsRecordingPayment(true);

    try {
      const updatedReservation = await onRecordOfficePayment(
        activeReservation,
        amount,
        tenderType
      );
      const remainingBankBalance = getCheckInBankBalance(updatedReservation);
      setOfficePaymentAmount(
        remainingBankBalance > 0 ? remainingBankBalance.toFixed(2) : ""
      );
    } catch (error) {
      setErrorMessage(error.message);
    } finally {
      setIsRecordingPayment(false);
    }
  }

  function updateField(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  async function submitCheckIn(event) {
    event.preventDefault();
    setErrorMessage("");

    if (!form.signatureDataUrl) {
      setErrorMessage("Please sign in the signature box before finishing.");
      return;
    }

    try {
      setIsSubmitting(true);
      const standardBalance = getCheckInBankBalance(activeReservation);
      const cardBalance = getCheckInCardBalance(activeReservation);
      const selectedBalance = cardBalance;

      if (selectedBalance > 0) {
        const result = await onSendToTerminal(
          activeReservation,
          form,
          selectedBalance,
          "card"
        );

        if (!result) {
          setErrorMessage(
            "The payment could not be sent to the Terminal. Check the reader message below."
          );
        }
      } else {
        await onSubmit(activeReservation, form);
      }
    } catch (error) {
      setErrorMessage(error.message);
    } finally {
      setIsSubmitting(false);
    }
  }

  if (activeReservation?.checkIn) {
    return (
      <CompletedCheckIn
        reservation={activeReservation}
        onBack={() => {
          setActiveReservationId(null);
          setForm(null);
        }}
      />
    );
  }

  if (activeReservation && form) {
    const arrivalStay = getArrivalStay(activeReservation, today) || activeReservation.siteStays?.[0];
    const standardBalance = getCheckInBankBalance(activeReservation);
    const cardBalance = getCheckInCardBalance(activeReservation);
    const hasBalance = standardBalance > 0 || cardBalance > 0;
    const displayedBankPrice = hasBalance
      ? standardBalance
      : Number(
          activeReservation.bankTotalPrice ??
            (activeReservation.selectedPaymentMethod === "bank"
              ? activeReservation.effectiveTotalPrice
              : 0)
        ) || 0;
    const displayedCardPrice = hasBalance
      ? cardBalance
      : Number(
          activeReservation.cardTotalPrice ??
            (activeReservation.selectedPaymentMethod === "card"
              ? activeReservation.effectiveTotalPrice
              : 0)
        ) || 0;
    const activeTerminalPayment =
      terminalPayment?.reservationId === activeReservation.id
        ? terminalPayment
        : null;
    const terminalInProgress = activeTerminalPayment?.status === "in_progress";
    const terminalFailed = activeTerminalPayment?.status === "failed";
    const terminalBusy = terminalPayment?.status === "in_progress";
    const readerOnline = terminalReader?.status === "online";

    return (
      <form className="checkin-kiosk-card" onSubmit={submitCheckIn}>
        <header className="checkin-kiosk-header">
          <button
            type="button"
            className="checkin-back-button"
            onClick={() => {
              setActiveReservationId(null);
              setForm(null);
            }}>
            ← Office view
          </button>
          <div className="checkin-brand-mark">R</div>
          <p className="checkin-eyebrow">Riverpark RV Resort</p>
          <h2>Welcome to the river</h2>
          <p>Please confirm your stay details and sign our park agreement.</p>
        </header>

        <section className="checkin-stay-banner">
          <div><span>Guest</span><strong>{activeReservation.first_name} {activeReservation.last_name}</strong></div>
          <div><span>Site</span><strong>{arrivalStay?.site_number || "—"}</strong></div>
          <div><span>Arrival</span><strong>{formatDate(arrivalStay?.arrival_date)}</strong></div>
          <div><span>Departure</span><strong>{formatDate(arrivalStay?.leave_date)}</strong></div>
        </section>

        <section className="checkin-form-section checkin-rules-section">
          <div className="checkin-section-heading"><span>01</span><div><h3>Park agreement</h3><p>Please read each item before signing.</p></div></div>
          <div className="checkin-rules-list">{parkRules.map((rule, index) => <div key={rule}><span>{index + 1}</span><p>{rule}</p></div>)}</div>
          <div className="checkin-important-notice"><strong>Please remember</strong><span>No parking in empty spaces or on grass. No refunds.</span></div>
          <label className="checkin-acceptance"><input type="checkbox" required checked={form.rulesAccepted} onChange={(event) => updateField("rulesAccepted", event.target.checked)} /><span><strong>I have read and agree to the park rules.</strong><small>My signature below confirms this agreement.</small></span></label>
        </section>

        <section className="checkin-form-section">
          <div className="checkin-section-heading"><span>02</span><div><h3>Signature</h3><p>Use your finger or Apple Pencil inside the box.</p></div></div>
          <label>Printed name<input required value={form.signedName} onChange={(event) => updateField("signedName", event.target.value)} /></label>
          <SignaturePad value={form.signatureDataUrl} onChange={(value) => updateField("signatureDataUrl", value)} />
        </section>

        {displayedBankPrice > 0 || displayedCardPrice > 0 ? (
          <section className="checkin-terminal-section">
            <div>
              <span className={`terminal-reader-dot ${readerOnline ? "online" : "offline"}`} />
              <div>
                <strong>{terminalReader?.label || "Stripe Terminal"}</strong>
                <span>
                  {terminalReader
                    ? readerOnline
                      ? terminalReader.simulatorMode
                        ? "Test simulator — no real charge"
                        : "Online and ready"
                      : "Reader offline"
                    : "Checking reader connection…"}
                </span>
              </div>
            </div>
            <div className="checkin-terminal-balance">
              <span>Cash/check balance</span>
              <strong>{formatCurrency(displayedBankPrice)}</strong>
              <span>Terminal card balance</span>
              <strong>{formatCurrency(displayedCardPrice)}</strong>
            </div>
            {activeTerminalPayment ? (
              <div className={`checkin-terminal-progress ${activeTerminalPayment.status}`}>
                <strong>
                  {activeTerminalPayment.status === "succeeded"
                    ? "Payment approved"
                    : terminalFailed
                      ? "Payment needs attention"
                      : activeTerminalPayment.status === "canceled"
                        ? "Payment canceled"
                        : `Collecting ${formatCurrency(activeTerminalPayment.amount)}`}
                </strong>
                <span>{activeTerminalPayment.message}</span>
                {terminalFailed ? (
                  <button type="button" className="primary-button" onClick={onRetryTerminal}>
                    Try another card
                  </button>
                ) : null}
                {terminalInProgress ? (
                  <button type="button" className="ghost-button" onClick={onCancelTerminal}>
                    Cancel reader
                  </button>
                ) : null}
              </div>
            ) : null}
            {terminalError ? <div className="message error">{terminalError}</div> : null}
          </section>
        ) : null}

        {errorMessage ? <div className="message error checkin-message">{errorMessage}</div> : null}
        <footer className="checkin-submit-bar">
          <div>
            <strong>Ready to enjoy your stay?</strong>
            <span>
              {hasBalance
                ? "The guest will be checked in after the Terminal payment is approved."
                : null}
            </span>
          </div>
          {hasBalance ? (
            <div className="checkin-footer-payment-area">
              {isCashCheckOpen ? (
                <div className="checkin-cash-payment">
                  <label>
                    Cash or check amount
                    <input
                      type="number"
                      min="0.01"
                      step="0.01"
                      value={officePaymentAmount}
                      disabled={isRecordingPayment || terminalBusy}
                      onChange={(event) =>
                        setOfficePaymentAmount(event.target.value)
                      }
                    />
                  </label>
                  <div className="button-row">
                    <button
                      type="button"
                      className="ghost-button"
                      disabled={isRecordingPayment || terminalBusy}
                      onClick={() => recordCashCheckPayment("cash")}>
                      {isRecordingPayment ? "Recording…" : "Record cash"}
                    </button>
                    <button
                      type="button"
                      className="ghost-button"
                      disabled={isRecordingPayment || terminalBusy}
                      onClick={() => recordCashCheckPayment("check")}>
                      {isRecordingPayment ? "Recording…" : "Record check"}
                    </button>
                  </div>
                  <small>
                    Record this first for a split payment. The Terminal prices
                    will update to the remaining amount.
                  </small>
                </div>
              ) : null}
              <div className="checkin-terminal-submit-actions">
                <button
                  type="button"
                  className="ghost-button checkin-large-button"
                  aria-expanded={isCashCheckOpen}
                  onClick={() => setIsCashCheckOpen((current) => !current)}>
                  {isCashCheckOpen ? "Hide cash / check" : "Cash / check"}
                </button>
                <button
                  type="submit"
                  name="terminal-price-type"
                  value="card"
                  className="primary-button checkin-large-button"
                  disabled={
                    isSubmitting ||
                    terminalBusy ||
                    terminalFailed ||
                    !readerOnline ||
                    cardBalance <= 0
                  }>
                  {isSubmitting
                    ? "Sending…"
                    : terminalInProgress
                      ? "Waiting for payment…"
                      : terminalBusy
                        ? "Terminal is busy"
                        : `Pay by card ${formatCurrency(cardBalance)}`}
                </button>
              </div>
            </div>
          ) : (
            <button
              type="submit"
              className="primary-button checkin-large-button"
              disabled={isSubmitting}>
              {isSubmitting ? "Saving check-in…" : "Complete check-in"}
            </button>
          )}
        </footer>
      </form>
    );
  }

  const checkedInCount = arrivals.filter((reservation) => reservation.checkIn).length;

  return (
    <section className="card checkin-dashboard">
      <div className="checkin-dashboard-hero">
        <div><p className="checkin-eyebrow">Front desk</p><h2>Today’s arrivals</h2><p>{formatDate(today)} · Welcome each guest, collect their signature, and mark their arrival.</p></div>
        <div className="checkin-progress-ring">
          <strong>
            {isLoading ? "—" : `${checkedInCount}/${arrivals.length}`}
          </strong>
          <span>{isLoading ? "loading" : "checked in"}</span>
        </div>
      </div>
      <div className="checkin-dashboard-tools">
        <label>
          Find an arrival
          <input
            type="search"
            value={search}
            disabled={isLoading}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Guest, phone, or site number"
          />
        </label>
      </div>
      <div className="checkin-arrival-grid">
        {errorMessage ? <div className="message error">{errorMessage}</div> : null}
        {isLoading ? (
          <div className="checkin-empty-state" role="status" aria-live="polite">
            <div className="loading-spinner" aria-hidden="true" />
            <h3>Loading today’s arrivals…</h3>
            <p>Checking the reservation list now.</p>
          </div>
        ) : arrivals.length ? (
          arrivals.map((reservation) => {
            const stay = getArrivalStay(reservation, today);
            return <article key={reservation.id} className={`checkin-arrival-card ${reservation.checkIn ? "complete" : ""}`}><div className="checkin-site-chip">Site {stay?.site_number || "—"}</div><div><h3>{reservation.first_name} {reservation.last_name}</h3><p>{reservation.phone_number || "No phone on file"}</p><p>{reservation.rv_kind || "RV type not set"} · Departing {formatDate(stay?.leave_date)}</p></div><div className="checkin-arrival-actions"><span className={`checkin-status ${reservation.checkIn ? "complete" : "pending"}`}>{reservation.checkIn ? "✓ Checked in" : "Awaiting arrival"}</span><button type="button" className={reservation.checkIn ? "ghost-button" : "primary-button"} onClick={() => beginCheckIn(reservation)}>{reservation.checkIn ? "View signed form" : "Start check-in"}</button><button type="button" className="checkin-text-button" onClick={() => onOpenReservation(reservation)}>Open reservation</button></div></article>;
          })
        ) : (
          <div className="checkin-empty-state">
            <span>☀</span>
            <h3>No arrivals found</h3>
            <p>There are no matching reservations arriving today.</p>
          </div>
        )}
      </div>
    </section>
  );
}
