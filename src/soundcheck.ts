// Sound Check: MyGo evens out how loud songs play, when its switch for it is
// on, by each stream's gain and peak. Apple measures every variant of a
// song, and writes it in its MP4's header (helper/loudness.go): its
// integrated loudness, in LKFS, and its true peak. amhelper reads it from the
// very file the app plays.
//
// MyGo's player (internal/player/player.go, normGain, as of 0.1.22) plays a
// stream at 10^((gain + 4) / 20) of its level, the 4 dB being its preamp over
// ReplayGain's, and never above 1 / peak. To bring every song to -16 LKFS,
// where Apple Music's Sound Check plays them, the gain is -20 - LKFS. The
// peak is only to keep a lift from clipping, as Sound Check does, so it's
// given only for a song lifted, and no higher than full scale: a quiet song
// whose true peak passes it isn't turned down for that, nor is a loud one,
// turned down already, turned down further. A song that says nothing plays
// as it is.

/** How loud a song is, as its file's header says: 0 for what it doesn't say. */
export interface Loudness {
  lkfs?: number;
  /** Linear: 1 is full scale. */
  peak?: number;
}

/** How loud Sound Check plays every song. */
const TARGET_LKFS = -16;
/** What MyGo's player lifts every gain by. */
const PREAMP = 4;

/** The stream's gain and peak, in MyGo's terms, that bring the song to TARGET_LKFS. */
export function soundCheck(l: Loudness | undefined): { gain?: number; peak?: number } {
  if (!l?.lkfs) return {};
  const lift = TARGET_LKFS - l.lkfs;
  // Without a peak, a gain of 0 would say nothing at all, and lose the
  // preamp's 4 dB: a hundredth of a dB under it says the same.
  const gain = Math.round((lift - PREAMP) * 100) / 100 || -0.01;
  if (lift <= 0 || !l.peak) return { gain };
  return { gain, peak: Math.min(l.peak, 1) };
}
