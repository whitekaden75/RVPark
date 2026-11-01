import { useEffect, useState } from "react";
import { checkCheckoutReturn } from "./checkout-return.js";

export default function CheckoutReturnPage({ sessionId, request, onReady }) {
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setError("");
    setResult(null);
    checkCheckoutReturn({
      sessionId, request, onReady,
      isCancelled: () => cancelled,
      redirect: url => window.location.replace(url)
    }).then(value => {
      if (!cancelled) setResult(value);
    }).catch(error => {
      if (!cancelled) setError(error.message);
    }).finally(() => {
      if (!cancelled) setIsLoading(false);
    });
    return () => { cancelled = true; };
  }, [sessionId, request, onReady, attempt]);

  return (
    <main className="public-payment-page">
      <section className="public-payment-card" aria-live="polite">
        <p className="eyebrow">Riverpark RV Resort · Secure payment</p>
        <h1>{isLoading ? "Checking your payment" : result?.verificationUrl
          ? "Verify your bank account" : "Your payment needs attention"}</h1>
        {isLoading ? <p>Checking whether you need to complete another step...</p> :
          error ? <p className="message error">{error}</p> : result?.verificationUrl ? (
            <>
              <p>Opening Stripe to finish verifying your bank account. If small deposits are required, they can take 1–2 business days to appear.</p>
              <a className="primary-button" href={result.verificationUrl}>Continue bank verification</a>
            </>
          ) : (
            <p>Your payment has not been completed. Check its status again or contact the office for help before starting another payment.</p>
          )}
        {!isLoading ? <button className="ghost-button" type="button" onClick={() => setAttempt(value => value + 1)}>Check payment status again</button> : null}
        <p className="public-payment-help">Questions? Call Riverpark RV Resort at <a href="tel:+15412951269">(541) 295-1269</a>.</p>
      </section>
    </main>
  );
}
