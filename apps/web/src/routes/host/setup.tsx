import { broadcastUpdateSchema, tiktokHandleSchema } from "@tik-live/shared";
import { RefreshCw } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { api, call, errorMessage } from "../../lib/api";
import { useConfig, useMe, useRotateStageKey, useUpdateBroadcast, useUpdateChannel } from "../../lib/query";
import { useStudio } from "../../lib/studio";
import { Button, ButtonLink } from "../../ui/Button";
import { Banner, CopyField, Panel } from "../../ui/Display";
import { Field, Input, PrefixedInput, Segmented, Switch } from "../../ui/Field";
import { Confirm } from "../../ui/Overlay";
import { toast } from "../../ui/toast-store";
import p from "../page.module.css";
import { useHost } from "./context";
import s from "./setup.module.css";

function Source() {
  const { channel } = useHost();
  const update = useUpdateChannel(channel.id);
  const [source, setSource] = useState(channel.source);
  const [handle, setHandle] = useState(channel.tiktokUsername ?? "");
  const [error, setError] = useState<string | null>(null);
  const dirty = source !== channel.source || (handle.replace(/^@/, "") || null) !== channel.tiktokUsername;

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    let tiktokUsername: string | null = null;
    if (handle.trim()) {
      const parsed = tiktokHandleSchema.safeParse(handle);
      if (!parsed.success) return setError("That doesn't look like a TikTok handle. Use letters, numbers, dots and underscores.");
      tiktokUsername = parsed.data;
    }
    if (source === "tiktok" && !tiktokUsername) return setError("Add the TikTok handle this host should listen to.");
    try {
      await update.mutateAsync({ source, tiktokUsername });
      toast.success("Saved", channel.runtime.status === "stopped" ? undefined : "The host reconnects with the new settings.");
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <Panel as="section" aria-labelledby="source-heading" className={p.form}>
      <div className={p.sectionHead}>
        <h2 id="source-heading">Where {channel.name} listens</h2>
        <p>The chat, gifts and follows your host reacts to.</p>
      </div>
      <form className={s.form} onSubmit={save} noValidate>
        <Segmented
          label="Source"
          value={source}
          onChange={setSource}
          options={[
            { value: "tiktok", label: "My TikTok LIVE" },
            { value: "simulator", label: "Practice viewers" },
          ]}
        />
        {source === "tiktok" ? (
          <Field label="TikTok handle" hint="Go live on this account from TikTok LIVE Studio or OBS. The host starts when TikTok reports the stream is live." error={error}>
            {(props) => <PrefixedInput {...props} prefix="@" value={handle.replace(/^@/, "")} onChange={(e) => setHandle(e.target.value)} spellCheck={false} autoComplete="off" />}
          </Field>
        ) : (
          <p className={s.note}>Simulated viewers chat, ask questions and send gifts so you can watch the host work. Nothing reaches TikTok.</p>
        )}
        {error && source !== "tiktok" && <p className={s.error}>{error}</p>}
        <div className={p.formActions}>
          <Button type="submit" variant="primary" disabled={!dirty} busy={update.isPending}>
            Save
          </Button>
        </div>
      </form>
    </Panel>
  );
}

function StageLink() {
  const { channel, store } = useHost();
  const rotate = useRotateStageKey(channel.id);
  const [confirm, setConfirm] = useState(false);
  const program = useStudio(store, (st) => st.snapshot?.health.stages.program ?? 0);
  return (
    <Panel as="section" aria-labelledby="obs-heading" className={p.form}>
      <div className={p.sectionHead}>
        <h2 id="obs-heading">Put {channel.name} on your stream</h2>
        <p>Your host appears in OBS as a browser source. The voice plays through it too.</p>
      </div>
      <Field label="Stage link" hint="Anyone with this link can see the stage, so keep it to yourself.">
        {(props) => <CopyField {...props} value={channel.stageUrl} label="Stage link" />}
      </Field>
      <ol className={s.steps}>
        <li>
          In OBS, add a <strong>Browser</strong> source to your TikTok scene.
        </li>
        <li>
          Paste the stage link as the URL. Set width to <strong>1080</strong> and height to <strong>1920</strong>.
        </li>
        <li>
          Tick <strong>Control audio via OBS</strong> so the voice goes into your stream.
        </li>
        <li>Start your TikTok LIVE as usual. Press Go live here, and the host takes it from there.</li>
      </ol>
      <div className={s.status} data-ok={program > 0}>
        <span className={s.statusDot} aria-hidden />
        {program > 0 ? (program === 1 ? "OBS is showing the stage" : `${program} OBS sources are showing the stage`) : "Waiting for OBS to open the stage link"}
      </div>
      <div className={p.formActions}>
        <Button variant="quietDanger" size="sm" icon={<RefreshCw aria-hidden />} onClick={() => setConfirm(true)}>
          Replace the link
        </Button>
        <span className={s.note}>If the link leaked. The old one stops working at once.</span>
      </div>
      <Confirm
        open={confirm}
        onOpenChange={setConfirm}
        title="Replace the stage link?"
        description="OBS sources using the old link go blank until you paste the new one."
        confirmLabel="Replace link"
        danger
        onConfirm={async () => {
          await rotate.mutateAsync();
          toast.success("New stage link ready", "Paste it into your OBS browser source.");
        }}
      />
    </Panel>
  );
}

