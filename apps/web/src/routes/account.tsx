import { useMutation } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { api, call, errorMessage } from "../lib/api";
import { dateTime } from "../lib/format";
import { useMe } from "../lib/query";
import { Button } from "../ui/Button";
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
    if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(name.trim().toLowerCase())) return setError("Use lowercase letters, numbers and dashes.");
    switchUser.mutate(name.trim().toLowerCase());
  };
  return (
    <Panel as="section" className={p.form} aria-labelledby="dev-heading">
      <div className={p.sectionHead}>
        <h2 id="dev-heading">Test users</h2>
        <p>Sign-in isn't turned on yet, so this server runs with test users. Switch to see Lantern as someone else; each test user has their own hosts and plan.</p>
      </div>
      <form className={s.inline} onSubmit={submit}>
        <Field label="Test user" error={error}>
          {(props) => <Input {...props} value={name} onChange={(e) => setName(e.target.value)} maxLength={32} spellCheck={false} autoComplete="off" />}
        </Field>
        <Button type="submit" busy={switchUser.isPending} disabled={name.trim().toLowerCase() === current}>
          Switch user
        </Button>
      </form>
    </Panel>
  );
}

export default function Account() {
  const { data: me } = useMe();
  const [confirm, setConfirm] = useState(false);
  const remove = useMutation({ mutationFn: () => call(api.api.me.$delete()) });

  if (!me) return <div className={p.page}><Skeleton height={200} /></div>;

  return (
    <div className={cx(p.page, p.narrow)}>
      <header className={p.header}>
        <h1>Account</h1>
      </header>

      {me.authMode === "dev" && (
        <Banner tone="warn" title="Development sign-in">
          Anyone who can open this server can use it. Keep it behind the staging password until real sign-in is set up.
        </Banner>
      )}

      <Panel as="section" className={p.form} aria-labelledby="profile-heading">
        <h2 id="profile-heading">Profile</h2>
        <dl className={s.facts}>
          <div>
            <dt>Name</dt>
            <dd>{me.user.name ?? "Not set"}</dd>
          </div>
          <div>
            <dt>Email</dt>
            <dd>{me.user.email ?? "Not set"}</dd>
          </div>
          <div>
            <dt>Plan</dt>
            <dd>{me.plan.name}</dd>
          </div>
          <div>
            <dt>Member since</dt>
            <dd>{dateTime(me.user.createdAt)}</dd>
          </div>
        </dl>
        {me.authMode !== "dev" && <p className={s.dim}>Change your name, email and password from the sign-in menu.</p>}
      </Panel>

      {me.devUser && <DevUserSwitcher current={me.devUser} />}

      <Panel as="section" className={cx(p.form, s.danger)} aria-labelledby="delete-heading">
        <div className={p.sectionHead}>
          <h2 id="delete-heading">Delete your account</h2>
          <p>Stops every host and deletes them, with their memories, transcripts and stream history. Cancel any paid plan first in Plan and billing.</p>
        </div>
        <div>
          <Button variant="quietDanger" onClick={() => setConfirm(true)}>
            Delete account
          </Button>
        </div>
      </Panel>

      <Confirm
        open={confirm}
        onOpenChange={setConfirm}
        title="Delete your account?"
        description="Everything is deleted right away and can't be recovered."
        confirmLabel="Delete account"
        danger
        onConfirm={async () => {
          await remove.mutateAsync();
          location.assign("/");
        }}
      />
    </div>
  );
}
