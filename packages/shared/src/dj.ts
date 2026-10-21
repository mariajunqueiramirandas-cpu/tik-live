import { z } from "zod";

/**
 * The automatic DJ (ADR-0045): real recorded electronic and dance tracks the
 * stage plays one after another, under the host's voice, for as long as the
 * host is on the air. Every track is by Kevin MacLeod (incompetech.com),
 * released under Creative Commons Attribution 4.0, which allows commercial
 * use and streaming as long as the music is credited: the stage shows each
 * track's credit while it plays.
 *
 * The server fetches a track from `upstream` once, keeps it on disk and
 * serves it to its own stages (`/api/stage/:stageKey/dj/:id`), so the files
 * never have to come from incompetech.com at play time, and the stage's
 * audio stays same-origin (WebAudio can mix it and the broadcast can tap it).
 */
export interface DjTrack {
  /** Stable id: what stages, the studio and the cache use. */
  id: string;
  title: string;
  artist: string;
  /** Length as published; the runtime moves on a little before it. */
  seconds: number;
  bpm: number;
  /** Where the server fetches the file. Never sent to stages. */
  upstream: string;
}

export const DJ_ARTIST = "Kevin MacLeod";
export const DJ_LICENSE = { name: "CC BY 4.0", url: "https://creativecommons.org/licenses/by/4.0/" } as const;

const INCOMPETECH = "https://incompetech.com/music/royalty-free/mp3-royaltyfree/";

const track = (id: string, title: string, seconds: number, bpm: number, file = `${title}.mp3`): DjTrack => ({
  id,
  title,
  artist: DJ_ARTIST,
  seconds,
  bpm,
  upstream: INCOMPETECH + encodeURIComponent(file),
});

/** Upbeat electronica, house and disco: 34 tracks, about two hours before anything repeats. */
export const DJ_CATALOG: readonly DjTrack[] = [
  track("voxel-revolution", "Voxel Revolution", 130, 122),
  track("raving-energy", "Raving Energy", 268, 122),
  track("brain-dance", "Brain Dance", 215, 124),
  track("ethernight-club", "Ethernight Club", 306, 117),
  track("newer-wave", "Newer Wave", 175, 110),
  track("rising-tide-faster", "Rising Tide (faster)", 241, 122),
  track("laserpack", "Laserpack", 186, 128),
  track("getting-it-done", "Getting it Done", 210, 135),
  track("desert-of-lost-souls", "Desert of Lost Souls", 181, 134),
  track("go-cart", "Go Cart", 213, 115),
  track("new-friendly", "New Friendly", 169, 114),
  track("electrodoodle", "Electrodoodle", 166, 120),
  track("latin-industries", "Latin Industries", 201, 122),
  track("cut-and-dry", "Cut and Dry", 222, 122),
  track("cipher", "Cipher", 231, 150, "Cipher2.mp3"),
  track("presenterator", "Presenterator", 256, 130),
  track("show-your-moves", "Show Your Moves", 215, 136),
  track("blipotron", "Blipotron", 149, 124),
  track("double-o", "Double O", 235, 140),
  track("klockworx", "Klockworx", 242, 130),
  track("future-cha-cha", "Future Cha Cha", 278, 140),
  track("hypnothis", "Hypnothis", 283, 104),
  track("werq", "Werq", 162, 125),
  track("realizer", "Realizer", 310, 125),
  track("disco-medusae", "Disco Medusae", 221, 115),
  track("who-likes-to-party", "Who Likes to Party", 257, 117),
  track("overcast", "Overcast", 228, 120),
  track("ether-disco", "Ether Disco", 176, 120),
  track("aerosol-of-my-love", "Aerosol of my Love", 142, 100),
  track("deep-and-dirty", "Deep and Dirty", 442, 140),
  track("beauty-flow", "Beauty Flow", 433, 108),
  track("blown-away", "Blown Away", 226, 170),
  track("cruising-for-goblins", "Cruising for Goblins", 149, 155),
  track("galactic-rap", "Galactic Rap", 142, 120),
];

const BY_ID = new Map(DJ_CATALOG.map((t) => [t.id, t]));

export function djTrack(id: string): DjTrack | undefined {
  return BY_ID.get(id);
}

/** The credit CC BY asks for, short enough for the stage: title, author, source and license. */
export function djCredit(track: Pick<DjTrack, "artist">): string {
  return `${track.artist} (incompetech.com) · ${DJ_LICENSE.name}`;
}

/** A DJ track as a stage gets it: what to show and where to fetch it. */
export const djStageTrackSchema = z.object({
  id: z.string().max(60),
  title: z.string().max(80),
  artist: z.string().max(60),
  credit: z.string().max(120),
  /** Same-origin path to the audio file. */
  url: z.string().max(200),
  seconds: z.number().min(1).max(3600),
});
export type DjStageTrack = z.infer<typeof djStageTrackSchema>;
