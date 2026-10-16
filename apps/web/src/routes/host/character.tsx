import { EMOTIONS, personaSchema, type Emotion, type Look, type Persona, type Segment, type VoiceSettings } from "@tik-live/shared";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { Tabs } from "radix-ui";
import { useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { CharacterPreview, type PreviewLine } from "../../components/CharacterPreview";
import { SaveIndicator } from "../../components/SaveIndicator";
import { useUpdateChannel, useVoices } from "../../lib/query";
import { useAutosave } from "../../lib/use-autosave";
import { Button, ButtonLink } from "../../ui/Button";
import { Banner, Panel, Skeleton } from "../../ui/Display";
import { Chips, ColorField, Field, Input, Segmented, Select, Slider, TextArea } from "../../ui/Field";
import { useHost } from "./context";
import s from "./character.module.css";

const TABS = [
  { id: "identity", label: "Identity" },
  { id: "voice", label: "Voice" },
  { id: "look", label: "Look" },
  { id: "show", label: "Show" },
  { id: "rules", label: "Rules" },
] as const;
type TabId = (typeof TABS)[number]["id"];

const EMOTION_LABEL: Record<Emotion, string> = {
  neutral: "Calm",
  happy: "Happy",
  excited: "Excited",
  laugh: "Laughing",
  surprised: "Surprised",
  thinking: "Thinking",
  sad: "Sad",
  love: "Loving",
  mischief: "Mischief",
};

function sampleLine(persona: Persona, emotion: Emotion): string {
  const lines: Record<Emotion, string> = {
    neutral: `I'm ${persona.name}, ${persona.tagline}.`,
    happy: "Hi chat! It's so good to see you all tonight.",
    excited: "Wait, wait, wait! That's the best thing I've heard all day!",
    laugh: "Ha! Okay, that one actually got me.",
    surprised: "No way. Did that really just happen?",
    thinking: "Hmm. Let me think about that one for a second.",
    sad: "Aw, you're leaving already? Come back soon, okay?",
    love: "You all make this stream feel like home.",
    mischief: "I have a theory, and you're not going to like it.",
  };
  return persona.catchphrases[0] && emotion === "neutral" ? `${lines.neutral} ${persona.catchphrases[0]}` : lines[emotion];
}

/** Palettes that work on the deep-water stage: [primary, secondary, background]. */
const PALETTES: Array<{ name: string; colors: [string, string, string] }> = [
  { name: "Lagoon", colors: ["#7CF5FF", "#FF5FD2", "#0B0420"] },
  { name: "Ember", colors: ["#FFB86B", "#9D7BFF", "#120A26"] },
  { name: "Sunbeam", colors: ["#FFE45C", "#FF6FB5", "#140A2E"] },
  { name: "Kelp", colors: ["#7DFFB2", "#4FB3FF", "#04151F"] },
  { name: "Coral", colors: ["#FF8A7A", "#FFD15C", "#1A0820"] },
  { name: "Moon", colors: ["#E8E4FF", "#8C7BFF", "#0A0A1C"] },
];

function slugify(title: string, taken: Set<string>): string {
  const base = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "segment";
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
    out[key] ??= issue.code === "too_small" && issue.minimum === 1 ? "This can't be empty." : issue.message;
  }
  return out;
}

