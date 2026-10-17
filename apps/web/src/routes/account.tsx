import { PRODUCT_NAME } from "@tik-live/shared";
import { useMutation } from "@tanstack/react-query";
import { lazy, Suspense, useState, type FormEvent } from "react";
import { api, call, errorMessage } from "../lib/api";
import { dateTime } from "../lib/format";
import { useMe } from "../lib/query";
import { Button, ButtonLink } from "../ui/Button";
import { Banner, Panel, Skeleton } from "../ui/Display";
import { Field, Input } from "../ui/Field";
import { Confirm } from "../ui/Overlay";
import { cx } from "../ui/cx";
import p from "./page.module.css";
import s from "./account.module.css";

function DevUserSwitcher({ current }: { current: string }) {
  const [name, setName] = useState(current);
  const [error, setError] = useState<string | null>(null);
  const switchUser = useMutation({
    mutationFn: (next: string) => call(api.api.me["dev-user"].$post({ json: { name: next } })),
    onSuccess: () => location.assign("/app"),
    onError: (err) => setError(errorMessage(err)),
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(name.trim().toLowerCase())) return setError("Use letras minúsculas, números e hífens.");
    switchUser.mutate(name.trim().toLowerCase());
  };
  return (
    <Panel as="section" className={p.form} aria-labelledby="dev-heading">
      <div className={p.sectionHead}>
        <h2 id="dev-heading">Usuários de teste</h2>
        <p>Este servidor ainda não tem login de verdade, então usa usuários de teste. Troque para ver o {PRODUCT_NAME} como outra pessoa; cada usuário de teste tem seus próprios apresentadores e plano.</p>
      </div>
      <form className={s.inline} onSubmit={submit}>
        <Field label="Usuário de teste" error={error}>
          {(props) => <Input {...props} value={name} onChange={(e) => setName(e.target.value)} maxLength={32} spellCheck={false} autoComplete="off" />}
        </Field>
        <Button type="submit" busy={switchUser.isPending} disabled={name.trim().toLowerCase() === current}>
          Trocar usuário
        </Button>
      </form>
    </Panel>
  );
}

const ClerkSignOutButton = lazy(() =>
  import("../auth/clerk").then((m) => ({
    default: function ClerkSignOutButton() {
      const signOut = m.useClerkSignOut();
      return <Button onClick={() => void signOut()}>Sair</Button>;
    },
  })),
);

function SignOut({ mode }: { mode: "dev" | "clerk" | "workos" }) {
  if (mode === "workos") return <ButtonLink to="/auth/sign-out" reloadDocument>Sair</ButtonLink>;
  if (mode === "clerk")
    return (
      <Suspense fallback={null}>
        <ClerkSignOutButton />
      </Suspense>
    );
  return null;
}

export default function Account() {
  const { data: me } = useMe();
  const [confirm, setConfirm] = useState(false);
  const remove = useMutation({ mutationFn: () => call(api.api.me.$delete()) });

  if (!me) return <div className={p.page}><Skeleton height={200} /></div>;

  return (
    <div className={cx(p.page, p.narrow)}>
      <header className={p.header}>
        <h1>Conta</h1>
      </header>

      {me.authMode === "dev" && (
        <Banner tone="warn" title="Login de desenvolvimento">
          Qualquer pessoa que abrir este servidor pode usá-lo. Mantenha a senha de homologação até o login de verdade estar configurado.
        </Banner>
      )}

      <Panel as="section" className={p.form} aria-labelledby="profile-heading">
        <h2 id="profile-heading">Perfil</h2>
        <dl className={s.facts}>
          <div>
            <dt>Nome</dt>
            <dd>{me.user.name ?? "Não informado"}</dd>
          </div>
          <div>
            <dt>E-mail</dt>
            <dd>{me.user.email ?? "Não informado"}</dd>
          </div>
          <div>
            <dt>Plano</dt>
            <dd>{me.plan.name}</dd>
          </div>
          <div>
            <dt>Membro desde</dt>
            <dd>{dateTime(me.user.createdAt)}</dd>
          </div>
        </dl>
        {me.authMode !== "dev" && (
          <div className={s.inline}>
            <p className={s.dim}>Seu nome, e-mail e senha são gerenciados pelo serviço de login.</p>
            <SignOut mode={me.authMode} />
          </div>
        )}
      </Panel>

      {me.devUser && <DevUserSwitcher current={me.devUser} />}

      <Panel as="section" className={cx(p.form, s.danger)} aria-labelledby="delete-heading">
        <div className={p.sectionHead}>
          <h2 id="delete-heading">Excluir sua conta</h2>
          <p>Para e exclui todos os seus apresentadores, com memórias, transcrições e histórico de lives. Antes, cancele qualquer plano pago em Plano e assinatura.</p>
        </div>
        <div>
          <Button variant="quietDanger" onClick={() => setConfirm(true)}>
            Excluir conta
          </Button>
        </div>
      </Panel>

      <Confirm
        open={confirm}
        onOpenChange={setConfirm}
        title="Excluir sua conta?"
        description="Tudo é excluído na hora e não dá para recuperar."
        confirmLabel="Excluir conta"
        danger
        onConfirm={async () => {
          await remove.mutateAsync();
          location.assign("/");
        }}
      />
    </div>
  );
}
