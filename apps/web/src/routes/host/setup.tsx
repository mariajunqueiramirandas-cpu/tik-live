import {
  broadcastUpdateSchema,
  DEFAULT_STREAM_SCHEDULE,
  evaluateStreamSchedule,
  formatPairingCode,
  PLANS,
  PRODUCT_NAME,
  streamScheduleSchema,
  tiktokHandleSchema,
  type LiveStudioActionRequest,
  type LiveStudioProbe,
  type StreamSchedule,
} from "@tik-live/shared";
import { CalendarClock, Download, Film, KeyRound, RefreshCw, Sparkles, Trash2, Video, Wand2 } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, call, errorMessage } from "../../lib/api";
import { ago, time } from "../../lib/format";
import { keys, putChannel, useBridgeDevices, useConfig, useMe, useRotateStageKey, useUpdateBroadcast, useUpdateChannel } from "../../lib/query";
import { useStudio } from "../../lib/studio";
import { browserTimeZone, timeZoneLabel, timeZoneOptions } from "../../lib/timezone";
import { Button, ButtonLink } from "../../ui/Button";
import { Banner, CopyField, Panel } from "../../ui/Display";
import { Field, Input, PrefixedInput, Segmented, Select, Switch } from "../../ui/Field";
import { Confirm } from "../../ui/Overlay";
import { toast } from "../../ui/toast-store";
import p from "../page.module.css";
import { useHost } from "./context";
import s from "./setup.module.css";

const WEEKDAYS = [
  { day: 0, short: "Dom", full: "Domingo" },
  { day: 1, short: "Seg", full: "Segunda" },
  { day: 2, short: "Ter", full: "Terça" },
  { day: 3, short: "Qua", full: "Quarta" },
  { day: 4, short: "Qui", full: "Quinta" },
  { day: 5, short: "Sex", full: "Sexta" },
  { day: 6, short: "Sáb", full: "Sábado" },
] as const;

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

