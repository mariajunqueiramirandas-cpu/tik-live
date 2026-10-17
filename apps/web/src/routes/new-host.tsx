import { PRESETS, tiktokHandleSchema } from "@tik-live/shared";
import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { CharacterPreview, type PreviewLine } from "../components/CharacterPreview";
import { HostSwatch } from "../components/Brand";
import { ApiError } from "../lib/api";
import { useCreateChannel } from "../lib/query";
import { browserTimeZone } from "../lib/timezone";
import { Button, ButtonLink } from "../ui/Button";
import { Banner } from "../ui/Display";
import { Field, Input, PrefixedInput, Segmented } from "../ui/Field";
import { toast } from "../ui/toast-store";
import p from "./page.module.css";
import s from "./new-host.module.css";

function introFor(index: number): PreviewLine {
  const preset = PRESETS[index] ?? PRESETS[0]!;
  const { name, tagline, catchphrases } = preset.persona;
  return { text: `Oi, eu sou ${name}, ${tagline}. ${catchphrases[0] ?? ""}`.trim(), emotion: "happy", nonce: Date.now() };
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
    if (!name.trim()) return setError({ field: "name", message: "Dê um nome ao seu apresentador." });
    let tiktokUsername: string | null = null;
    if (where === "tiktok") {
      const parsed = tiktokHandleSchema.safeParse(handle);
      if (!parsed.success) return setError({ field: "handle", message: "Isso não parece um usuário do TikTok. Use letras, números, pontos e sublinhados." });
      tiktokUsername = parsed.data;
    }
    try {
      const timezone = browserTimeZone();
      const channel = await create.mutateAsync({ name: name.trim(), tiktokUsername, presetId: preset.id, ...(timezone ? { timezone } : {}) });
      toast.success(`Tudo pronto com ${channel.name}`, where === "practice" ? "Aperte Entrar ao vivo para testar no modo de treino." : "Agora configure o OBS e entre ao vivo.");
      void navigate(where === "practice" ? `/app/hosts/${channel.id}` : `/app/hosts/${channel.id}/setup`, { viewTransition: true });
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "Não deu para criar o apresentador. Tente de novo.";
      setError({ field: "form", message });
    }
  };

  return (
    <div className={p.page}>
      <header className={p.header}>
        <div>
          <h1>Criar apresentador</h1>
          <p className={p.lede}>Comece com um personagem e deixe do seu jeito depois. Nada vai ao ar até você apertar Entrar ao vivo.</p>
        </div>
      </header>

      <div className={s.layout}>
        <form className={s.form} onSubmit={submit} noValidate>
          <fieldset className={s.step}>
            <legend className={s.legend}>
              <span className={s.stepNumber}>1</span> Escolha um personagem
            </legend>
            <div className={s.presets} role="radiogroup" aria-label="Personagem">
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
              <span className={s.stepNumber}>2</span> Dê um nome
            </legend>
            <Field label="Nome" hint="Os espectadores vão ver e ouvir esse nome." error={error?.field === "name" ? error.message : null} count={{ value: name.length, max: 32 }}>
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
              <span className={s.stepNumber}>3</span> Escolha onde ele escuta
            </legend>
            <Segmented
              label="Onde o apresentador escuta"
              value={where}
              onChange={setWhere}
              options={[
                { value: "practice", label: "Treinar primeiro" },
                { value: "tiktok", label: "Minha TikTok LIVE" },
              ]}
            />
            {where === "practice" ? (
              <p className={s.note}>O modo de treino enche a sala com uma plateia simulada para você ver o apresentador em ação. Mude para o TikTok quando quiser.</p>
            ) : (
              <Field label="Usuário do TikTok" hint="A conta que faz a live. O apresentador lê o chat, os presentes e os novos seguidores dela." error={error?.field === "handle" ? error.message : null}>
                {(props) => <PrefixedInput {...props} prefix="@" value={handle} onChange={(e) => setHandle(e.target.value)} autoComplete="off" spellCheck={false} placeholder="seuusuario" />}
              </Field>
            )}
          </fieldset>

          {error?.field === "form" && (
            <Banner tone="error" title="Não deu para criar o apresentador" action={error.message.includes("plan") ? <ButtonLink to="/app/billing" size="sm">Ver planos</ButtonLink> : undefined}>
              {error.message}
            </Banner>
          )}

          <div className={s.submit}>
            <Button type="submit" variant="primary" size="lg" busy={create.isPending}>
              Criar apresentador
            </Button>
          </div>
        </form>

        <aside className={s.preview} aria-label="Prévia">
          <CharacterPreview name={name || preset.persona.name} look={preset.persona.look} line={line} />
          <Button size="sm" variant="ghost" onClick={() => setLine(introFor(presetIndex))}>
            Ouvir a apresentação de novo
          </Button>
        </aside>
      </div>
    </div>
  );
}
