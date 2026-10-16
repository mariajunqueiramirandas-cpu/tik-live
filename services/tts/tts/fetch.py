"""Downloads Pocket TTS's Portuguese model and voices, checking every file's sha256.

  python -m tts.fetch <dir>      -> <dir>/model.safetensors, tokenizer.json, embeddings/*.safetensors

Kyutai's weights and voice states (CC-BY-4.0), at a pinned revision of
huggingface.co/kyutai/pocket-tts-without-voice-cloning. The voices are states the model computed
from recordings, each under its recording's license (huggingface.co/kyutai/tts-voices): `cosette`
(Expresso) and `jean` (EARS) are non-commercial, so they aren't fetched.
"""

from __future__ import annotations

import hashlib
import sys
import urllib.request
from pathlib import Path

REPO = "kyutai/pocket-tts-without-voice-cloning"
REVISION = "4e1e0a3e611c51c0b4ed8174fc10f32a54644303"
PREFIX = "languages/portuguese"
FILES = {
    "model.safetensors": "982369b35c9fce8e8beb027f76c5d15dc0936851d8cb66f75d9678e0e6772b41",
    "tokenizer.json": "b33e269f7f042a763080d71ba087d74d2f6759674b238a723c028e436b1a25ab",
}
# name -> (sha256, the recording it comes from)
VOICES = {
    "rafael": ("47a1b9490c6c7b395260682d2cc8a3542e9544a9c3bd1058808e4af9d522bf7f", "pt, Kyutai's Portuguese voice"),
    "alba": ("337a0e9bb5205b523d1e680c99c48fca6bc7486b26b3fa4fdcf4c5f32a13949f", "en, Alba MacKenna, CC-BY-4.0"),
    "anna": ("f7a69da353beb3908d3737fb2a86f831d4ba296a7d826cd530b3b7f04159075b", "en, VCTK, CC-BY-4.0"),
    "azelma": ("fa2cee9221368e684641a224e5ec238f839160d23cde05c58ae561fa33609fd1", "en, VCTK, CC-BY-4.0"),
    "bill_boerst": ("6dd294e778ba443fd481cb87cc49a7e770ef5f7041a04a8d2de10e2207da3c42", "en, Voice-Zero, CC0"),
    "caro_davy": ("12054caabca360c6538aaeaeabb6be39eb1d440b02ac3e5ce93bf0a8220bf562", "en, Voice-Zero, CC0"),
    "charles": ("dab71ba1121ff5a8575a9b7bd829010e46fb75a61bd2ec1d818cd7d8d42087a2", "en, VCTK, CC-BY-4.0"),
    "daan": ("ca80d74eaf8d65c7a9b434329a0d6a61caa80dc3518d0fbbab6a06fe2b3b936b", "nl, CML-TTS, CC-BY-4.0"),
    "eponine": ("56d347aaea3bc7c2d6b20a58d2ec4bc23e49c238384d0a1cfb999734c29ce826", "en, VCTK, CC-BY-4.0"),
    "estelle": ("055638cf4721cd21f62247d75c09183979b7954f06e8657729f2506169f0856f", "fr, Kyutai's recording, CC0"),
    "eve": ("f4d9b46831bb003fa6ba2d21d49044a2d73a2b145931aebf52fa6ea090e6ae60", "en, VCTK, CC-BY-4.0"),
    "fantine": ("e7a1771a0a83afc1fd7385d810bf04e9225c9f6d6426534e8fb64e84ea9217c2", "en, VCTK, CC-BY-4.0"),
    "george": ("2164bd0684f1a612874b6667b32d410a33b04ff3ce3ee69ec292bd835b8187ff", "en, VCTK, CC-BY-4.0"),
    "giovanni": ("21a5c183ee3494d18029e5087fbda7741c56c9aebf2d435e7a9705da2a32d51b", "it, Common Voice, CC0"),
    "jane": ("d04d7e5d6b849aa9cfe12ec94509b2ddbad02c39a2a7e5950c748dce61e7f3a0", "en, VCTK, CC-BY-4.0"),
    "javert": ("4f054e75036cd3bc8d345530f45f60b787ef916891d8438ac0d0dcec18522376", "en, Unmute voice donation, CC0"),
    "juergen": ("88b13829b7899801d1fe1e7d94843227cab6a95eed42150d14a4f8a7072e5dce", "de, Kyutai's German voice"),
    "lola": ("9a004770f945793807eaa5a699b0ff101d84f4a4b3928110555128396a9d359d", "es, Common Voice, CC0"),
    "marius": ("5bc4544624f8b7a035062b1e47af27f3c0c71e6be0f9bfc00d9e380ff52cd59f", "en, Unmute voice donation, CC0"),
    "mary": ("099e37e334671245a2fd83554febfa9151e25e78be589e1ca60e73208a86c10d", "en, VCTK, CC-BY-4.0"),
    "michael": ("06dec20e9a9bf048ae7856b69919262ee026f3f73c8891f19c48d6bc7ee76dc0", "en, VCTK, CC-BY-4.0"),
    "paul": ("4f0be51bf36581a53bcf333135b31fa6d1739f51f1a9ac5b8e5669c61b89eca6", "en, VCTK, CC-BY-4.0"),
    "peter_yearsley": ("fe16cdb4814dd439a24a5d1f921162a1bd72d7e8af1242e7338f98254a08a135", "en, Voice-Zero, CC0"),
    "stuart_bell": ("e861799f1e380f1c27f0f61f662b80ea2730af13ad26cc4cbbc92d084058bd78", "en, Voice-Zero, CC0"),
    "vera": ("ca84b449f59af516b7bb950d13f2ae43e3d632d9bff42da04bf2b93298c64eca", "en, VCTK, CC-BY-4.0"),
}


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        while chunk := f.read(1 << 20):
            h.update(chunk)
    return h.hexdigest()


def download(url: str, dst: Path, digest: str) -> None:
    if dst.exists() and sha256(dst) == digest:
        return
    tmp = dst.with_suffix(dst.suffix + ".part")
    h = hashlib.sha256()
    with urllib.request.urlopen(url, timeout=60) as r, tmp.open("wb") as f:
        while chunk := r.read(1 << 20):
            h.update(chunk)
            f.write(chunk)
    if h.hexdigest() != digest:
        tmp.unlink()
        sys.exit(f"{dst.name}: sha256 {h.hexdigest()} != pinned {digest}")
    tmp.rename(dst)
    print(f"fetched {dst.name}")


def main(out_dir: str) -> None:
    out = Path(out_dir)
    (out / "embeddings").mkdir(parents=True, exist_ok=True)
    base = f"https://huggingface.co/{REPO}/resolve/{REVISION}/{PREFIX}"
    for name, digest in FILES.items():
        download(f"{base}/{name}", out / name, digest)
    for name, (digest, _) in VOICES.items():
        download(f"{base}/embeddings/{name}.safetensors", out / "embeddings" / f"{name}.safetensors", digest)


if __name__ == "__main__":
    main(sys.argv[1])
