"""Background noise for the eval renderer (Phase 4 spec, WP10b).

A debrief script may carry `noise: { kind, snrDb }` (DebriefScript v2, WP10). render_debriefs.py
mixes that noise under the speech at the script's signal-to-noise ratio:

- `car`: brown noise, its power falling 6 dB an octave, rolled off below 20 Hz: road and engine
  rumble.
- `street`: pink noise, falling 3 dB an octave: broadband traffic.
- `cafe`: babble, 3 to 5 other Kokoro voices reading unrelated lines at once, over a pink floor
  10 dB down.

The SNR is the speech's power over the noise's, on the samples where the voice speaks (the turns'
spans), in dB. The noise runs through the pauses too, fading in and out over 50 ms, and stops
before the 1 s tail, which stays digital silence for the fake microphone's last buffer.

Everything is seeded from what the WAV's hash already covers (the voice, the speed, and the
turns) and the noise spec, so a render is reproducible and two scripts that sound the same get
the same noise; the script id, which the hash ignores, plays no part. NOISE_VERSION and the spec
join the hash (render_debriefs.render_hash): bump it whenever the noise changes for the same
spec, including the babble voices and lines below. numpy only, so no
new dependency. Recorded noise corpora (MUSAN, CC BY 4.0, 11 GB; OpenSLR 28, Apache-2.0, 1.3 GB)
stay optional and lab-only, never in CI.

The babble lines avoid dates, times, numbers, names, and anything a CRM would hold: a speech
model that hears a background talker shouldn't hand the extractor a value to propose.
"""

from __future__ import annotations

import hashlib
import math
from dataclasses import dataclass
from typing import Literal, Protocol

import numpy as np
from numpy.typing import NDArray

# Bump when the noise changes for the same spec; it's part of every noisy WAV's hash.
NOISE_VERSION = 1

type NoiseKind = Literal["car", "street", "cafe"]
NOISE_KINDS: tuple[NoiseKind, ...] = ("car", "street", "cafe")
MIN_SNR_DB = -10.0
MAX_SNR_DB = 60.0

FADE_MS = 50
BROWN_CORNER_HZ = 20.0
CAFE_FLOOR_DB = -10.0
# The mix is scaled down, speech and noise alike, when its peak passes this: no clipping, and
# the SNR unchanged.
PEAK_CEILING = 0.98

BABBLE_TALKERS = (3, 5)
BABBLE_LOOP_MS = 20_000
BABBLE_GAP_MS = (200, 700)
# Voices the eval scripts already render with, so Kokoro has every one of them.
BABBLE_VOICES = (
    "af_bella",
    "af_nova",
    "af_river",
    "af_sarah",
    "am_adam",
    "am_echo",
    "am_michael",
    "bf_alice",
    "bf_emma",
    "bm_daniel",
    "bm_george",
)
BABBLE_LINES = (
    "We should pack the sandwiches before the ferry leaves.",
    "My sister finally painted the kitchen a pale shade of green.",
    "If it keeps raining, the football match will move indoors.",
    "He keeps a little notebook of every bird he spots on his walks.",
    "The bakery on the corner always runs out of rye bread early.",
    "We spent ages trying to fix the old bicycle chain.",
    "Their dog learned to open the garden gate with its nose.",
    "I heard the museum lets children in without a ticket.",
    "She ordered the soup, but they brought her a salad instead.",
    "The train was so slow that I read half of my book.",
    "They want to camp beside the lake when the weather turns warm.",
    "Grandpa still tells the story about the big snowstorm.",
)

type Samples = NDArray[np.float64]


class Voice(Protocol):
    def synthesize(self, text: str, voice: str, speed: float) -> NDArray[np.float32]:
        """One line's speech: mono samples, roughly in [-1, 1]."""
        ...


@dataclass(frozen=True)
class Noise:
    kind: NoiseKind
    snr_db: float


def _seed(*parts: str) -> int:
    digest = hashlib.sha256("|".join([*parts, f"v{NOISE_VERSION}"]).encode("utf-8")).digest()
    return int.from_bytes(digest[:8], "big")


def seed_for(audio_key: str, noise: Noise) -> int:
    """The noise seed for a script's audio (`audio_key`, canonical text of what shapes its
    speech) and spec: the same pair always gets the same noise."""
    return _seed(audio_key, noise.kind, repr(noise.snr_db))


def rms(samples: Samples) -> float:
    return math.sqrt(float(np.mean(np.square(samples)))) if samples.size else 0.0


def _unit_rms(samples: Samples) -> Samples:
    level = rms(samples)
    if level == 0.0:
        raise ValueError("silent noise can't be scaled to an SNR")
    return samples / level


def colored_noise(
    size: int, exponent: float, rng: np.random.Generator, rate: int, corner_hz: float = 0.0
) -> Samples:
    """Gaussian noise whose power falls as 1/f**exponent (1: pink, 2: brown), at unit RMS.

    Shaped in the frequency domain. With `corner_hz`, the spectrum below it falls off at 12 dB an
    octave instead of growing without bound toward DC.
    """
    if size < 2:
        raise ValueError("noise needs at least two samples")
    bins = size // 2 + 1
    spectrum = rng.standard_normal(bins) + 1j * rng.standard_normal(bins)
    freqs = np.fft.rfftfreq(size, d=1.0 / rate)
    scale = np.zeros(bins)
    scale[1:] = freqs[1:] ** (-exponent / 2.0)
    if corner_hz > 0.0:
        below = freqs < corner_hz
        scale[below] = corner_hz ** (-exponent / 2.0) * (freqs[below] / corner_hz) ** 2
    shaped = np.fft.irfft(spectrum * scale, size)
    return _unit_rms(shaped)