function SegmentEditor({ segments, onChange, errors }: { segments: Segment[]; onChange: (s: Segment[]) => void; errors: Record<string, string> }) {
  const update = (i: number, patch: Partial<Segment>) => onChange(segments.map((seg, j) => (j === i ? { ...seg, ...patch } : seg)));
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
              <Field label="Title" error={errors[`segments.${i}.title`]} className={s.grow}>
                {(props) => <Input {...props} value={segment.title} maxLength={40} onChange={(e) => update(i, { title: e.target.value })} />}
              </Field>
              <Field label="Minutes" error={errors[`segments.${i}.minutes`]} className={s.minutes}>
                {(props) => <Input {...props} type="number" min={1} max={120} value={segment.minutes} onChange={(e) => update(i, { minutes: Number(e.target.value) })} />}
              </Field>
            </div>
            <Field label="When chat is quiet, the host…" hint="What to talk about or ask during this segment." error={errors[`segments.${i}.prompt`]} count={{ value: segment.prompt.length, max: 600 }}>
              {(props) => <TextArea {...props} value={segment.prompt} maxLength={600} onChange={(e) => update(i, { prompt: e.target.value })} />}
            </Field>
            <div className={s.segmentActions}>
              <Button size="sm" variant="ghost" iconOnly icon={<ArrowUp aria-hidden />} disabled={i === 0} onClick={() => move(i, -1)}>
                Move {segment.title || "segment"} up
              </Button>
              <Button size="sm" variant="ghost" iconOnly icon={<ArrowDown aria-hidden />} disabled={i === segments.length - 1} onClick={() => move(i, 1)}>
                Move {segment.title || "segment"} down
              </Button>
              <Button size="sm" variant="quietDanger" icon={<Trash2 aria-hidden />} disabled={segments.length <= 1} onClick={() => onChange(segments.filter((_, j) => j !== i))}>
                Remove
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
          onChange([...segments, { id: slugify("New segment", taken), title: "New segment", minutes: 8, prompt: "Ask the audience an easy, fun question they can answer in one word." }]);
        }}
      >
        Add a segment
      </Button>
    </div>
  );
}

