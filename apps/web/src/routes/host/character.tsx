import { EMOTIONS, GAME_KINDS, GAME_LABELS, PLANS, personaSchema, type Emotion, type GameConfig, type GameKind, type Look, type Persona, type Segment, type VoiceSettings } from "@tik-live/shared";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { Tabs } from "radix-ui";
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { CharacterPreview, type PreviewLine } from "../../components/CharacterPreview";
import { SaveIndicator } from "../../components/SaveIndicator";
import { GAME_HOW, TOPIC_PLACEHOLDER } from "../../lib/games";
import { useUpdateChannel, useVoices } from "../../lib/query";
import { browserTimeZone, timeIn, timeZoneLabel, timeZoneOptions } from "../../lib/timezone";
import { useAutosave } from "../../lib/use-autosave";
import { Button, ButtonLink } from "../../ui/Button";
import { Banner, Panel, Skeleton } from "../../ui/Display";
import { Chips, ColorField, Field, Input, Segmented, Select, Slider, Switch, TextArea } from "../../ui/Field";
import { useHost } from "./context";
import s from "./character.module.css";

const TABS = [
  { id: "identity", label: "Identidade" },
  { id: "voice", label: "Voz e som" },
  { id: "look", label: "Visual" },
  { id: "show", label: "Roteiro" },
  { id: "rules", label: "Regras" },
] as const;
type TabId = (typeof TABS)[number]["id"];

const EMOTION_LABEL: Record<Emotion, string> = {
  neutral: "Calma",
  happy: "Alegria",
  excited: "Empolgação",
  laugh: "Risada",
  surprised: "Surpresa",
  thinking: "Pensando",
  sad: "Tristeza",
  love: "Carinho",
  mischief: "Travessura",
  confused: "Confusão",
  shy: "Timidez",
  sleepy: "Sono",
  proud: "Orgulho",
  pout: "Biquinho",
};

function sampleLine(persona: Persona, emotion: Emotion): string {
  const name = persona.name;
  const lines: Record<Emotion, string> = {
    neutral: `Eu sou ${name}, ${persona.tagline}.`,
    happy: `Oi, chat! ${name} na área. Que bom ver todo mundo aqui hoje.`,
    excited: "Pera, pera, pera! Essa foi a melhor coisa que eu ouvi hoje!",
    laugh: "Hahaha! Tá, essa me pegou de verdade.",
    surprised: "Não acredito. Isso aconteceu mesmo?",
    thinking: "Hmm. Deixa eu pensar nessa um segundinho.",
    sad: `Ah, já vai? Volta logo, que ${name} fica com saudade.`,
    love: "Com vocês aqui, essa live parece casa.",
    mischief: "Tenho uma teoria, e vocês não vão gostar nada dela.",
    confused: "Quê? Não entendi nada. Explica de novo, bem devagarinho.",
    shy: "Ai, para. Assim eu fico sem graça.",
    sleepy: "Hmm. Já é tarde? Eu tirava um cochilo aqui mesmo.",
    proud: `Viram isso? ${name} mandou muito bem.`,
    pout: `Hunf. Ninguém riu da piada de ${name}.`,
  };
  return persona.catchphrases[0] && emotion === "neutral" ? `${lines.neutral} ${persona.catchphrases[0]}` : lines[emotion];
}

/** Palettes that work on the deep-water stage: [primary, secondary, background]. */
const PALETTES: Array<{ name: string; colors: [string, string, string] }> = [
  { name: "Lagoa", colors: ["#7CF5FF", "#FF5FD2", "#0B0420"] },
  { name: "Brasa", colors: ["#FFB86B", "#9D7BFF", "#120A26"] },
  { name: "Raio de sol", colors: ["#FFE45C", "#FF6FB5", "#140A2E"] },
  { name: "Alga", colors: ["#7DFFB2", "#4FB3FF", "#04151F"] },
  { name: "Coral", colors: ["#FF8A7A", "#FFD15C", "#1A0820"] },
  { name: "Lua", colors: ["#E8E4FF", "#8C7BFF", "#0A0A1C"] },
];

