import { PLANS } from "@tik-live/shared";
import { Check } from "lucide-react";
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api, ApiError, call, errorMessage } from "../lib/api";
import { dateTime, duration, money, usd } from "../lib/format";
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
      if (sub.lastPaymentStatus === "rejected" && sub.graceUntil) return { text: `O último pagamento não passou. O Mercado Pago vai tentar de novo; seu plano continua ativo até ${dateTime(sub.graceUntil)}.`, tone: "bad" };
      return { text: next ? `Renova em ${next}` : "Ativo", tone: "ok" };
    case "pending":
      return { text: "Aguardando o Mercado Pago confirmar seu pagamento.", tone: "warn" };
    case "paused":
      return { text: "Pausada no Mercado Pago. Retome por lá para manter seu plano.", tone: "warn" };
    case "cancelled":
      return { text: sub.graceUntil ? `Cancelada. Seu plano continua ativo até ${dateTime(sub.graceUntil)}.` : "Cancelada.", tone: "warn" };
  }
}

function PlanRow({ offer, current, billing, onChoose, busy }: { offer: Offer; current: boolean; billing: BillingStatus; onChoose: (offer: Offer) => void; busy: boolean }) {
  const sub = billing.subscription;
  const subscribed = sub && sub.status === "authorized";
  const action = current ? null : offer.purchasable ? (subscribed ? `Mudar para ${offer.name}` : `Escolher ${offer.name}`) : null;
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
          <span className={s.free}>{offer.id === "free" || offer.price === 0 ? "Grátis" : "Fale com a gente"}</span>
        ) : (
          <>
            <span className="money">{money(offer.price, offer.currency)}</span>
            <span className={s.per}>por mês</span>
          </>
        )}
      </div>
      <div className={s.planAction}>
        {current ? (
          <span className={s.currentLabel}>Seu plano</span>
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
      toast.success(`Agora você está no ${billing.plan.name}`, "Obrigado por assinar.");
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
      toast.success(result.changed ? "Plano alterado" : "Você já está nesse plano");
    },
    onError: (error) => toast.error("Não deu para abrir o pagamento", error),
  });

  const cancel = useMutation({
    mutationFn: () => call(api.api.billing.cancel.$post()),
    onSuccess: (status) => {
      queryClient.setQueryData(keys.billing, status);
      toast.info("Renovação cancelada", "Seu plano continua ativo até o fim do período pago.");
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
          <h1>Plano e assinatura</h1>
          <p className={p.lede}>Pagamento mensal pelo Mercado Pago. Mude ou cancele quando quiser.</p>
        </div>
      </header>

      {watching && sub?.status !== "authorized" && (
        <Banner title="Confirmando seu pagamento">O Mercado Pago está confirmando a assinatura. Esta página se atualiza sozinha, em geral em até um minuto.</Banner>
      )}
      {!billing.enabled && (
        <Banner tone="warn" title="Os pagamentos não estão configurados neste servidor">
          Todo mundo aqui está no plano {billing.plan.name}. Os planos abaixo são só para referência.
        </Banner>
      )}
      {emailProblem && (
        <Banner tone="error" title="Adicione um e-mail primeiro" action={<ButtonLink to="/app/account" size="sm">Conta</ButtonLink>}>
          {errorMessage(checkout.error)}
        </Banner>
      )}

      <Panel raised className={s.summary} aria-labelledby="current-heading">
        <div className={s.summaryMain}>
          <p className={s.dim} id="current-heading">
            Plano atual
          </p>
          <p className={s.planTitle}>{billing.plan.name}</p>
          {line && <p className={cx(s.subLine, s[line.tone])}>{line.text}</p>}
          {sub?.amount != null && sub.currency && (
            <p className={s.dim}>
              <span className="money">{money(sub.amount, sub.currency)}</span> por mês
            </p>
          )}
        </div>
        <div className={s.usage}>
          <p className={s.dim}>Ao vivo neste mês</p>
          <p className={s.usageValue}>
            {duration(billing.usage.liveSeconds * 1000)}
            {limit !== null && <span className={s.dim}> de {limit} h</span>}
          </p>
          {limit !== null && (
            <div className={s.meter} role="meter" aria-label="Horas ao vivo usadas" aria-valuemin={0} aria-valuemax={limit} aria-valuenow={Math.round(hours * 10) / 10}>
              <span style={{ width: `${Math.min(100, (hours / limit) * 100)}%` }} data-high={hours / limit > 0.85 || undefined} />
            </div>
          )}
          <p className={s.dim}>Uso de IA até agora: cerca de {usd(Math.round(billing.usage.estimatedAiCostUsd * 100) / 100)}</p>
        </div>
        {sub && sub.status === "authorized" && billing.enabled && (
          <div className={s.summaryActions}>
            <Button variant="quietDanger" size="sm" onClick={() => setConfirmCancel(true)}>
              Cancelar renovação
            </Button>
          </div>
        )}
      </Panel>

      <section aria-labelledby="plans-heading" className={p.section}>
        <h2 id="plans-heading">Planos</h2>
        <ul role="list" className={s.plans}>
          {billing.offers
            .filter((offer) => offer.id !== "self-hosted")
            .map((offer) => (
              <PlanRow key={offer.id} offer={offer} current={offer.id === billing.plan.id} billing={billing} onChoose={choose} busy={checkout.isPending && checkout.variables === offer.id} />
            ))}
        </ul>
        <p className={s.fine}>Você conclui o pagamento na página do Mercado Pago. Os preços incluem impostos, quando aplicáveis. As horas ao vivo zeram no dia 1º de cada mês.</p>
      </section>

      <Confirm
        open={confirmCancel}
        onOpenChange={setConfirmCancel}
        title="Cancelar renovação?"
        description={`Você continua no ${billing.plan.name} até o fim do período já pago e depois passa para o ${PLANS.free.name}. Apresentadores acima dos limites do ${PLANS.free.name} deixam de entrar ao vivo.`}
        confirmLabel="Cancelar renovação"
        danger
        onConfirm={() => cancel.mutateAsync()}
      />
      <Confirm
        open={switchTo !== null}
        onOpenChange={(open) => !open && setSwitchTo(null)}
        title={`Mudar para ${switchTo?.name ?? ""}?`}
        description={switchTo?.price ? `Seu próximo pagamento será de ${money(switchTo.price, switchTo.currency)} por mês. A mudança vale na hora.` : ""}
        confirmLabel="Mudar de plano"
        onConfirm={async () => {
          if (switchTo && (switchTo.id === "creator" || switchTo.id === "pro")) await checkout.mutateAsync(switchTo.id);
        }}
      />
    </div>
  );
}
