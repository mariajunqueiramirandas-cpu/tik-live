import { Check } from "lucide-react";
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api, ApiError, call, errorMessage } from "../lib/api";
import { dateTime, duration, money } from "../lib/format";
import { keys, queries, queryClient } from "../lib/query";
import type { BillingStatus } from "../lib/types";
import { Button, ButtonLink } from "../ui/Button";
import { Banner, Panel, Skeleton } from "../ui/Display";
import { Confirm } from "../ui/Overlay";
import { cx } from "../ui/cx";
import { toast } from "../ui/toast-store";
import p from "./page.module.css";
import s from "./billing.module.css";

type Offer = BillingStatus["offers"][number];
type Subscription = NonNullable<BillingStatus["subscription"]>;

function subscriptionLine(sub: Subscription): { text: string; tone: "ok" | "warn" | "bad" } {
  const next = sub.nextPaymentAt ? dateTime(sub.nextPaymentAt) : null;
  switch (sub.status) {
    case "authorized":
      if (sub.lastPaymentStatus === "rejected" && sub.graceUntil) return { text: `The last payment didn't go through. Mercado Pago retries; your plan stays active until ${dateTime(sub.graceUntil)}.`, tone: "bad" };
      return { text: next ? `Renews ${next}` : "Active", tone: "ok" };
    case "pending":
      return { text: "Waiting for Mercado Pago to confirm your payment.", tone: "warn" };
    case "paused":
      return { text: "Paused in Mercado Pago. Resume it there to keep your plan.", tone: "warn" };
    case "cancelled":
      return { text: sub.graceUntil ? `Cancelled. Your plan stays active until ${dateTime(sub.graceUntil)}.` : "Cancelled.", tone: "warn" };
  }
}

function PlanRow({ offer, current, billing, onChoose, busy }: { offer: Offer; current: boolean; billing: BillingStatus; onChoose: (offer: Offer) => void; busy: boolean }) {
  const sub = billing.subscription;
  const subscribed = sub && sub.status === "authorized";
  const action = current ? null : offer.purchasable ? (subscribed ? `Switch to ${offer.name}` : `Choose ${offer.name}`) : null;
  return (
    <li className={cx(s.plan, current && s.current)}>
      <div className={s.planName}>
        <h3>{offer.name}</h3>
        <p className={s.dim}>{offer.summary}</p>
      </div>
      <ul role="list" className={s.highlights}>
        {offer.highlights.map((h) => (
          <li key={h}>
            <Check aria-hidden /> {h}
          </li>
        ))}
      </ul>
      <div className={s.price}>
        {offer.price === null || offer.price === 0 ? (
          <span className={s.free}>{offer.id === "free" || offer.price === 0 ? "Free" : "Contact us"}</span>
        ) : (
          <>
            <span className="money">{money(offer.price, offer.currency)}</span>
            <span className={s.per}>a month</span>
          </>
        )}
      </div>
      <div className={s.planAction}>
        {current ? (
          <span className={s.currentLabel}>Your plan</span>
        ) : action && billing.enabled ? (
          <Button variant={offer.id === "creator" && !subscribed ? "primary" : "secondary"} onClick={() => onChoose(offer)} busy={busy}>
            {action}
          </Button>
        ) : null}
      </div>
    </li>
  );
}