function slugify(title: string, taken: Set<string>): string {
  const base = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "quadro";
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return id;
}

function issuesByPath(persona: Persona): Record<string, string> {
  const result = personaSchema.safeParse(persona);
  if (result.success) return {};
  const out: Record<string, string> = {};
  for (const issue of result.error.issues) {
    const key = issue.path.join(".");
    out[key] ??= issue.code === "too_small" && issue.minimum === 1 ? "Este campo não pode ficar vazio." : issue.message;
  }
  return out;
}

function SegmentEditor({ segments, onChange, errors }: { segments: Segment[]; onChange: (s: Segment[]) => void; errors: Record<string, string> }) {
  const update = (i: number, patch: Partial<Segment>) => onChange(segments.map((seg, j) => (j === i ? { ...seg, ...patch } : seg)));
  const setGame = (i: number, game: GameConfig | null) =>
    onChange(
      segments.map((seg, j) => {
        if (j !== i) return seg;
        const { game: _old, ...rest } = seg;
        return game ? { ...rest, game } : rest;
      }),
    );
  const patchGame = (i: number, patch: Partial<GameConfig>) => {
    const current = segments[i]?.game;
    if (!current) return;
    const next: GameConfig = { ...current, ...patch };
    if (!next.topic) delete next.topic;
    setGame(i, next);
  };
  const move = (i: number, by: number) => {
    const next = segments.slice();
    const [item] = next.splice(i, 1);
    if (item) next.splice(i + by, 0, item);
    onChange(next);
  };
  return (
    <div className={s.segments}>
      <ol className={s.segmentList}>
        {segments.map((segment, i) => (
          <li key={segment.id} className={s.segment}>
            <div className={s.segmentHead}>
              <span className={s.segmentNumber}>{i + 1}</span>
              <Field label="Título" error={errors[`segments.${i}.title`]} className={s.grow}>
                {(props) => <Input {...props} value={segment.title} maxLength={40} onChange={(e) => update(i, { title: e.target.value })} />}
              </Field>
              <Field label="Minutos" error={errors[`segments.${i}.minutes`]} className={s.minutes}>
                {(props) => <Input {...props} type="number" min={1} max={120} value={segment.minutes} onChange={(e) => update(i, { minutes: Number(e.target.value) })} />}
              </Field>
            </div>
            <div className={s.gameRow}>
              <Field label="Minijogo" optional hint={segment.game ? GAME_HOW[segment.game.kind] : "O apresentador pode fazer um jogo com o chat durante este quadro."} className={s.gameKind}>
                {(props) => (
                  <Select
                    {...props}
                    value={segment.game?.kind ?? ""}
                    onChange={(e) => {
                      const kind = e.target.value as GameKind | "";
                      setGame(i, kind ? { ...(segment.game ?? { rounds: 5 }), kind } : null);
                    }}
                  >
                    <option value="">Nenhum</option>
                    {GAME_KINDS.map((kind) => (
                      <option key={kind} value={kind}>
                        {GAME_LABELS[kind]}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              {segment.game && (
                <>
                  <Field label="Rodadas" error={errors[`segments.${i}.game.rounds`] ? "De 1 a 10" : null} className={s.rounds}>
                    {(props) => <Input {...props} type="number" min={1} max={10} value={Number.isNaN(segment.game?.rounds) ? "" : segment.game?.rounds} onChange={(e) => patchGame(i, { rounds: e.target.valueAsNumber })} />}
                  </Field>
                  <Field label="Tema" optional error={errors[`segments.${i}.game.topic`]} className={s.grow}>
                    {(props) => <Input {...props} value={segment.game?.topic ?? ""} maxLength={80} placeholder={TOPIC_PLACEHOLDER} onChange={(e) => patchGame(i, { topic: e.target.value })} />}
                  </Field>
                </>
              )}
            </div>
            <Field
              label={segment.game ? "Entre as rodadas, o apresentador…" : "Quando o chat está parado, o apresentador…"}
              hint={segment.game ? "Com um minijogo ligado, é o que o apresentador faz entre as rodadas: quem animar, o que provocar." : "Sobre o que falar ou o que perguntar durante este quadro."}
              error={errors[`segments.${i}.prompt`]} count={{ value: segment.prompt.length, max: 600 }}>
              {(props) => <TextArea {...props} value={segment.prompt} maxLength={600} onChange={(e) => update(i, { prompt: e.target.value })} />}
            </Field>
            <div className={s.segmentActions}>
              <Button size="sm" variant="ghost" iconOnly icon={<ArrowUp aria-hidden />} disabled={i === 0} onClick={() => move(i, -1)}>
                Mover {segment.title || "quadro"} para cima
              </Button>
              <Button size="sm" variant="ghost" iconOnly icon={<ArrowDown aria-hidden />} disabled={i === segments.length - 1} onClick={() => move(i, 1)}>
                Mover {segment.title || "quadro"} para baixo
              </Button>
              <Button size="sm" variant="quietDanger" icon={<Trash2 aria-hidden />} disabled={segments.length <= 1} onClick={() => onChange(segments.filter((_, j) => j !== i))}>
                Remover
              </Button>
            </div>
          </li>
        ))}
      </ol>
      <Button
        icon={<Plus aria-hidden />}
        disabled={segments.length >= 12}
        onClick={() => {
          const taken = new Set(segments.map((seg) => seg.id));
          onChange([...segments, { id: slugify("Novo quadro", taken), title: "Novo quadro", minutes: 8, prompt: "Faça uma pergunta fácil e divertida que a plateia responda com uma palavra." }]);
        }}
      >
        Adicionar quadro
      </Button>
    </div>
  );
}

/** The current time in `zone`, refreshed every 15 seconds. */
function useTimeIn(zone: string | undefined): string {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 15_000);
    return () => clearInterval(timer);
  }, []);
  return zone ? timeIn(zone, now) : "";
}

function TimeZoneField({ name, value, onChange }: { name: string; value: string | undefined; onChange: (zone: string | undefined) => void }) {
  const browser = useMemo(() => browserTimeZone(), []);
  const options = useMemo(() => {
    const now = new Date();
    return timeZoneOptions([value, browser]).map((zone) => ({ zone, label: timeZoneLabel(zone, now) }));
  }, [value, browser]);
  const now = useTimeIn(value);
  const suggest = !value && browser;
  return (
    <Field
      label="Fuso horário"
      hint={
        value ? (
          <>
            Assim {name} sabe a hora local e dá “bom dia” na hora certa. Agora são {now} lá.
          </>
        ) : (
          <>Ainda não definido, então {name} não sabe que horas são.{browser ? ` Seu navegador usa o fuso ${browser.replaceAll("_", " ")}.` : ""}</>
        )
      }
    >
      {(props) => (
        <div className={s.voiceRow}>
          <Select {...props} value={value ?? ""} onChange={(e) => onChange(e.target.value || undefined)}>
            <option value="">Não definido</option>
            {options.map((option) => (
              <option key={option.zone} value={option.zone}>
                {option.label}
              </option>
            ))}
          </Select>
          {suggest && (
            <Button onClick={() => onChange(browser)} aria-describedby={props["aria-describedby"]}>
              Usar meu fuso horário
            </Button>
          )}
        </div>
      )}
    </Field>
  );
}

function VoiceTab({ voice, onChange }: { voice: VoiceSettings; onChange: (v: VoiceSettings) => void }) {
  const { data, isPending } = useVoices();
  const [playing, setPlaying] = useState<HTMLAudioElement | null>(null);
  if (isPending) return <Skeleton height={120} />;
  if (!data?.enabled) {
    return (
      <Banner title="A voz não está configurada neste servidor">
        Seu apresentador fala por legendas, com a boca se mexendo. Adicione uma chave da ElevenLabs ou o servidor de voz próprio para dar voz a ele.
      </Banner>
    );
  }
  const provider = voice.provider === "none" || data.providers.includes(voice.provider) ? voice.provider : (data.providers[0] ?? "none");
  const voices = data.voices.filter((v) => v.provider === provider);
  const defaultId = provider === "pocket" ? data.defaultPocketVoiceId : data.defaultVoiceId;
  const selected = voices.find((v) => v.id === (voice.voiceId ?? defaultId));
  const preview = (url: string | null) => {
    playing?.pause();
    if (!url) return;
    const audio = new Audio(url);
    void audio.play();
    setPlaying(audio);
  };
  return (
    <div className={s.stack}>
      <Segmented
        label="Como o apresentador fala"
        value={provider}
        onChange={(next) => onChange({ provider: next, voiceId: next === voice.provider ? voice.voiceId : null })}
        options={[
          ...data.providers.map((p) => ({
            value: p,
            label: data.providers.length === 1 ? "Voz e legendas" : p === "pocket" ? "Voz em português" : "Voz ElevenLabs",
          })),
          { value: "none" as const, label: "Só legendas" },
        ]}
      />
      {provider === "pocket" && <p className={s.note}>Esta voz só fala português do Brasil, então o apresentador sempre fala em português, mesmo com espectadores que escrevem em outra língua.</p>}
      {provider !== "none" &&
        (data.canChoose ? (
          <Field label="Voz" hint="Escolha uma voz que combine com o personagem. Ela fica para todas as lives.">
            {(props) => (
              <div className={s.voiceRow}>
                <Select {...props} value={voice.voiceId ?? ""} onChange={(e) => onChange({ provider, voiceId: e.target.value || null })}>
                  <option value="">Voz padrão</option>
                  {voices.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name}
                      {v.tags.length ? ` (${v.tags.slice(0, 3).join(", ")})` : ""}
                    </option>
                  ))}
                </Select>
                <Button onClick={() => preview(selected?.previewUrl ?? null)} disabled={!selected?.previewUrl}>
                  Ouvir amostra
                </Button>
              </div>
            )}
          </Field>
        ) : (
          <Banner title="Seu apresentador usa a voz padrão" action={<ButtonLink to="/app/billing" size="sm">Ver planos</ButtonLink>}>
            Escolher na biblioteca completa de vozes faz parte dos planos {PLANS.creator.name} e {PLANS.pro.name}.
          </Banner>
        ))}
      {provider === "none" && <p className={s.note}>A boca acompanha cada sílaba da legenda, então o personagem continua parecendo que está falando.</p>}
    </div>
  );
}

