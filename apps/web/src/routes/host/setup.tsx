import { broadcastUpdateSchema, PLANS, PRODUCT_NAME, tiktokHandleSchema } from "@tik-live/shared";
import { Download, RefreshCw } from "lucide-react";
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
      if (!parsed.success) return setError("Isso não parece um usuário do TikTok. Use letras, números, pontos e sublinhados.");
      tiktokUsername = parsed.data;
    }
    if (source === "tiktok" && !tiktokUsername) return setError("Adicione o usuário do TikTok que este apresentador deve escutar.");
    try {
      await update.mutateAsync({ source, tiktokUsername });
      toast.success("Salvo", channel.runtime.status === "stopped" ? undefined : "O apresentador reconecta com as novas configurações.");
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <Panel as="section" aria-labelledby="source-heading" className={p.form}>
      <div className={p.sectionHead}>
        <h2 id="source-heading">Onde {channel.name} escuta</h2>
        <p>O chat, os presentes e os novos seguidores aos quais o apresentador reage.</p>
      </div>
      <form className={s.form} onSubmit={save} noValidate>
        <Segmented
          label="Origem"
          value={source}
          onChange={setSource}
          options={[
            { value: "tiktok", label: "Minha TikTok LIVE" },
            { value: "simulator", label: "Plateia simulada" },
          ]}
        />
        {source === "tiktok" ? (
          <Field label="Usuário do TikTok" hint="Faça a live nessa conta pelo TikTok LIVE Studio ou pelo OBS. O apresentador começa quando o TikTok avisar que a live começou." error={error}>
            {(props) => <PrefixedInput {...props} prefix="@" value={handle.replace(/^@/, "")} onChange={(e) => setHandle(e.target.value)} spellCheck={false} autoComplete="off" />}
          </Field>
        ) : (
          <p className={s.note}>A plateia simulada conversa, faz perguntas e manda presentes para você ver o apresentador em ação. Nada chega ao TikTok.</p>
        )}
        {error && source !== "tiktok" && <p className={s.error}>{error}</p>}
        <div className={p.formActions}>
          <Button type="submit" variant="primary" disabled={!dirty} busy={update.isPending}>
            Salvar
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
        <h2 id="obs-heading">Coloque {channel.name} na sua live</h2>
        <p>O apresentador aparece no OBS como uma fonte de Navegador. A voz também sai por ela.</p>
      </div>
      <Field label="Link do palco" hint="Quem tiver este link vê o palco, então não compartilhe.">
        {(props) => <CopyField {...props} value={channel.stageUrl} label="Link do palco" />}
      </Field>
      <ol className={s.steps}>
        <li>
          No OBS, adicione uma fonte de <strong>Navegador</strong> à sua cena do TikTok.
        </li>
        <li>
          Cole o link do palco como URL. Use largura <strong>1080</strong> e altura <strong>1920</strong>.
        </li>
        <li>
          Marque <strong>Controlar áudio via OBS</strong> para a voz entrar na sua live.
        </li>
        <li>Comece sua TikTok LIVE como sempre. Aperte Entrar ao vivo aqui e o apresentador assume dali.</li>
      </ol>
      <div className={s.status} data-ok={program > 0}>
        <span className={s.statusDot} aria-hidden />
        {program > 0 ? (program === 1 ? "O OBS está mostrando o palco" : `${program} fontes no OBS estão mostrando o palco`) : "Aguardando o OBS abrir o link do palco"}
      </div>
      <div className={p.formActions}>
        <Button variant="quietDanger" size="sm" icon={<RefreshCw aria-hidden />} onClick={() => setConfirm(true)}>
          Trocar o link
        </Button>
        <span className={s.note}>Se o link vazou. O antigo para de funcionar na hora.</span>
      </div>
      <Confirm
        open={confirm}
        onOpenChange={setConfirm}
        title="Trocar o link do palco?"
        description="As fontes do OBS com o link antigo ficam em branco até você colar o novo."
        confirmLabel="Trocar link"
        danger
        onConfirm={async () => {
          await rotate.mutateAsync();
          toast.success("Novo link do palco pronto", "Cole na sua fonte de Navegador do OBS.");
        }}
      />
    </Panel>
  );
}