function VoiceTab({ voice, onChange }: { voice: VoiceSettings; onChange: (v: VoiceSettings) => void }) {
  const { data, isPending } = useVoices();
  const [playing, setPlaying] = useState<HTMLAudioElement | null>(null);
  if (isPending) return <Skeleton height={120} />;
  if (!data?.enabled) {
    return (
      <Banner title="Voice isn't set up on this server">
        Your host speaks in captions with a moving mouth. Add an ElevenLabs key or the self-hosted voice server to give it a voice.
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
        label="How the host speaks"
        value={provider}
        onChange={(next) => onChange({ provider: next, voiceId: next === voice.provider ? voice.voiceId : null })}
        options={[
          ...data.providers.map((p) => ({
            value: p,
            label: data.providers.length === 1 ? "Voice and captions" : p === "pocket" ? "Portuguese voice" : "ElevenLabs voice",
          })),
          { value: "none" as const, label: "Captions only" },
        ]}
      />
      {provider === "pocket" && <p className={s.note}>This voice speaks Brazilian Portuguese only, so your host always talks in Portuguese, even to viewers who write in another language.</p>}
      {provider !== "none" &&
        (data.canChoose ? (
          <Field label="Voice" hint="Pick a voice that fits the character. Your host keeps it for every stream.">
            {(props) => (
              <div className={s.voiceRow}>
                <Select {...props} value={voice.voiceId ?? ""} onChange={(e) => onChange({ provider, voiceId: e.target.value || null })}>
                  <option value="">Default voice</option>
                  {voices.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name}
                      {v.tags.length ? ` (${v.tags.slice(0, 3).join(", ")})` : ""}
                    </option>
                  ))}
                </Select>
                <Button onClick={() => preview(selected?.previewUrl ?? null)} disabled={!selected?.previewUrl}>
                  Play sample
                </Button>
              </div>
            )}
          </Field>
        ) : (
          <Banner title="Your host uses the default voice" action={<ButtonLink to="/app/billing" size="sm">See plans</ButtonLink>}>
            Choosing from the full voice library is part of the Creator and Pro plans.
          </Banner>
        ))}
      {provider === "none" && <p className={s.note}>The mouth follows each syllable of the caption, so the character still looks like it's talking.</p>}
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
            <Tabs.List className={s.tabs} aria-label="Character settings">
              {TABS.map((t) => (
                <Tabs.Trigger key={t.id} value={t.id} className={s.tab}>
                  {t.label}
                </Tabs.Trigger>
              ))}
            </Tabs.List>
            <SaveIndicator state={saveState} />
          </div>

          <Tabs.Content value="identity" className={s.panel}>
            <Field label="Name" error={errors.name} count={{ value: persona.name.length, max: 32 }}>
              {(props) => <Input {...props} value={persona.name} maxLength={32} onChange={(e) => set("name", e.target.value)} />}
            </Field>
            <Field label="In one line" hint="How the host introduces itself: “a tiny glowing orb who lives inside the stream”." error={errors.tagline} count={{ value: persona.tagline.length, max: 120 }}>
              {(props) => <Input {...props} value={persona.tagline} maxLength={120} onChange={(e) => set("tagline", e.target.value)} />}
            </Field>
            <Field label="Who it is" hint="Personality, backstory, quirks, what it loves and finds strange. The more specific, the more alive it feels." error={errors.description} count={{ value: persona.description.length, max: 2000 }}>
              {(props) => <TextArea {...props} value={persona.description} maxLength={2000} rows={6} onChange={(e) => set("description", e.target.value)} />}
            </Field>
            <Field label="How it talks" hint="Sentence length, energy, humor. Example: short and punchy, uses viewers' names, never mean." error={errors.style} count={{ value: persona.style.length, max: 800 }}>
              {(props) => <TextArea {...props} value={persona.style} maxLength={800} rows={3} onChange={(e) => set("style", e.target.value)} />}
            </Field>
            <Field label="Catchphrases" optional hint="Things it says now and then. Press Enter after each one.">
              {(props) => <Chips {...props} values={persona.catchphrases} onChange={(v) => set("catchphrases", v)} max={8} maxLength={80} placeholder="Blip blip!" />}
            </Field>
            <Field label={`Longest reply: ${persona.maxSentences} ${persona.maxSentences === 1 ? "sentence" : "sentences"}`} hint="Short replies keep the stream snappy and let more viewers get answered.">
              {() => <Slider label="Longest reply in sentences" value={persona.maxSentences} min={1} max={6} onChange={(v) => set("maxSentences", v)} />}
            </Field>
          </Tabs.Content>

          <Tabs.Content value="voice" className={s.panel}>
            <VoiceTab voice={voice} onChange={setVoice} />
          </Tabs.Content>

          <Tabs.Content value="look" className={s.panel}>
            <Field label="On stage">
              {() => (
                <Segmented
                  label="Character style"
                  value={persona.look.character}
                  onChange={(character) => setLook({ character })}
                  options={[
                    { value: "orb", label: "Glowing character" },
                    { value: "voice-line", label: "Voice only" },
                  ]}
                />
              )}
            </Field>
            <div>
              <p className={s.subhead}>Palettes</p>
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
              <Field label="Glow" error={errors["look.primary"]}>
                {(props) => <ColorField id={props.id} label="Glow" value={persona.look.primary} onChange={(primary) => setLook({ primary })} />}
              </Field>
              <Field label="Accent" error={errors["look.secondary"]}>
                {(props) => <ColorField id={props.id} label="Accent" value={persona.look.secondary} onChange={(secondary) => setLook({ secondary })} />}
              </Field>
              <Field label="Water" error={errors["look.background"]}>
                {(props) => <ColorField id={props.id} label="Water" value={persona.look.background} onChange={(background) => setLook({ background })} />}
              </Field>
            </div>
          </Tabs.Content>

          <Tabs.Content value="show" className={s.panel}>
            <p className={s.note}>Segments shape the show when chat is quiet. The host moves to the next one when its time is up, and you can switch any time from the studio.</p>
            <SegmentEditor segments={persona.segments} onChange={(segments) => set("segments", segments)} errors={errors} />
          </Tabs.Content>

          <Tabs.Content value="rules" className={s.panel}>
            <Panel raised className={s.builtIn}>
              <h3>Always on, for every host</h3>
              <ul>
                <li>Says it's an AI whenever someone asks.</li>
                <li>Never asks for gifts or promises anything for them.</li>
                <li>Every line is checked before it's said; anything unsafe is blocked.</li>
                <li>Ignores links, spam and messages trying to change its instructions.</li>
              </ul>
            </Panel>
            <Field label="Your rules" optional hint="Extra rules for this character. Example: never talk about other streamers. Press Enter after each one.">
              {(props) => <Chips {...props} values={persona.rules} onChange={(v) => set("rules", v)} max={12} maxLength={200} placeholder="Add a rule" />}
            </Field>
          </Tabs.Content>
        </Tabs.Root>
      </div>

      <aside className={s.preview} aria-label="Preview">
        <CharacterPreview name={persona.name || channel.name} look={persona.look} line={line} />
        <div className={s.tryLine}>
          <p className={s.subhead} id="try-heading">
            Try a line
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