function ScheduledStreamHours() {
  const { channel } = useHost();
  const update = useUpdateBroadcast(channel.id);
  const browserTz = useMemo(() => browserTimeZone(), []);
  const saved = channel.broadcast.schedule ?? DEFAULT_STREAM_SCHEDULE;
  const defaultTz = saved.timezone ?? channel.persona.timezone ?? browserTz ?? "America/Sao_Paulo";

  const [enabled, setEnabled] = useState(saved.enabled);
  const [startTime, setStartTime] = useState(saved.startTime);
  const [endTime, setEndTime] = useState(saved.endTime);
  const [days, setDays] = useState<number[]>(saved.days);
  const [timezone, setTimezone] = useState<string>(defaultTz);
  const [error, setError] = useState<string | null>(null);

  const zones = useMemo(() => {
    const now = new Date();
    return timeZoneOptions([timezone, channel.persona.timezone, browserTz]).map((z) => ({
      zone: z,
      label: timeZoneLabel(z, now),
    }));
  }, [timezone, channel.persona.timezone, browserTz]);

  const draftSchedule: StreamSchedule = {
    enabled,
    startTime,
    endTime,
    days,
    ...(timezone ? { timezone } : {}),
  };

  const evalStatus = evaluateStreamSchedule(draftSchedule, new Date(), channel.persona.timezone);
  const crossesMidnight = startTime > endTime;

  const toggleDay = (day: number) => {
    setDays((prev) => (prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day].sort((a, b) => a - b)));
  };

  const persistSchedule = async (next: StreamSchedule) => {
    setError(null);
    const parsed = streamScheduleSchema.safeParse(next);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Confira os horários e dias selecionados.");
      return;
    }
    try {
      await update.mutateAsync({ schedule: parsed.data });
      toast.success(
        parsed.data.enabled
          ? `Horário agendado salvo (${parsed.data.startTime} às ${parsed.data.endTime})`
          : "Agendamento automático de horário desligado",
      );
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <Panel as="section" aria-labelledby="schedule-heading" className={p.form}>
      <div className={p.sectionHead}>
        <h2 id="schedule-heading">Horários agendados da live</h2>
        <p>
          Programe os horários em que {channel.name} entra e sai do ar sozinho. Se o TikTok LIVE Studio automático ou a transmissão pela nuvem estiverem ativos, a live abre e fecha junto.
        </p>
      </div>
      <form
        className={s.form}
        onSubmit={(e) => {
          e.preventDefault();
          void persistSchedule(draftSchedule);
        }}
        noValidate
      >
        <Switch
          label="Ligar e encerrar a live automaticamente por horário"
          hint="Inicia o apresentador no horário de início e finaliza ao atingir o horário de término nos dias marcados."
          checked={enabled}
          onChange={(nextEnabled) => {
            setEnabled(nextEnabled);
            void persistSchedule({ ...draftSchedule, enabled: nextEnabled });
          }}
          disabled={update.isPending}
        />

        <div className={p.formRow}>
          <Field label="Horário de início" hint="Formato 24h (ex.: 20:00).">
            {(props) => <Input {...props} type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} required />}
          </Field>
          <Field
            label="Horário de término"
            hint={crossesMidnight ? "Termina no dia seguinte (vira a meia-noite)." : "Encerra a transmissão automaticamente neste horário."}
          >
            {(props) => <Input {...props} type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} required />}
          </Field>
        </div>

        <div className={s.deckSection}>
          <span className={s.deckTitle}>Dias da semana</span>
          <div className={s.chipRow}>
            {WEEKDAYS.map((w) => {
              const active = days.includes(w.day);
              return (
                <Button
                  key={w.day}
                  type="button"
                  size="sm"
                  variant={active ? "primary" : "ghost"}
                  aria-pressed={active}
                  onClick={() => toggleDay(w.day)}
                >
                  {w.short}
                </Button>
              );
            })}
          </div>
          <div className={s.chipRow}>
            <Button type="button" size="sm" variant="ghost" onClick={() => setDays([0, 1, 2, 3, 4, 5, 6])}>
              Todos os dias
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setDays([1, 2, 3, 4, 5])}>
              Seg a Sex
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setDays([0, 6])}>
              Fim de semana
            </Button>
          </div>
        </div>

        <Field label="Fuso horário do agendamento" hint={`Agora são ${evalStatus.localTime} nesse fuso.`}>
          {(props) => (
            <Select {...props} value={timezone} onChange={(e) => setTimezone(e.target.value)}>
              {zones.map((z) => (
                <option key={z.zone} value={z.zone}>
                  {z.label}
                </option>
              ))}
            </Select>
          )}
        </Field>

        <p className={s.status} data-ok={enabled && evalStatus.inWindow}>
          <span className={s.statusDot} aria-hidden />
          {!enabled
            ? `Agendamento desligado · Janela configurada: ${startTime}–${endTime}`
            : evalStatus.inWindow
              ? `Dentro da janela agendada agora (${startTime}–${endTime} · hora local ${evalStatus.localTime})`
              : `Aguardando próximo horário agendado (${startTime}–${endTime} · hora local ${evalStatus.localTime})`}
        </p>

        {error && <p className={s.error}>{error}</p>}

        <div className={p.formActions}>
          <Button type="submit" variant="primary" icon={<CalendarClock aria-hidden />} busy={update.isPending}>
            Salvar horários
          </Button>
        </div>
      </form>
    </Panel>
  );
}