class BabbleBank:
    """Each babble voice's loop, synthesized once per render run and reused by every script.

    A loop is about BABBLE_LOOP_MS of one voice reading the lines in its own seeded order, each
    line followed by a seeded gap, so it starts with speech and ends in silence and tiles without
    a click. A script's babble picks 3 to 5 voices other than its own and starts each loop at a
    seeded offset.
    """

    def __init__(self, voice: Voice, rate: int) -> None:
        self._voice = voice
        self._rate = rate
        self._loops: dict[str, Samples] = {}

    def loop(self, name: str) -> Samples:
        if name not in self._loops:
            self._loops[name] = self._make_loop(name)
        return self._loops[name]

    def _make_loop(self, name: str) -> Samples:
        rng = np.random.default_rng(_seed("babble", name))
        order = [int(k) for k in rng.permutation(len(BABBLE_LINES))]
        target = BABBLE_LOOP_MS * self._rate // 1000
        parts: list[Samples] = []
        total = 0
        for k in range(4 * len(BABBLE_LINES)):
            if total >= target:
                break
            line = BABBLE_LINES[order[k % len(order)]]
            speech = np.asarray(self._voice.synthesize(line, name, 1.0), dtype=np.float64)
            gap_ms = int(rng.integers(BABBLE_GAP_MS[0], BABBLE_GAP_MS[1] + 1))
            gap = np.zeros(gap_ms * self._rate // 1000)
            parts.extend([speech.reshape(-1), gap])
            total += speech.size + gap.size
        if total < target or not any(part.any() for part in parts):
            raise ValueError(f"the voice {name} produced too little audio for babble")
        return _unit_rms(np.concatenate(parts))

    def babble(
        self, size: int, rng: np.random.Generator, exclude: str
    ) -> tuple[Samples, list[str]]:
        """`size` samples of 3 to 5 voices at once, none of them `exclude`, at unit RMS."""
        pool = [name for name in BABBLE_VOICES if name != exclude]
        count = int(rng.integers(BABBLE_TALKERS[0], BABBLE_TALKERS[1] + 1))
        names = [pool[int(k)] for k in rng.choice(len(pool), size=count, replace=False)]
        track = np.zeros(size)
        for name in names:
            loop = self.loop(name)
            offset = int(rng.integers(0, loop.size))
            repeats = -(-(size + offset) // loop.size)
            track += np.tile(loop, repeats)[offset : offset + size]
        return _unit_rms(track), names


def noise_track(
    noise: Noise, size: int, rng: np.random.Generator, rate: int, bank: BabbleBank, exclude: str
) -> Samples:
    """`size` samples of the kind's noise, at unit RMS."""
    if noise.kind == "car":
        return colored_noise(size, 2.0, rng, rate, BROWN_CORNER_HZ)
    if noise.kind == "street":
        return colored_noise(size, 1.0, rng, rate)
    babble, _names = bank.babble(size, rng, exclude)
    floor = colored_noise(size, 1.0, rng, rate)
    return _unit_rms(babble + 10.0 ** (CAFE_FLOOR_DB / 20.0) * floor)


def snr_db(speech: Samples, noise: Samples, active: NDArray[np.bool_]) -> float:
    """Speech power over noise power on the active samples, in dB."""
    return 10.0 * math.log10(
        float(np.mean(np.square(speech[active]))) / float(np.mean(np.square(noise[active])))
    )


def noise_gain(
    speech: Samples, noise: Samples, active: NDArray[np.bool_], target_db: float
) -> float:
    """The factor that puts `noise` at `target_db` below `speech` on the active samples."""
    if not active.any():
        raise ValueError("the SNR needs samples where the voice speaks")
    speech_power = float(np.mean(np.square(speech[active])))
    noise_power = float(np.mean(np.square(noise[active])))
    if speech_power == 0.0 or noise_power == 0.0:
        raise ValueError("the SNR needs speech and noise on the active samples")
    return math.sqrt(speech_power / (noise_power * 10.0 ** (target_db / 10.0)))


def scaled_noise(
    speech: Samples,
    active: NDArray[np.bool_],
    noise: Noise,
    *,
    audio_key: str,
    voice: str,
    rate: int,
    tail: int,
    bank: BabbleBank,
) -> Samples:
    """The noise to add to `speech`: the kind's noise faded in and out, silent over the last
    `tail` samples, and scaled to the script's SNR on the active samples."""
    body = speech.size - tail
    fade = max(1, FADE_MS * rate // 1000)
    if body < 2 * fade:
        raise ValueError("the audio is too short for noise")
    rng = np.random.default_rng(seed_for(audio_key, noise))
    track = np.zeros(speech.size)
    track[:body] = noise_track(noise, body, rng, rate, bank, voice)
    ramp = 0.5 - 0.5 * np.cos(np.pi * np.arange(fade) / fade)
    track[:fade] *= ramp
    track[body - fade : body] *= ramp[::-1]
    return track * noise_gain(speech, track, active, noise.snr_db)


def limit_peak(samples: Samples, ceiling: float = PEAK_CEILING) -> Samples:
    """Scaled down to `ceiling` if its peak passes it: no clipping, and every ratio kept."""
    peak = float(np.max(np.abs(samples))) if samples.size else 0.0
    return samples * (ceiling / peak) if peak > ceiling else samples