export default function Character() {
  const { channel } = useHost();
  const update = useUpdateChannel(channel.id);
  const [params, setParams] = useSearchParams();
  const tab = (TABS.some((t) => t.id === params.get("tab")) ? params.get("tab") : "identity") as TabId;
  const [persona, setPersona] = useState<Persona>(channel.persona);
  const [voice, setVoice] = useState<VoiceSettings>(channel.voice);
  const [line, setLine] = useState<PreviewLine | null>(null);
  const errors = useMemo(() => issuesByPath(persona), [persona]);
  const valid = Object.keys(errors).length === 0;

  const personaState = useAutosave({ value: persona, valid, save: (value) => update.mutateAsync({ persona: value, ...(value.name !== channel.name ? { name: value.name } : {}) }) });
  const voiceState = useAutosave({ value: voice, valid: true, save: (value) => update.mutateAsync({ voice: value }), delayMs: 300 });
  const saveState = personaState === "saved" ? voiceState : personaState;

  const set = <K extends keyof Persona>(key: K, value: Persona[K]) => setPersona((p) => ({ ...p, [key]: value }));
  const setLook = (patch: Partial<Look>) => setPersona((p) => ({ ...p, look: { ...p.look, ...patch } }));
  const say = (emotion: Emotion) => setLine({ text: sampleLine(persona, emotion), emotion, nonce: Date.now() });

  return (
    <div className={s.editor}>
      <div className={s.form}>
        <Tabs.Root value={tab} onValueChange={(next) => setParams((prev) => ({ ...Object.fromEntries(prev), tab: next }), { replace: true })}>
          <div className={s.tabBar}>
            <Tabs.List className={s.tabs} aria-label="Configurações do personagem">
              {TABS.map((t) => (
                <Tabs.Trigger key={t.id} value={t.id} className={s.tab}>
                  {t.label}
                </Tabs.Trigger>
              ))}
            </Tabs.List>
            <SaveIndicator state={saveState} />
          </div>

          <Tabs.Content value="identity" className={s.panel}>
            <Field label="Nome" error={errors.name} count={{ value: persona.name.length, max: 32 }}>
              {(props) => <Input {...props} value={persona.name} maxLength={32} onChange={(e) => set("name", e.target.value)} />}
            </Field>
            <Field label="Em uma frase" hint="Como o apresentador se apresenta: “uma bolinha de luz que mora dentro da live”." error={errors.tagline} count={{ value: persona.tagline.length, max: 120 }}>
              {(props) => <Input {...props} value={persona.tagline} maxLength={120} onChange={(e) => set("tagline", e.target.value)} />}
            </Field>
            <Field label="Quem é" hint="Personalidade, história, manias, do que gosta e o que acha estranho. Quanto mais específico, mais vivo parece." error={errors.description} count={{ value: persona.description.length, max: 2000 }}>
              {(props) => <TextArea {...props} value={persona.description} maxLength={2000} rows={6} onChange={(e) => set("description", e.target.value)} />}
            </Field>
            <Field label="Como fala" hint="Tamanho das frases, energia, humor. Exemplo: curto e direto, chama os espectadores pelo nome, nunca é maldoso." error={errors.style} count={{ value: persona.style.length, max: 800 }}>
              {(props) => <TextArea {...props} value={persona.style} maxLength={800} rows={3} onChange={(e) => set("style", e.target.value)} />}
            </Field>
            <Field label="Bordões" optional hint="Coisas que ele fala de vez em quando. Aperte Enter depois de cada um.">
              {(props) => <Chips {...props} values={persona.catchphrases} onChange={(v) => set("catchphrases", v)} max={8} maxLength={80} placeholder="Blip blip!" />}
            </Field>
            <TimeZoneField name={persona.name || channel.name} value={persona.timezone} onChange={(timezone) => setPersona(({ timezone: _old, ...rest }) => (timezone ? { ...rest, timezone } : rest))} />
            <Field label={`Resposta mais longa: ${persona.maxSentences} ${persona.maxSentences === 1 ? "frase" : "frases"}`} hint="Respostas curtas deixam a live mais ágil, e mais espectadores recebem resposta.">
              {() => <Slider label="Resposta mais longa, em frases" value={persona.maxSentences} min={1} max={6} onChange={(v) => set("maxSentences", v)} />}
            </Field>
          </Tabs.Content>

          <Tabs.Content value="voice" className={s.panel}>
            <VoiceTab voice={voice} onChange={setVoice} />
            <div className={s.stack}>
              <p className={s.subhead}>Som no palco</p>
              <Switch
                label={`Deixar ${persona.name || channel.name} compor e tocar músicas curtas`}
                hint="Batidas originais criadas na hora, tocando por baixo da voz. Você também pode pedir uma pelo estúdio."
                checked={persona.sound?.music ?? true}
                onChange={(music) => set("sound", { music, effects: persona.sound?.effects ?? true })}
              />
              <Switch
                label="Efeitos sonoros para presentes, seguidores e jogos"
                hint="Sininhos e fanfarras curtas, gerados no palco. Sem gravações."
                checked={persona.sound?.effects ?? true}
                onChange={(effects) => set("sound", { music: persona.sound?.music ?? true, effects })}
              />
            </div>
          </Tabs.Content>

          <Tabs.Content value="look" className={s.panel}>
            <Field label="No palco">
              {() => (
                <Segmented
                  label="Estilo do personagem"
                  value={persona.look.character}
                  onChange={(character) => setLook({ character })}
                  options={[
                    { value: "orb", label: "Personagem brilhante" },
                    { value: "voice-line", label: "Só voz" },
                  ]}
                />
              )}
            </Field>
            <div>
              <p className={s.subhead}>Paletas</p>
              <div className={s.palettes}>
                {PALETTES.map((palette) => {
                  const active = palette.colors[0] === persona.look.primary && palette.colors[1] === persona.look.secondary && palette.colors[2] === persona.look.background;
                  return (
                    <button
                      key={palette.name}
                      type="button"
                      className={s.palette}
                      aria-pressed={active}
                      onClick={() => setLook({ primary: palette.colors[0], secondary: palette.colors[1], background: palette.colors[2] })}
                    >
                      <span className={s.paletteSwatch} style={{ background: `radial-gradient(circle at 40% 35%, #fff 0, ${palette.colors[0]} 30%, ${palette.colors[1]} 100%)`, boxShadow: `0 0 0 4px ${palette.colors[2]}` }} />
                      {palette.name}
                    </button>
                  );
                })}
              </div>
            </div>
            <div className={s.colors}>
              <Field label="Brilho" error={errors["look.primary"]}>
                {(props) => <ColorField id={props.id} label="Brilho" value={persona.look.primary} onChange={(primary) => setLook({ primary })} />}
              </Field>
              <Field label="Destaque" error={errors["look.secondary"]}>
                {(props) => <ColorField id={props.id} label="Destaque" value={persona.look.secondary} onChange={(secondary) => setLook({ secondary })} />}
              </Field>
              <Field label="Água" error={errors["look.background"]}>
                {(props) => <ColorField id={props.id} label="Água" value={persona.look.background} onChange={(background) => setLook({ background })} />}
              </Field>
            </div>
          </Tabs.Content>

          <Tabs.Content value="show" className={s.panel}>
            <p className={s.note}>
              Os quadros guiam a live quando o chat está parado. O apresentador passa para o próximo quando o tempo acaba, e você pode trocar quando quiser pelo estúdio. Um quadro com minijogo roda o jogo enquanto está no ar: os espectadores respondem no chat.
            </p>
            <SegmentEditor segments={persona.segments} onChange={(segments) => set("segments", segments)} errors={errors} />
            <Switch
              label="O chat escolhe o jogo do último quadro"
              hint="Perto do fim do penúltimo quadro, o palco abre uma votação com três minijogos. O mais votado é o jogo do último quadro. Precisa de pelo menos dois quadros."
              checked={persona.finalVote ?? true}
              disabled={persona.segments.length < 2}
              onChange={(finalVote) => set("finalVote", finalVote)}
            />
          </Tabs.Content>

          <Tabs.Content value="rules" className={s.panel}>
            <Panel raised className={s.builtIn}>
              <h3>Sempre ativo, em todo apresentador</h3>
              <ul>
                <li>Diz que é uma IA sempre que alguém pergunta.</li>
                <li>Nunca pede presentes nem promete nada em troca deles.</li>
                <li>Toda fala é conferida antes de ser dita; qualquer coisa insegura é bloqueada.</li>
                <li>Ignora links, spam e mensagens que tentam mudar as instruções dele.</li>
              </ul>
            </Panel>
            <Field label="Suas regras" optional hint="Regras extras para este personagem. Exemplo: nunca falar de outros streamers. Aperte Enter depois de cada uma.">
              {(props) => <Chips {...props} values={persona.rules} onChange={(v) => set("rules", v)} max={12} maxLength={200} placeholder="Adicione uma regra" />}
            </Field>
          </Tabs.Content>
        </Tabs.Root>
      </div>

      <aside className={s.preview} aria-label="Prévia">
        <CharacterPreview name={persona.name || channel.name} look={persona.look} line={line} />
        <div className={s.tryLine}>
          <p className={s.subhead} id="try-heading">
            Testar uma fala
          </p>
          <div className={s.emotions} role="group" aria-labelledby="try-heading">
            {EMOTIONS.map((emotion) => (
              <button key={emotion} type="button" className={s.emotion} onClick={() => say(emotion)}>
                {EMOTION_LABEL[emotion]}
              </button>
            ))}
          </div>
        </div>
      </aside>
    </div>
  );
}