/** A code for an agent downloaded elsewhere (the GitHub release) or a PC paired again (ADR-0047). */
function PairingCode() {
  const { channel } = useHost();
  const client = useQueryClient();
  const [code, setCode] = useState<{ code: string; expiresAt: string } | null>(null);
  const create = useMutation({
    mutationFn: () => call(api.api.channels[":id"]["live-studio"].pairing.$post({ param: { id: channel.id } })),
    onSuccess: (result) => {
      setCode(result);
      void client.invalidateQueries({ queryKey: keys.bridgeDevices(channel.id) });
    },
    onError: (err) => toast.error("Não deu para gerar o código", err),
  });
  const [, setTick] = useState(0);
  // Swap the code for the button once it stops working.
  useEffect(() => {
    if (!code) return;
    const timer = setTimeout(() => setTick((n) => n + 1), Math.max(0, Date.parse(code.expiresAt) - Date.now()) + 500);
    return () => clearTimeout(timer);
  }, [code]);
  const expired = code ? Date.parse(code.expiresAt) <= Date.now() : false;

  if (!code || expired) {
    return (
      <div className={p.formActions}>
        <Button variant="ghost" icon={<KeyRound aria-hidden />} busy={create.isPending} onClick={() => create.mutate()}>
          {expired ? "Gerar outro código" : "Parear com código"}
        </Button>
        <span className={s.note}>Para um agente que já está no PC, ou baixado das releases.</span>
      </div>
    );
  }
  return (
    <div className={s.pairing} role="status">
      <span className={s.note}>Digite este código no agente do seu PC:</span>
      <span className={s.pairingCode} aria-label={`Código de pareamento ${code.code.split("").join(" ")}`}>
        {formatPairingCode(code.code)}
      </span>
      <span className={s.note}>Vale uma vez, até {time(code.expiresAt)}. Ou rode: lantern-bridge.exe --pair {formatPairingCode(code.code)}</span>
    </div>
  );
}

function PairedDevices() {
  const { channel } = useHost();
  const client = useQueryClient();
  const { data: devices } = useBridgeDevices(channel.id);
  const [removing, setRemoving] = useState<{ id: string; name: string } | null>(null);
  if (!devices?.length) return <p className={s.note}>Nenhum computador pareado ainda.</p>;
  return (
    <>
      <ul className={s.devices} aria-label="Computadores pareados">
        {devices.map((device) => (
          <li key={device.id} className={s.device}>
            <div>
              <div className={s.deviceName}>{device.name}</div>
              <div className={s.status} data-ok={device.connected}>
                <span className={s.statusDot} aria-hidden />
                {device.connected ? "Conectado agora" : device.lastSeenAt ? `Visto ${ago(device.lastSeenAt)}` : `Pareado ${ago(device.createdAt)}`}
              </div>
            </div>
            <Button variant="quietDanger" size="sm" icon={<Trash2 aria-hidden />} onClick={() => setRemoving(device)}>
              Remover
            </Button>
          </li>
        ))}
      </ul>
      <Confirm
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={`Remover ${removing?.name ?? "este computador"}?`}
        description="O agente nesse PC desconecta na hora e só volta com um novo código de pareamento."
        confirmLabel="Remover"
        danger
        onConfirm={async () => {
          if (!removing) return;
          await call(api.api.channels[":id"]["live-studio"].devices[":deviceId"].$delete({ param: { id: channel.id, deviceId: removing.id } }));
          await client.invalidateQueries({ queryKey: keys.bridgeDevices(channel.id) });
          toast.success("Computador removido");
        }}
      />
    </>
  );
}