function CloudBroadcast() {
  const { channel } = useHost();
  const { data: me } = useMe();
  const { data: config } = useConfig();
  const update = useUpdateBroadcast(channel.id);
  const [rtmpUrl, setRtmpUrl] = useState(channel.broadcast.rtmpUrl ?? "");
  const [streamKey, setStreamKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const { store } = useHost();
  const live = useStudio(store, (st) => st.snapshot?.health.broadcast ?? null);
  const allowed = me?.plan.limits.cloudBroadcast ?? false;
  const [checked, setChecked] = useState<{ ok: boolean; detail: string } | null>(null);
  const check = useMutation({
    mutationFn: (url: string) => call(api.api.channels[":id"].broadcast.check.$post({ param: { id: channel.id }, json: { rtmpUrl: url } })),
    onSuccess: (result) => setChecked(result),
    onError: (err) => setChecked({ ok: false, detail: errorMessage(err) }),
  });
  const available = config?.broadcast.enabled ?? false;

  const save = async (patch: { enabled?: boolean }) => {
    setError(null);
    const input = {
      ...patch,
      ...(rtmpUrl.trim() !== (channel.broadcast.rtmpUrl ?? "") ? { rtmpUrl: rtmpUrl.trim() || null } : {}),
      ...(streamKey.trim() ? { streamKey: streamKey.trim() } : {}),
    };
    const parsed = broadcastUpdateSchema.safeParse(input);
    if (!parsed.success) return setError(parsed.error.issues[0]?.message ?? "Check the server URL and stream key.");
    try {
      await update.mutateAsync(parsed.data);
      setStreamKey("");
      toast.success(patch.enabled === undefined ? "Saved" : patch.enabled ? "Cloud broadcast on" : "Cloud broadcast off");
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <Panel as="section" aria-labelledby="cloud-heading" className={p.form}>
      <div className={p.sectionHead}>
        <h2 id="cloud-heading">Broadcast from the cloud</h2>
        <p>Lantern streams the stage straight to TikTok, so you don't need OBS or a computer running.</p>
      </div>
      {!allowed ? (
        <Banner title="Part of the Pro plan" action={<ButtonLink to="/app/billing" size="sm">See plans</ButtonLink>}>
          Run your host around the clock without a PC.
        </Banner>
      ) : !available ? (
        <Banner tone="warn" title="Not available on this server yet">
          Cloud broadcast needs the broadcaster service. Use OBS for now.
        </Banner>
      ) : (
        <form
          className={s.form}
          onSubmit={(e) => {
            e.preventDefault();
            void save({});
          }}
          noValidate
        >
          <Switch label="Broadcast this host from the cloud" hint="Starts with the host and stops with it." checked={channel.broadcast.enabled} onChange={(enabled) => void save({ enabled })} disabled={update.isPending} />
          {live && (
            <p className={s.status} data-ok={live.state === "live"}>
              <span className={s.statusDot} aria-hidden />
              {live.state === "live" ? "Streaming to TikTok now" : live.detail}
            </p>
          )}
          <div className={p.formRow}>
            <Field label="Server URL" hint="From TikTok LIVE Studio or your stream key page. Starts with rtmp:// or rtmps://.">
              {(props) => <Input {...props} value={rtmpUrl} onChange={(e) => setRtmpUrl(e.target.value)} placeholder="rtmps://…" spellCheck={false} autoComplete="off" />}
            </Field>
            <Field label="Stream key" hint={channel.broadcast.hasStreamKey ? `Saved, ends in ${channel.broadcast.streamKeyLast4}. Type a new one to replace it.` : "Stored encrypted. It's never shown again."}>
              {(props) => <Input {...props} type="password" value={streamKey} onChange={(e) => setStreamKey(e.target.value)} placeholder={channel.broadcast.hasStreamKey ? "••••••••" : ""} autoComplete="new-password" />}
            </Field>
          </div>
          {error && <p className={s.error}>{error}</p>}
          {checked && (
            <p className={s.status} data-ok={checked.ok} role="status">
              <span className={s.statusDot} aria-hidden />
              {checked.detail}
            </p>
          )}
          <div className={p.formActions}>
            <Button type="submit" busy={update.isPending}>
              Save broadcast settings
            </Button>
            <Button variant="ghost" busy={check.isPending} disabled={!rtmpUrl.trim()} onClick={() => check.mutate(rtmpUrl.trim())}>
              Check connection
            </Button>
          </div>
        </form>
      )}
    </Panel>
  );
}

export default function Setup() {
  return (
    <div className={s.layout}>
      <Source />
      <StageLink />
      <CloudBroadcast />
    </div>
  );
}
