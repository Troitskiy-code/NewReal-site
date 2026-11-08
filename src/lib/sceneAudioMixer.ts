import { SCENE_MOOD_TAKES, sceneMusicSrc, type SceneBed, type SceneMood } from "./sceneMusicShared";

const CROSSFADE_S = 4;
const BED_FADE_S = 1.5;
/** Speech and dictation stay in front: the scene sound drops this far while a voice plays. */
const SPEECH_DUCK = 0.3;

type Channel = { el: HTMLAudioElement; gain: GainNode | null; level: number };

function element(loop: boolean) {
  const el = new Audio();
  el.loop = loop;
  el.preload = "none";
  el.setAttribute("playsinline", "");
  return el;
}

/**
 * Music crossfades between two players; the place bed plays on a third. Levels go through Web Audio gain
 * nodes because iOS Safari ignores HTMLMediaElement.volume. Without Web Audio the element volume is used.
 */
export class SceneAudioMixer {
  private ctx: AudioContext | null = null;
  private musicBus: GainNode | null = null;
  private bedBus: GainNode | null = null;
  private readonly music: [Channel, Channel] = [{ el: element(false), gain: null, level: 0 }, { el: element(false), gain: null, level: 0 }];
  private readonly bed: Channel = { el: element(true), gain: null, level: 0 };
  private active = 0;
  private mood: SceneMood | null = null;
  private take: string | null = null;
  private bedName: SceneBed | null = null;
  private musicLevel = 0;
  private bedLevel = 0;
  private ducked = false;
  private muted = false;
  private hidden = false;
  private readonly fadeTimers = new Set<ReturnType<typeof setTimeout>>();

  constructor(private readonly onPlayingChange: (playing: boolean) => void) {
    for (const [i, channel] of this.music.entries()) channel.el.addEventListener("ended", () => { if (i === this.active) this.nextTake(); });
    for (const channel of [...this.music, this.bed]) {
      channel.el.addEventListener("playing", () => this.reportPlaying());
      channel.el.addEventListener("pause", () => this.reportPlaying());
    }
  }

  get currentMood() { return this.mood; }

