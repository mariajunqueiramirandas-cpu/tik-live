import { PRESETS, tiktokHandleSchema } from "@tik-live/shared";
import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { CharacterPreview, type PreviewLine } from "../components/CharacterPreview";
import { HostSwatch } from "../components/Brand";
import { ApiError } from "../lib/api";
import { useCreateChannel } from "../lib/query";
import { Button, ButtonLink } from "../ui/Button";
import { Banner } from "../ui/Display";
import { Field, Input, PrefixedInput, Segmented } from "../ui/Field";
import { toast } from "../ui/toast-store";
import p from "./page.module.css";
import s from "./new-host.module.css";

function introFor(index: number): PreviewLine {
  const preset = PRESETS[index] ?? PRESETS[0]!;
  const { name, tagline, catchphrases } = preset.persona;
  return { text: `Hi, I'm ${name}, ${tagline}. ${catchphrases[0] ?? ""}`.trim(), emotion: "happy", nonce: Date.now() };
}

export default function NewHost() {
  const navigate = useNavigate();
  const create = useCreateChannel();
  const [presetIndex, setPresetIndex] = useState(0);
  const preset = PRESETS[presetIndex] ?? PRESETS[0]!;
  const [name, setName] = useState(preset.persona.name);
  const [nameEdited, setNameEdited] = useState(false);
  const [where, setWhere] = useState<"practice" | "tiktok">("practice");
  const [handle, setHandle] = useState("");
  const [line, setLine] = useState<PreviewLine | null>(() => introFor(0));
  const [error, setError] = useState<{ field: "name" | "handle" | "form"; message: string } | null>(null);

  const pick = (index: number) => {
    setPresetIndex(index);
    if (!nameEdited) setName(PRESETS[index]?.persona.name ?? "");
    setLine(introFor(index));
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    if (!name.trim()) return setError({ field: "name", message: "Give your host a name." });
    let tiktokUsername: string | null = null;
    if (where === "tiktok") {
      const parsed = tiktokHandleSchema.safeParse(handle);
      if (!parsed.success) return setError({ field: "handle", message: "That doesn't look like a TikTok handle. Use letters, numbers, dots and underscores." });
      tiktokUsername = parsed.data;
    }
    try {
      const channel = await create.mutateAsync({ name: name.trim(), tiktokUsername, presetId: preset.id });
      toast.success(`${channel.name} is ready`, where === "practice" ? "Press Go live to try it in practice mode." : "Set up OBS next, then go live.");
      void navigate(where === "practice" ? `/app/hosts/${channel.id}` : `/app/hosts/${channel.id}/setup`, { viewTransition: true });
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "Couldn't create the host. Try again.";
      setError({ field: "form", message });
    }
  };

  return (
    <div className={p.page}>
      <header className={p.header}>
        <div>
          <h1>Create a host</h1>
          <p className={p.lede}>Start from a character and make it yours later. Nothing goes live until you press Go live.</p>
        </div>
      </header>

      <div className={s.layout}>
        <form className={s.form} onSubmit={submit} noValidate>
          <fieldset className={s.step}>
            <legend className={s.legend}>
              <span className={s.stepNumber}>1</span> Pick a character
            </legend>
            <div className={s.presets} role="radiogroup" aria-label="Character">
              {PRESETS.map((option, i) => (
                <button
                  key={option.id}
                  type="button"
                  role="radio"
                  aria-checked={i === presetIndex}
                  className={s.preset}
                  onClick={() => pick(i)}
                  onKeyDown={(e) => {
                    if (e.key === "ArrowDown" || e.key === "ArrowRight") {
                      e.preventDefault();
                      pick((i + 1) % PRESETS.length);
                      (e.currentTarget.nextElementSibling as HTMLElement | null ?? e.currentTarget.parentElement?.firstElementChild as HTMLElement | null)?.focus();
                    } else if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
                      e.preventDefault();
                      pick((i - 1 + PRESETS.length) % PRESETS.length);
                      (e.currentTarget.previousElementSibling as HTMLElement | null ?? e.currentTarget.parentElement?.lastElementChild as HTMLElement | null)?.focus();
                    }
                  }}
                  tabIndex={i === presetIndex ? 0 : -1}
                >
                  <HostSwatch look={option.persona.look} size={44} />
                  <span className={s.presetText}>
                    <span className={s.presetName}>{option.persona.name}</span>
                    <span className={s.presetPitch}>{option.pitch}</span>
                  </span>
                </button>
              ))}
            </div>
          </fieldset>

          <fieldset className={s.step}>
            <legend className={s.legend}>
              <span className={s.stepNumber}>2</span> Name it
            </legend>
            <Field label="Name" hint="Viewers will hear and see this name." error={error?.field === "name" ? error.message : null} count={{ value: name.length, max: 32 }}>
              {(props) => (
                <Input
                  {...props}
                  value={name}
                  maxLength={32}
                  autoComplete="off"
                  onChange={(e) => {
                    setName(e.target.value);
                    setNameEdited(true);
                  }}
                />
              )}
            </Field>
          </fieldset>

          <fieldset className={s.step}>
            <legend className={s.legend}>
              <span className={s.stepNumber}>3</span> Choose where it listens
            </legend>
            <Segmented
              label="Where the host listens"
              value={where}
              onChange={setWhere}
              options={[
                { value: "practice", label: "Practice first" },
                { value: "tiktok", label: "My TikTok LIVE" },
              ]}
            />
            {where === "practice" ? (
              <p className={s.note}>Practice mode fills the room with simulated viewers so you can watch the host work. Switch to TikTok whenever you're ready.</p>
            ) : (
              <Field label="TikTok handle" hint="The account that goes live. The host reads that stream's chat, gifts and follows." error={error?.field === "handle" ? error.message : null}>
                {(props) => <PrefixedInput {...props} prefix="@" value={handle} onChange={(e) => setHandle(e.target.value)} autoComplete="off" spellCheck={false} placeholder="yourhandle" />}
              </Field>
            )}
          </fieldset>

          {error?.field === "form" && (
            <Banner tone="error" title="Couldn't create the host" action={error.message.includes("plan") ? <ButtonLink to="/app/billing" size="sm">See plans</ButtonLink> : undefined}>
              {error.message}
            </Banner>
          )}

          <div className={s.submit}>
            <Button type="submit" variant="primary" size="lg" busy={create.isPending}>
              Create host
            </Button>
          </div>
        </form>

        <aside className={s.preview} aria-label="Preview">
          <CharacterPreview name={name || preset.persona.name} look={preset.persona.look} line={line} />
          <Button size="sm" variant="ghost" onClick={() => setLine(introFor(presetIndex))}>
            Hear the intro again
          </Button>
        </aside>
      </div>
    </div>
  );
}