export default function Billing() {
  const [params, setParams] = useSearchParams();
  const returning = params.get("checkout") === "done";
  // After returning from Mercado Pago, poll until the webhook lands.
  const [watching, setWatching] = useState(returning);
  const { data: billing, isPending } = useQuery({ ...queries.billing(), refetchInterval: watching ? 4000 : false });
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [switchTo, setSwitchTo] = useState<Offer | null>(null);

  useEffect(() => {
    if (!watching) return;
    const stop = setTimeout(() => setWatching(false), 120_000);
    return () => clearTimeout(stop);
  }, [watching]);
  useEffect(() => {
    if (watching && billing?.subscription?.status === "authorized") {
      setWatching(false);
      toast.success(`You're on ${billing.plan.name}`, "Thanks for subscribing.");
      setParams({}, { replace: true });
      void queryClient.invalidateQueries({ queryKey: keys.me });
    }
  }, [watching, billing, setParams]);

  const checkout = useMutation({
    mutationFn: (plan: "creator" | "pro") => call(api.api.billing.checkout.$post({ json: { plan } })),
    onSuccess: (result) => {
      if (result.url) {
        location.assign(result.url);
        return;
      }
      void queryClient.invalidateQueries({ queryKey: keys.billing });
      void queryClient.invalidateQueries({ queryKey: keys.me });
      toast.success(result.changed ? "Plan changed" : "You're already on that plan");
    },
    onError: (error) => toast.error("Couldn't start checkout", error),
  });

  const cancel = useMutation({
    mutationFn: () => call(api.api.billing.cancel.$post()),
    onSuccess: (status) => {
      queryClient.setQueryData(keys.billing, status);
      toast.info("Renewal cancelled", "Your plan stays active until the end of the period you paid for.");
    },
  });

  if (isPending || !billing) {
    return (
      <div className={cx(p.page, p.narrow)}>
        <Skeleton height={40} width={260} />
        <Skeleton height={320} />
      </div>
    );
  }

  const choose = (offer: Offer) => {
    if (offer.id !== "creator" && offer.id !== "pro") return;
    if (billing.subscription?.status === "authorized") setSwitchTo(offer);
    else checkout.mutate(offer.id);
  };
  const sub = billing.subscription;
  const line = sub ? subscriptionLine(sub) : null;
  const hours = billing.usage.liveSeconds / 3600;
  const limit = billing.usage.liveHoursLimit;
  const emailProblem = checkout.error instanceof ApiError && checkout.error.code === "email_required";

  return (
    <div className={cx(p.page, p.narrow)}>
      <header className={p.header}>
        <div>
          <h1>Plan and billing</h1>
          <p className={p.lede}>Pay monthly through Mercado Pago. Change or cancel any time.</p>
        </div>
      </header>

      {watching && sub?.status !== "authorized" && (
        <Banner title="Confirming your payment">Mercado Pago is confirming the subscription. This page updates on its own, usually within a minute.</Banner>
      )}
      {!billing.enabled && (
        <Banner tone="warn" title="Payments aren't set up on this server">
          Everyone here is on the {billing.plan.name} plan. Plans below are shown for reference.
        </Banner>
      )}
      {emailProblem && (
        <Banner tone="error" title="Add an email address first" action={<ButtonLink to="/app/account" size="sm">Account</ButtonLink>}>
          {errorMessage(checkout.error)}
        </Banner>
      )}

      <Panel raised className={s.summary} aria-labelledby="current-heading">
        <div className={s.summaryMain}>
          <p className={s.dim} id="current-heading">
            Current plan
          </p>
          <p className={s.planTitle}>{billing.plan.name}</p>
          {line && <p className={cx(s.subLine, s[line.tone])}>{line.text}</p>}
          {sub?.amount != null && sub.currency && (
            <p className={s.dim}>
              <span className="money">{money(sub.amount, sub.currency)}</span> a month
            </p>
          )}
        </div>
        <div className={s.usage}>
          <p className={s.dim}>Live this month</p>
          <p className={s.usageValue}>
            {duration(billing.usage.liveSeconds * 1000)}
            {limit !== null && <span className={s.dim}> of {limit} h</span>}
          </p>
          {limit !== null && (
            <div className={s.meter} role="meter" aria-label="Live hours used" aria-valuemin={0} aria-valuemax={limit} aria-valuenow={Math.round(hours * 10) / 10}>
              <span style={{ width: `${Math.min(100, (hours / limit) * 100)}%` }} data-high={hours / limit > 0.85 || undefined} />
            </div>
          )}
          <p className={s.dim}>AI usage so far: about ${billing.usage.estimatedAiCostUsd.toFixed(2)}</p>
        </div>
        {sub && sub.status === "authorized" && billing.enabled && (
          <div className={s.summaryActions}>
            <Button variant="quietDanger" size="sm" onClick={() => setConfirmCancel(true)}>
              Cancel renewal
            </Button>
          </div>
        )}
      </Panel>

      <section aria-labelledby="plans-heading" className={p.section}>
        <h2 id="plans-heading">Plans</h2>
        <ul role="list" className={s.plans}>
          {billing.offers
            .filter((offer) => offer.id !== "self-hosted")
            .map((offer) => (
              <PlanRow key={offer.id} offer={offer} current={offer.id === billing.plan.id} billing={billing} onChoose={choose} busy={checkout.isPending && checkout.variables === offer.id} />
            ))}
        </ul>
        <p className={s.fine}>You'll finish checkout on Mercado Pago's page. Prices include taxes where applicable. Live hours reset on the 1st of each month.</p>
      </section>

      <Confirm
        open={confirmCancel}
        onOpenChange={setConfirmCancel}
        title="Cancel renewal?"
        description={`You keep ${billing.plan.name} until the end of the period you already paid for, then move to Free. Hosts above the Free limits stop going live.`}
        confirmLabel="Cancel renewal"
        danger
        onConfirm={() => cancel.mutateAsync()}
      />
      <Confirm
        open={switchTo !== null}
        onOpenChange={(open) => !open && setSwitchTo(null)}
        title={`Switch to ${switchTo?.name ?? ""}?`}
        description={switchTo?.price ? `Your next payment will be ${money(switchTo.price, switchTo.currency)} a month. The change applies right away.` : ""}
        confirmLabel="Switch plan"
        onConfirm={async () => {
          if (switchTo && (switchTo.id === "creator" || switchTo.id === "pro")) await checkout.mutateAsync(switchTo.id);
        }}
      />
    </div>
  );
}