  /** Builds the audio graph inside a user gesture, which also unlocks playback on mobile browsers. */
  unlock() {
    const Context = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!this.ctx && Context) {
      try {
        const ctx = new Context();
        const musicBus = ctx.createGain(), bedBus = ctx.createGain();
        musicBus.connect(ctx.destination);
        bedBus.connect(ctx.destination);
        for (const [channel, bus] of [[this.music[0], musicBus], [this.music[1], musicBus], [this.bed, bedBus]] as const) {
          channel.gain = ctx.createGain();
          channel.gain.gain.value = channel.level;
          ctx.createMediaElementSource(channel.el).connect(channel.gain).connect(bus);
        }
        this.ctx = ctx; this.musicBus = musicBus; this.bedBus = bedBus;
      } catch { this.ctx = null; }
    }
    void this.ctx?.resume().catch(() => {});
    this.applyBuses();
    this.resume();
  }

  setLevels(music: number, bed: number) {
    const musicWasOff = this.musicLevel <= 0;
    this.musicLevel = music; this.bedLevel = bed;
    this.applyBuses();
    // Music stopped by a zero level fades back in with a fresh take of the current theme.
    if (music <= 0) this.stopMusic(); else if (musicWasOff && this.mood) this.switchTake(); else this.resume();
    if (bed <= 0) this.bed.el.pause(); else this.resume();
  }

  setDucked(ducked: boolean) { this.ducked = ducked; this.applyBuses(); }
  setMuted(muted: boolean) { this.muted = muted; this.applyBuses(); }

  setHidden(hidden: boolean) {
    this.hidden = hidden;
    if (hidden) for (const channel of [...this.music, this.bed]) channel.el.pause();
    else this.resume();
  }

  playMood(mood: SceneMood | null) {
    if (mood === this.mood) return;
    this.mood = mood;
    if (!mood) { this.stopMusic(); return; }
    this.switchTake();
  }

  setBed(bed: SceneBed | null) {
    if (bed === this.bedName) return;
    this.bedName = bed;
    const channel = this.bed;
    this.fade(channel, 0, BED_FADE_S, () => {
      if (this.bedName !== bed) return;
      if (!bed) { channel.el.pause(); return; }
      channel.el.src = `/ambience/${bed}.mp3`;
      this.fade(channel, 1, BED_FADE_S);
      this.start(channel, this.bedLevel);
    });
  }

  dispose() {
    for (const timer of this.fadeTimers) clearTimeout(timer);
    for (const channel of [...this.music, this.bed]) { channel.el.pause(); channel.el.removeAttribute("src"); channel.el.load(); }
    void this.ctx?.close().catch(() => {});
  }

  private switchTake() {
    if (!this.mood) return;
    const takes = SCENE_MOOD_TAKES[this.mood];
    const choices = takes.length > 1 ? takes.filter(take => take !== this.take) : takes;
    this.take = choices[Math.floor(Math.random() * choices.length)];
    const outgoing = this.music[this.active];
    this.active = 1 - this.active;
    const incoming = this.music[this.active];
    incoming.el.src = sceneMusicSrc(this.mood, this.take);
    incoming.el.currentTime = 0;
    this.setGain(incoming, 0);
    this.start(incoming, this.musicLevel);
    this.fade(incoming, 1, CROSSFADE_S);
    this.fade(outgoing, 0, CROSSFADE_S, () => outgoing.el.pause());
  }

  /** A theme continues with another take of the same mood when a track ends. */
  private nextTake() {
    if (this.mood && this.musicLevel > 0) this.switchTake();
  }

  private stopMusic() {
    for (const channel of this.music) this.fade(channel, 0, 1, () => channel.el.pause());
  }

  private resume() {
    if (this.hidden) return;
    const music = this.music[this.active];
    if (this.mood && music.el.getAttribute("src")) this.start(music, this.musicLevel);
    if (this.bedName && this.bed.el.getAttribute("src")) this.start(this.bed, this.bedLevel);
  }

  private start(channel: Channel, level: number) {
    if (this.hidden || level <= 0 || !channel.el.paused) return;
    // Autoplay can be refused until the next gesture; unlock() retries.
    void channel.el.play().catch(() => {});
  }

  private busValue(level: number) {
    // Squared slider position follows loudness perception better than a linear gain.
    return this.muted ? 0 : level * level * (this.ducked ? SPEECH_DUCK : 1);
  }

  private applyBuses() {
    const music = this.busValue(this.musicLevel), bed = this.busValue(this.bedLevel);
    if (this.ctx && this.musicBus && this.bedBus) {
      const now = this.ctx.currentTime;
      this.musicBus.gain.setTargetAtTime(music, now, 0.15);
      this.bedBus.gain.setTargetAtTime(bed, now, 0.15);
    }
    for (const channel of this.music) this.applyElementVolume(channel, music);
    this.applyElementVolume(this.bed, bed);
  }

  private applyElementVolume(channel: Channel, bus: number) {
    if (!this.ctx) channel.el.volume = Math.max(0, Math.min(1, bus * channel.level));
  }

  private setGain(channel: Channel, level: number) {
    channel.level = level;
    if (channel.gain && this.ctx) {
      channel.gain.gain.cancelScheduledValues(this.ctx.currentTime);
      channel.gain.gain.setValueAtTime(level, this.ctx.currentTime);
    }
    this.applyElementVolume(channel, this.busValue(channel === this.bed ? this.bedLevel : this.musicLevel));
  }

  private fade(channel: Channel, to: number, seconds: number, done?: () => void) {
    channel.level = to;
    if (channel.gain && this.ctx) {
      const now = this.ctx.currentTime, param = channel.gain.gain;
      param.cancelScheduledValues(now);
      param.setValueAtTime(param.value, now);
      param.linearRampToValueAtTime(to, now + seconds);
    } else {
      this.applyElementVolume(channel, this.busValue(channel === this.bed ? this.bedLevel : this.musicLevel));
    }
    if (done) {
      const timer = setTimeout(() => { this.fadeTimers.delete(timer); if (channel.level === to) done(); }, seconds * 1000);
      this.fadeTimers.add(timer);
    }
  }

  private reportPlaying() {
    this.onPlayingChange([...this.music, this.bed].some(channel => !channel.el.paused));
  }
}
