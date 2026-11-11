// Shared data model (spec §8). The planner, editor, renderer and storage all speak these types.

export type Aspect = "16:9" | "9:16" | "1:1" | "4:5" | "21:9";
export const ASPECTS: Record<Aspect, number> = { "16:9": 16 / 9, "9:16": 9 / 16, "1:1": 1, "4:5": 4 / 5, "21:9": 21 / 9 };
export type Fps = 24 | 30 | 60;
export type OutHeight = 720 | 1080 | 1440 | 2160;

export type TreatmentId =
  | "hold" | "push" | "pull" | "pan" | "sweep" | "tour"
  | "depthPush" | "arc" | "crane" | "inflate" | "dollyZoom" | "focusPull";
export const TREATMENTS: TreatmentId[] = ["hold", "push", "pull", "pan", "sweep", "tour", "depthPush", "arc", "crane", "inflate", "dollyZoom", "focusPull"];
export const TREATMENT_NAMES: Record<TreatmentId, string> = {
  hold: "Hold", push: "Push in", pull: "Pull out", pan: "Pan", sweep: "Group sweep", tour: "Tour",
  depthPush: "Depth push", arc: "Arc", crane: "Crane", inflate: "Inflate", dollyZoom: "Dolly zoom", focusPull: "Focus pull",
};
/** Treatments that need a depth map; the planner only offers them when depth has arrived. */
export const DEPTH_TREATMENTS = new Set<TreatmentId>(["depthPush", "arc", "crane", "inflate", "dollyZoom", "focusPull"]);

export type TransitionId = "cut" | "crossfade" | "dipBlack" | "dipWhite" | "depthWipe" | "flyThrough" | "matchCut" | "push" | "whip" | "scan" | "morph";
export const TRANSITION_NAMES: Record<TransitionId, string> = {
  cut: "Cut", crossfade: "Crossfade", dipBlack: "Dip to black", dipWhite: "Dip to white", depthWipe: "Depth wipe",
  flyThrough: "Fly-through", matchCut: "Match cut", push: "Push", whip: "Whip", scan: "Scan reveal", morph: "Morph",
};
export type FillId = "cover" | "pair" | "extend" | "tilt" | "blur";
export type LookId = "photo" | "engraving" | "topo" | "thermal" | "hologram";
export type OrderMode = "time" | "story" | "manual" | "shuffle";
export type FitMode = "show-to-music" | "music-to-show" | "free";
export type SlideKind = "photo" | "video" | "pair" | "grid" | "flipbook" | "title";
export type LockField = "items" | "position" | "dur" | "treatment" | "fill" | "look" | "transition" | "caption";

/** One camera keyframe (spec §9.1). `t` is the slide-relative time in [0, 1]. */
export interface CamKey { t: number; view: [number, number, number]; cam: [number, number, number]; f: number; ds: number }

export interface Treatment {
  id: TreatmentId;
  amount: number;                 // 0..1.5 scales the move's amplitude
  direction?: number;             // -1 | 1 for pans, orbits and sweeps
  keys: CamKey[];
  focus?: { t: number; d: number; amt: number }[];
  aim?: [number, number];
  k?: number;                     // look-at blend (0 plain move, 1 orbit)
  pivot?: number;                 // pivot inverse depth
  stops?: Box[];                  // tour stops (source pixels)
}

export interface Caption {
  text: string;
  position: "bottom" | "center" | "top";
  style: "plain" | "title" | "chapter";
  from?: number; to?: number;     // seconds within the slide; omitted = whole slide
}

export interface Slide {
  id: string;
  kind: SlideKind;
  items: string[];                // media hashes (title cards: none)
  start: number; dur: number;     // seconds on the show clock
  treatment: Treatment;
  fill: FillId;
  look: LookId; grade?: number;
  transitionIn: { type: TransitionId; dur: number };
  caption?: Caption;
  clip?: { in: number; out: number; speed: number; gain: number };
  locks: Partial<Record<LockField, true>>;
  auto: { reasons: string[]; alternates: Treatment[]; quality: "draft" | "full" };
  chapter?: number;
}

export interface SongRef { hash: string; trimIn: number; trimOut: number; gain: number; fadeIn: number; fadeOut: number }

export interface Project {
  v: 1;
  id: string; title: string; seed: number;
  created: number; updated: number;
  output: { aspect: Aspect; height: OutHeight; fps: Fps };
  styleId: string; styleOverrides: Partial<Style>;
  media: string[];
  excluded: string[]; starred: string[];
  featuredPerson?: string;
  order: OrderMode;
  songs: SongRef[];
  fit: FitMode;
  slides: Slide[];
  titles: { intro?: string; end?: string; chapters: boolean };
  generativeFill: "off" | "margins" | "all";
  beatSync: "off" | "cuts" | "cuts+accents";
  depthStrength: number;          // 0..1.5, scales 3D amplitude
}