function TikTokLiveStudio() {
  const { channel, store } = useHost();
  const { data: config } = useConfig();
  const update = useUpdateBroadcast(channel.id);
  const liveStudio = useStudio(store, (st) => st.snapshot?.health.liveStudio ?? null);
  const [checked, setChecked] = useState<{
    ok: boolean;
    detail: string;
    connected?: boolean;
    installed?: boolean;
    bridgeConnected?: boolean;
    probe?: LiveStudioProbe;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const check = useMutation({
    mutationFn: (launch: boolean) => call(api.api.channels[":id"]["live-studio"].check.$post({ param: { id: channel.id }, json: { launch } })),
    onSuccess: (result) => setChecked(result),
    onError: (err) => setChecked({ ok: false, detail: errorMessage(err) }),
  });

  const actionMutation = useMutation({
    mutationFn: (payload: LiveStudioActionRequest) =>
      call(api.api.channels[":id"]["live-studio"].action.$post({ param: { id: channel.id }, json: payload })),
    onSuccess: (res) => {
      if (res.channel) putChannel(res.channel);
      if (res.probe) {
        setChecked((prev) => ({
          ok: res.ok,
          detail: res.detail,
          connected: res.probe.connected,
          installed: res.probe.installed,
          bridgeConnected: prev?.bridgeConnected ?? liveStudio?.bridgeConnected ?? false,
          probe: res.probe,
        }));
      }
      if (res.ok) toast.success(res.detail);
      else toast.error("Não deu para executar no TikTok LIVE Studio", res.detail);
    },
    onError: (err) => setError(errorMessage(err)),
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
  const probe = checked?.probe ?? liveStudio?.probe ?? null;
  const detectedHandle = probe?.tiktokUsername ?? null;
  const currentSceneItem = probe?.sceneList?.find((sc) => sc.name === probe.scene) ?? probe?.sceneList?.[0] ?? null;
  const download = config?.bridge.download ?? false;
  const megabytes = config?.bridge.bytes ? Math.round(config.bridge.bytes / 1_000_000) : null;

  return (
    <Panel as="section" aria-labelledby="live-studio-heading" className={p.form}>
      <div className={p.sectionHead}>
        <h2 id="live-studio-heading">TikTok LIVE Studio automático</h2>
        <p>O agente local do {PRODUCT_NAME} roda no seu PC e comanda o aplicativo do TikTok LIVE Studio para iniciar e encerrar a live, salvar clipes de destaque, controlar cenas e acionar Vibes automaticamente.</p>
      </div>
      <div className={s.form}>
        <Switch
          label="Iniciar e encerrar a live no TikTok LIVE Studio"
          hint="Começa e encerra a transmissão no TikTok LIVE Studio junto com o apresentador, e aciona clipes de 60s e Vibes automaticamente nos melhores momentos."
          checked={Boolean(channel.broadcast.liveStudio)}
          onChange={(enabled) => void toggle(enabled)}
          disabled={update.isPending}
        />
        <h3 className={s.subhead}>Agente no seu PC (Windows)</h3>
        {download ? (
          <ol className={s.steps}>
            <li>
              Baixe o agente no PC onde o TikTok LIVE Studio roda. Cada download já vem pareado com {channel.name}: abra em até 15 minutos.
            </li>
            <li>
              Se o Windows avisar que protegeu o computador, clique em <strong>Mais informações</strong> e depois em <strong>Executar assim mesmo</strong>.
            </li>
            <li>Deixe a janela do agente aberta durante a live. Nas próximas vezes, é só abrir o mesmo arquivo.</li>
          </ol>
        ) : (
          <p className={s.note}>Este servidor não tem o lantern-bridge.exe para baixar. Use o da página de releases do {PRODUCT_NAME} e pareie com um código.</p>
        )}
        {download && (
          <div className={p.formActions}>
            <a href={`/api/channels/${channel.id}/live-studio/bridge.exe`} download="lantern-bridge.exe">
              <Button type="button" variant="primary" icon={<Download aria-hidden />}>
                Baixar lantern-bridge.exe
              </Button>
            </a>
            {megabytes && <span className={s.note}>{megabytes} MB</span>}
          </div>
        )}
        <PairingCode />
        <h3 className={s.subhead}>Computadores pareados</h3>
        <PairedDevices />
        {liveStudio && (
          <p className={s.status} data-ok={liveStudio.state === "live" || Boolean(liveStudio.bridgeConnected)}>
            <span className={s.statusDot} aria-hidden />
            {liveStudio.detail}
          </p>
        )}
        {detectedHandle && (
          <p className={s.status} data-ok="true">
            <span className={s.statusDot} aria-hidden />
            Conta logada no TikTok LIVE Studio: <strong>@{detectedHandle}</strong>
            {probe?.stageInjected ? " · Fonte Vincular (1080×1920) configurada" : ""}
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
          <Button
            variant="ghost"
            icon={<Wand2 aria-hidden />}
            busy={actionMutation.isPending}
            onClick={() => actionMutation.mutate({ action: "inject_stage" })}
          >
            Configurar palco na cena (1 clique)
          </Button>
          {(!channel.tiktokUsername || (detectedHandle && detectedHandle !== channel.tiktokUsername)) && (
            <Button
              variant="ghost"
              busy={actionMutation.isPending}
              onClick={() => actionMutation.mutate({ action: "sync_handle" })}
            >
              {detectedHandle ? `Usar @${detectedHandle}` : "Detectar @usuário logado"}
            </Button>
          )}
        </div>

        {probe?.connected && (
          <div className={s.studioDeck}>
            <div className={s.deckSection}>
              <span className={s.deckTitle}>Clipes Virais e Gravação Local</span>
              <div className={s.chipRow}>
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<Film aria-hidden />}
                  busy={actionMutation.isPending}
                  onClick={() => actionMutation.mutate({ action: "highlight" })}
                >
                  Salvar clipe de destaque (60s)
                </Button>
                <Button
                  size="sm"
                  variant={probe.recording ? "primary" : "ghost"}
                  icon={<Video aria-hidden />}
                  busy={actionMutation.isPending}
                  onClick={() => actionMutation.mutate({ action: "recording" })}
                >
                  {probe.recording ? "Gravando MP4 local (Parar)" : "Gravar MP4 local"}
                </Button>
              </div>
            </div>

            {probe.sceneList && probe.sceneList.length > 0 && (
              <div className={s.deckSection}>
                <span className={s.deckTitle}>Cenas no TikTok LIVE Studio</span>
                <div className={s.chipRow}>
                  {probe.sceneList.map((sc) => (
                    <Button
                      key={sc.name}
                      size="sm"
                      variant={sc.name === probe.scene ? "primary" : "ghost"}
                      busy={actionMutation.isPending}
                      onClick={() => actionMutation.mutate({ action: "scene", scene: sc.name })}
                    >
                      {sc.name}
                    </Button>
                  ))}
                </div>
              </div>
            )}

            {currentSceneItem && currentSceneItem.sources.length > 0 && (
              <div className={s.deckSection}>
                <span className={s.deckTitle}>Fontes da cena ({currentSceneItem.name})</span>
                <div className={s.chipRow}>
                  {currentSceneItem.sources.map((src) => (
                    <Button
                      key={src.id}
                      size="sm"
                      variant={src.visible ? "primary" : "ghost"}
                      busy={actionMutation.isPending}
                      onClick={() =>
                        actionMutation.mutate({
                          action: "source",
                          scene: currentSceneItem.name,
                          sourceId: src.id,
                        })
                      }
                    >
                      {src.label} ({src.visible ? "Visível" : "Oculta"})
                    </Button>
                  ))}
                </div>
              </div>
            )}

            {probe.vibeList && probe.vibeList.length > 0 && (
              <div className={s.deckSection}>
                <span className={s.deckTitle}>Vibes e Zooms Visuais</span>
                <div className={s.chipRow}>
                  {probe.vibeList.map((vibe) => (
                    <Button
                      key={vibe.id}
                      size="sm"
                      variant={probe.playingVibe === vibe.id ? "primary" : "ghost"}
                      icon={<Sparkles aria-hidden />}
                      busy={actionMutation.isPending}
                      onClick={() => actionMutation.mutate({ action: "vibe", vibeId: vibe.id })}
                    >
                      {vibe.name}
                    </Button>
                  ))}
                </div>
              </div>
            )}

            {probe.cameraEffects && probe.cameraEffects.categories.some((c) => c.effects.length > 0) && (
              <div className={s.deckSection}>
                <span className={s.deckTitle}>Efeitos de Câmera</span>
                <div className={s.chipRow}>
                  {probe.cameraEffects.categories.flatMap((cat) =>
                    cat.effects.slice(0, 8).map((fx) => (
                      <Button
                        key={`${cat.key}:${fx.id}`}
                        size="sm"
                        variant="ghost"
                        busy={actionMutation.isPending}
                        onClick={() =>
                          actionMutation.mutate({
                            action: "camera_effect",
                            cameraEffectType: cat.key,
                            cameraEffectId: fx.id,
                          })
                        }
                      >
                        {fx.label}
                      </Button>
                    )),
                  )}
                </div>
              </div>
            )}
          </div>
        )}
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
      <ScheduledStreamHours />
      <TikTokLiveStudio />
      <CloudBroadcast />
    </div>
  );
}