function TikTokLiveStudio() {
  const { channel, store } = useHost();
  const update = useUpdateBroadcast(channel.id);
  const liveStudio = useStudio(store, (st) => st.snapshot?.health.liveStudio ?? null);
  const [checked, setChecked] = useState<{
    ok: boolean;
    detail: string;
    connected?: boolean;
    installed?: boolean;
    bridgeConnected?: boolean;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const check = useMutation({
    mutationFn: (launch: boolean) => call(api.api.channels[":id"]["live-studio"].check.$post({ param: { id: channel.id }, json: { launch } })),
    onSuccess: (result) => setChecked(result),
    onError: (err) => setChecked({ ok: false, detail: errorMessage(err) }),
  });

  const toggle = async (enabled: boolean) => {
    setError(null);
    try {
      await update.mutateAsync({ liveStudio: enabled });
      toast.success(enabled ? "TikTok LIVE Studio automático ligado" : "TikTok LIVE Studio automático desligado");
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const bridgeConnected = checked?.bridgeConnected ?? liveStudio?.bridgeConnected ?? false;

  return (
    <Panel as="section" aria-labelledby="live-studio-heading" className={p.form}>
      <div className={p.sectionHead}>
        <h2 id="live-studio-heading">TikTok LIVE Studio automático</h2>
        <p>O agente local do {PRODUCT_NAME} roda no seu PC e comanda o aplicativo do TikTok LIVE Studio para iniciar e encerrar a live automaticamente junto com o apresentador.</p>
      </div>
      <div className={s.form}>
        <Switch
          label="Iniciar e encerrar a live no TikTok LIVE Studio"
          hint="Usa a cena, o título e as configurações que já estão prontos no seu TikTok LIVE Studio."
          checked={Boolean(channel.broadcast.liveStudio)}
          onChange={(enabled) => void toggle(enabled)}
          disabled={update.isPending}
        />
        <Field label="Comando do agente local (Windows)" hint="Baixe o lantern-bridge.exe para o seu PC e abra-o colando o link do palco, ou rode este comando no terminal.">
          {(props) => <CopyField {...props} value={`lantern-bridge.exe --url ${channel.stageUrl}`} label="Comando do agente local" />}
        </Field>
        {liveStudio && (
          <p className={s.status} data-ok={liveStudio.state === "live" || Boolean(liveStudio.bridgeConnected)}>
            <span className={s.statusDot} aria-hidden />
            {liveStudio.detail}
          </p>
        )}
        {error && <p className={s.error}>{error}</p>}
        {checked && (
          <p className={s.status} data-ok={checked.ok} role="status">
            <span className={s.statusDot} aria-hidden />
            {checked.detail}
          </p>
        )}
        <div className={p.formActions}>
          <Button variant="ghost" busy={check.isPending} onClick={() => check.mutate(false)}>
            {bridgeConnected ? "Testar agente no PC" : "Testar conexão"}
          </Button>
          {checked && !checked.connected && checked.installed && (
            <Button variant="ghost" busy={check.isPending} onClick={() => check.mutate(true)}>
              Abrir TikTok LIVE Studio
            </Button>
          )}
          <a href={`/api/channels/${channel.id}/live-studio/bridge.exe`} download="lantern-bridge.exe">
            <Button type="button" variant="ghost" icon={<Download aria-hidden />}>
              Baixar lantern-bridge.exe
            </Button>
          </a>
        </div>
      </div>
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
    if (!parsed.success) return setError(parsed.error.issues[0]?.message ?? "Confira o URL do servidor e a chave de transmissão.");
    try {
      await update.mutateAsync(parsed.data);
      setStreamKey("");
      toast.success(patch.enabled === undefined ? "Salvo" : patch.enabled ? "Transmissão pela nuvem ligada" : "Transmissão pela nuvem desligada");
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <Panel as="section" aria-labelledby="cloud-heading" className={p.form}>
      <div className={p.sectionHead}>
        <h2 id="cloud-heading">Transmitir pela nuvem</h2>
        <p>O {PRODUCT_NAME} transmite o palco direto para o TikTok, sem precisar do OBS nem de um computador ligado.</p>
      </div>
      {!allowed ? (
        <Banner title={`Faz parte do plano ${PLANS.pro.name}`} action={<ButtonLink to="/app/billing" size="sm">Ver planos</ButtonLink>}>
          Deixe seu apresentador no ar 24 horas por dia, sem computador.
        </Banner>
      ) : !available ? (
        <Banner tone="warn" title="Ainda não disponível neste servidor">
          A transmissão pela nuvem precisa do serviço de transmissão. Por enquanto, use o OBS.
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
          <Switch label="Transmitir este apresentador pela nuvem" hint="Começa e para junto com o apresentador." checked={channel.broadcast.enabled} onChange={(enabled) => void save({ enabled })} disabled={update.isPending} />
          {live && (
            <p className={s.status} data-ok={live.state === "live"}>
              <span className={s.statusDot} aria-hidden />
              {live.state === "live" ? "Transmitindo para o TikTok agora" : live.detail}
            </p>
          )}
          <div className={p.formRow}>
            <Field label="URL do servidor" hint="Fica no TikTok LIVE Studio ou na página da sua chave de transmissão. Começa com rtmp:// ou rtmps://.">
              {(props) => <Input {...props} value={rtmpUrl} onChange={(e) => setRtmpUrl(e.target.value)} placeholder="rtmps://…" spellCheck={false} autoComplete="off" />}
            </Field>
            <Field label="Chave de transmissão" hint={channel.broadcast.hasStreamKey ? `Salva, termina em ${channel.broadcast.streamKeyLast4}. Digite uma nova para substituir.` : "Guardada com criptografia. Ela não aparece de novo."}>
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
              Salvar transmissão
            </Button>
            <Button variant="ghost" busy={check.isPending} disabled={!rtmpUrl.trim()} onClick={() => check.mutate(rtmpUrl.trim())}>
              Testar conexão
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
      <TikTokLiveStudio />
      <CloudBroadcast />
    </div>
  );
}