export interface Style {
  id: string; name: string; blurb: string;
  pace: { base: number; min: number; max: number };
  treatmentWeights: Partial<Record<TreatmentId, number>>;
  transitionWeights: { minor: Partial<Record<TransitionId, number>>; major: Partial<Record<TransitionId, number>> };
  depthShare: number;
  depthAmount: number;
  generativeFill: "off" | "margins" | "all";
  beatSync: "off" | "cuts" | "cuts+accents";
  look: { default: LookId; mix?: Partial<Record<LookId, number>> };
  grade?: { film: number };
  titles: { font: string; animation: "fade" | "rise" | "type" };
  crossfade: number;              // seconds, for shows without music
  panSpeed: number;               // max pan speed, screen heights per second
  gridReveal?: boolean;
}

// ---------------------------------------------------------------- analysis results (inputs)

export type Box = [number, number, number, number]; // x0, y0, x1, y1 in source pixels

export interface FaceResult { box: Box; score: number; landmarks?: [number, number][]; eyesOpen?: number; smile?: number; embedding?: number[] }

export interface MediaInfo {
  hash: string;
  kind: "photo" | "video";
  name: string;
  w: number; h: number;           // after EXIF orientation
  duration?: number;              // video seconds
  taken?: number;                 // ms since epoch
  gps?: [number, number];
  bytes: number;
}

export interface BasicsResult {
  phash: string;                  // 16 hex chars (64 bits)
  sharpness: number;              // variance of Laplacian on a 256 px grey proxy
  exposure: number;               // mean luma 0..1
  contrast: number;               // luma std dev 0..1
  colorfulness: number;           // Hasler-Süsstrunk
  edgeDensity: number;            // share of strong edges, visual complexity
  clipped: { dark: number; bright: number }; // share of pixels near black / white
  flags: QualityFlag[];
}
export type QualityFlag = "blurry" | "dark" | "blown" | "screenshot" | "tiny";

export interface SaliencyResult { peaks: { box: Box; score: number }[]; center: [number, number] }

export interface MediaAnalysis {
  info: MediaInfo;
  basics?: BasicsResult;
  faces?: FaceResult[];
  saliency?: SaliencyResult;
  embedding?: number[];
  tags?: Record<string, number>;
  depth?: { available: true; sep: number; pivot: number; quality: number; range: [number, number] };
  personId?: string;              // identity cluster of the largest face
  videoScan?: VideoScan;
}

export interface VideoScan {
  fps: number;                    // samples per second
  samples: { t: number; faces: number; faceSize: number; motion: number; shake: number; sharpness: number; speech: number; rms: number }[];
}

export interface MusicAnalysis {
  v: 1;
  duration: number;
  sampleRate: number;
  tempo: number;
  tempoAlt: number;
  beats: number[];                // seconds
  downbeats: number[];            // seconds (subset of beats)
  beatsPerBar: 3 | 4;
  sections: { start: number; end: number; label: string; energy: "low" | "mid" | "high"; energyValue: number }[];
  energy: number[];               // one per beat, 0..1
  accents: number[];              // seconds: strong rises
  edges: { leadIn: number; fadeOut: number; trailing: number };
  loudness: number;               // LUFS-ish
  waveform: number[];             // peak envelope, ~ 10 per second, for the timeline
  offset: number;                 // user grid shift, seconds
}

export interface SongInfo { hash: string; name: string; duration: number; bytes: number }

// ---------------------------------------------------------------- timeline (render contract, §8.3)

export interface AssetRef { hash: string; kind: "image" | "video" | "maps" | "plate" }

export interface RenderSlide {
  id: string; t0: number; t1: number;
  w: number; h: number;           // source size, for the letterbox and camera
  assets: { image?: AssetRef; maps?: AssetRef; plate?: AssetRef; video?: AssetRef };
  keys: CamKey[];
  focus?: { t: number; d: number; amt: number }[];
  aim?: [number, number]; k?: number; pivot?: number;
  bounds?: [number, number, number, number];
  cover?: [boolean, boolean];
  look: number; fill: number; grade: number;
  enter?: { type: TransitionId; t0: number; t1: number; params?: Record<string, number> };
  cells?: { rect: [number, number, number, number]; slide: RenderSlide }[];
  clip?: { in: number; speed: number };
  title?: { text: string; sub?: string; style: Caption["style"]; animation: Style["titles"]["animation"] };
  accents?: number[];             // show-time beats to pulse on
}

export interface Envelope { points: [number, number][] } // [showTime, gain]

export interface AudioEvent { src: string; at: number; in: number; out: number; gain: Envelope; duck?: Envelope; kind: "song" | "clip" }

export interface CaptionEvent { t0: number; t1: number; text: string; position: Caption["position"]; style: Caption["style"]; slideId: string }

export interface Timeline {
  v: 1; dur: number; fps: number; size: [number, number]; aspect: number;
  layers: RenderSlide[];
  audio: AudioEvent[];
  captions: CaptionEvent[];
  beats: number[];                // show-time beats (for the pulse accent and the timeline UI)
}
