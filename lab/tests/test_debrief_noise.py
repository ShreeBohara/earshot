"""Background noise in the eval renderer (Phase 4 spec, WP10b), with stand-in voices.

The spec's tests: the SNR within ±0.5 dB, no clipping, and 16-bit output. Also the noise's
colors, its determinism, the babble's voices, the silent tail, and the hash.
"""

from __future__ import annotations

import json
import math
import zlib
from pathlib import Path

import debrief_noise as dn
import numpy as np
import pytest
import render_debriefs as rd
from numpy.typing import NDArray

RATE = rd.SOURCE_RATE
STUB_MODEL = {"kokoro-v1.0.onnx": "0" * 64, "voices-v1.0.bin": "1" * 64}
STUB_PACKAGES = {"kokoro-onnx": "0.6.1", "numpy": "2.5.5", "onnxruntime": "1.32.0"}
QUIET = rd.Script(
    id="d000",
    voice="af_heart",
    speed=1.0,
    turns=(
        rd.Turn(text="I owe Dana Lee a revised quote by Friday.", pause_before_ms=1_500),
        rd.Turn(text="That's all for Acme.", pause_before_ms=1_200),
    ),
)


LONGER = rd.Script(
    id="d000",
    voice="af_heart",
    speed=1.0,
    turns=(*QUIET.turns, rd.Turn(text="Remind me to call her back.", pause_before_ms=900)),
)


def noisy(kind: dn.NoiseKind, snr_db: float, script: rd.Script = QUIET) -> rd.Script:
    return rd.Script(
        script.id, script.voice, script.speed, script.turns, dn.Noise(kind=kind, snr_db=snr_db)
    )


class SpeechLikeVoice:
    """Loud, speech-like stand-in: a gliding tone under an amplitude envelope near full scale,
    so the noise has to push the mix past 1.0 and the peak limit has to catch it. Its pitch,
    glide, envelope, and phase come from the voice and the text, so babble talkers and the
    script's own voice don't line up."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, str]] = []

    def synthesize(self, text: str, voice: str, speed: float) -> NDArray[np.float32]:
        self.calls.append((text, voice))
        rng = np.random.default_rng(zlib.crc32(f"{voice}|{text}".encode()))
        base, glide, beat = rng.uniform(100, 220), rng.uniform(0.3, 1.2), rng.uniform(2.0, 5.0)
        size = len(text) * 60 * RATE // 1000
        t = np.arange(size) / RATE
        pitch = base + 0.4 * base * np.sin(2 * np.pi * glide * t + rng.uniform(0, 2 * np.pi))
        phase = 2 * np.pi * np.cumsum(pitch) / RATE + rng.uniform(0, 2 * np.pi)
        envelope = 0.55 + 0.4 * np.abs(np.sin(2 * np.pi * beat * t))
        wave = envelope * (0.8 * np.sin(phase) + 0.2 * np.sin(3 * phase))
        return wave.astype(np.float32)


def psd_slope(samples: NDArray[np.float64], low_hz: float, high_hz: float) -> float:
    """The log-log slope of the power spectrum between two frequencies, from averaged Hann
    periodograms (Welch's method, numpy only)."""
    segment = 8_192
    window = np.hanning(segment)
    count = samples.size // segment
    frames = samples[: count * segment].reshape(count, segment) * window
    power = np.mean(np.abs(np.fft.rfft(frames, axis=1)) ** 2, axis=0)
    freqs = np.fft.rfftfreq(segment, d=1.0 / RATE)
    band = (freqs >= low_hz) & (freqs <= high_hz)
    slope, _intercept = np.polyfit(np.log10(freqs[band]), np.log10(power[band]), 1)
    return float(slope)


# --- The colors ----------------------------------------------------------------------------------


def test_pink_falls_3_db_and_brown_6_db_an_octave() -> None:
    rng = np.random.default_rng(7)
    pink = dn.colored_noise(RATE * 20, 1.0, rng, RATE)
    brown = dn.colored_noise(RATE * 20, 2.0, rng, RATE, dn.BROWN_CORNER_HZ)
    assert psd_slope(pink, 50, 8_000) == pytest.approx(-1.0, abs=0.1)
    assert psd_slope(brown, 50, 8_000) == pytest.approx(-2.0, abs=0.15)
    # Below its corner, brown rolls off instead of piling up at DC.
    assert psd_slope(brown, 3, 12) > 0
    for samples in (pink, brown):
        assert dn.rms(samples) == pytest.approx(1.0, abs=1e-9)
        assert abs(float(np.mean(samples))) < 0.05


def test_the_noise_is_seeded_by_the_audio_and_its_spec() -> None:
    spec = dn.Noise(kind="street", snr_db=10.0)
    key = rd.audio_key(QUIET)
    assert dn.seed_for(key, spec) == dn.seed_for(key, spec)
    assert dn.seed_for(key, spec) != dn.seed_for(rd.audio_key(noisy("street", 10.0, LONGER)), spec)
    assert dn.seed_for(key, spec) != dn.seed_for(key, dn.Noise("street", 12.0))
    assert dn.seed_for(key, spec) != dn.seed_for(key, dn.Noise("car", 10.0))
    # The id and the noise aren't part of the key: what the hash ignores can't change the noise.
    renamed = rd.Script("d777", QUIET.voice, QUIET.speed, QUIET.turns, spec)
    assert rd.audio_key(renamed) == key


# --- The mix -------------------------------------------------------------------------------------


@pytest.mark.parametrize("kind", dn.NOISE_KINDS)
@pytest.mark.parametrize("snr_db", [0.0, 5.0, 10.0, 20.0])
def test_the_noise_sits_at_the_script_snr(kind: dn.NoiseKind, snr_db: float) -> None:
    voice = SpeechLikeVoice()
    speech = np.zeros(RATE * 6)
    active = np.zeros(speech.size, dtype=np.bool_)
    line = voice.synthesize("A turn long enough to measure.", "af_heart", 1.0).astype(np.float64)
    speech[RATE : RATE + line.size] = line
    active[RATE : RATE + line.size] = True
    noise = dn.scaled_noise(
        speech,
        active,
        dn.Noise(kind=kind, snr_db=snr_db),
        audio_key="a turn",
        voice="af_heart",
        rate=RATE,
        tail=RATE,
        bank=dn.BabbleBank(voice, RATE),
    )
    assert dn.snr_db(speech, noise, active) == pytest.approx(snr_db, abs=0.5)
    # Noise in the pauses too, but none in the tail.
    assert np.any(noise[: RATE // 2] != 0)
    assert np.all(noise[-RATE:] == 0)


@pytest.mark.parametrize("kind", dn.NOISE_KINDS)
def test_a_noisy_render_is_16_bit_unclipped_and_at_its_snr(kind: dn.NoiseKind) -> None:
    """End to end through `assemble`: the noise is recovered as what's left of the noisy render
    once the quiet render, scaled by least squares, is taken away."""
    target = 5.0
    quiet, timed = rd.assemble(QUIET, SpeechLikeVoice())
    loud, timed_noisy = rd.assemble(noisy(kind, target), SpeechLikeVoice())
    assert timed_noisy == timed
    assert loud.dtype == np.int16
    assert loud.size == quiet.size
    # No clipping: the peak limit leaves headroom below full scale.
    assert int(np.max(np.abs(loud.astype(np.int32)))) <= round(dn.PEAK_CEILING * 32767) + 1
    active = np.zeros(loud.size, dtype=np.bool_)
    for turn in timed:
        active[turn.start_ms * rd.TARGET_RATE // 1000 : turn.end_ms * rd.TARGET_RATE // 1000] = True
    clean = quiet.astype(np.float64)
    mixed = loud.astype(np.float64)
    scale = float(np.dot(mixed[active], clean[active]) / np.dot(clean[active], clean[active]))
    residual = mixed - scale * clean
    assert dn.snr_db(scale * clean, residual, active) == pytest.approx(target, abs=0.5)


def test_the_tail_stays_digital_silence_under_noise() -> None:
    # As for quiet renders (test_render_debriefs.py): the resampler rings for well under a
    # millisecond, so all but the tail's first few ms are exact zeros, and so is the fake
    # microphone's last 1,024-frame buffer.
    pcm, _timed = rd.assemble(noisy("street", 0.0), SpeechLikeVoice())
    assert not pcm[-47_000:].any()
    assert not pcm[-1_024:].any()
    # The noise starts at once, in the lead-in.
    assert pcm[: rd.TARGET_RATE // 2].any()


def test_a_noisy_render_is_reproducible_and_keyed_by_its_hash() -> None:
    first, _ = rd.assemble(noisy("cafe", 10.0), SpeechLikeVoice())
    second, _ = rd.assemble(noisy("cafe", 10.0), SpeechLikeVoice())
    assert np.array_equal(first, second)
    # Another id with the same audio and spec: the same hash, so it must be the same WAV.
    renamed = rd.Script("d001", QUIET.voice, QUIET.speed, QUIET.turns, dn.Noise("cafe", 10.0))
    assert sample_hash(renamed) == sample_hash(noisy("cafe", 10.0))
    assert np.array_equal(first, rd.assemble(renamed, SpeechLikeVoice())[0])
    other, _ = rd.assemble(noisy("cafe", 10.0, LONGER), SpeechLikeVoice())
    assert other.size != first.size or not np.array_equal(first, other)


def test_the_peak_limit_keeps_every_ratio() -> None:
    samples = np.array([0.5, -2.0, 1.0])
    limited = dn.limit_peak(samples)
    assert float(np.max(np.abs(limited))) == pytest.approx(dn.PEAK_CEILING)
    assert limited / limited[0] == pytest.approx(samples / samples[0])
    quiet = np.array([0.1, -0.2])
    assert dn.limit_peak(quiet) is quiet


# --- Babble --------------------------------------------------------------------------------------


def test_babble_is_three_to_five_other_voices_reading_unrelated_lines() -> None:
    voice = SpeechLikeVoice()
    bank = dn.BabbleBank(voice, RATE)
    seen: set[int] = set()
    for seed in range(12):
        track, names = bank.babble(RATE * 4, np.random.default_rng(seed), exclude="af_bella")
        assert dn.BABBLE_TALKERS[0] <= len(names) <= dn.BABBLE_TALKERS[1]
        assert len(set(names)) == len(names)
        assert "af_bella" not in names
        assert set(names) <= set(dn.BABBLE_VOICES)
        assert dn.rms(track) == pytest.approx(1.0)
        seen.add(len(names))
    assert seen == {3, 4, 5}
    # Each voice's loop is synthesized once, however many scripts use it.
    voices_synthesized = {name for _text, name in voice.calls}
    lines_per_voice = len(voice.calls) / len(voices_synthesized)
    assert lines_per_voice <= len(dn.BABBLE_LINES) * 2
    assert {text for text, _name in voice.calls} <= set(dn.BABBLE_LINES)


def test_babble_lines_hold_nothing_an_extractor_could_propose() -> None:
    days = ("monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday")
    times = ("today", "tomorrow", "yesterday", "week", "month", "quarter", "o'clock")
    for line in dn.BABBLE_LINES:
        words = line.lower().replace(",", "").replace(".", "").split()
        assert not any(char.isdigit() for char in line), line
        assert not set(words) & set(days + times), line


def test_every_babble_voice_is_one_the_eval_scripts_already_use() -> None:
    used = {
        json.loads(path.read_text(encoding="utf-8"))["voice"]
        for path in sorted(rd.DEBRIEFS.glob("d*.json"))
    }
    assert set(dn.BABBLE_VOICES) <= used


# --- Scripts and the hash ------------------------------------------------------------------------


def sample_hash(script: rd.Script) -> str:
    return rd.render_hash(script, model_sha256=STUB_MODEL, packages=STUB_PACKAGES)


def test_noise_joins_the_hash_only_when_there_is_noise(monkeypatch: pytest.MonkeyPatch) -> None:
    # The renderer's golden hash for the quiet sample (test_render_debriefs.py) still holds.
    assert sample_hash(QUIET) == "23c17aacd864bf333b9fa81750612244"
    hashes = {
        sample_hash(noisy("car", 10.0)),
        sample_hash(noisy("street", 10.0)),
        sample_hash(noisy("cafe", 10.0)),
        sample_hash(noisy("cafe", 12.0)),
    }
    monkeypatch.setattr(rd, "NOISE_VERSION", dn.NOISE_VERSION + 1)
    hashes.add(sample_hash(noisy("cafe", 12.0)))
    assert sample_hash(QUIET) not in hashes
    assert len(hashes) == 5


def write_script(tmp_path: Path, noise: object) -> Path:
    record = json.loads((rd.DEBRIEFS / "d001.json").read_text(encoding="utf-8"))
    if noise is not None:
        record["noise"] = noise
    path = tmp_path / "d001.json"
    path.write_text(json.dumps(record), encoding="utf-8")
    return path


def test_scripts_read_their_noise(tmp_path: Path) -> None:
    assert rd.load_script(write_script(tmp_path, None)).noise is None
    assert rd.load_script(write_script(tmp_path, {"kind": "none"})).noise is None
    assert rd.load_script(write_script(tmp_path, {"kind": "cafe", "snrDb": 12})).noise == dn.Noise(
        kind="cafe", snr_db=12.0
    )
    quiet = rd.load_script(write_script(tmp_path, None))
    none = rd.load_script(write_script(tmp_path, {"kind": "none", "snrDb": 5}))
    assert sample_hash(quiet) == sample_hash(none)


@pytest.mark.parametrize(
    ("noise", "message"),
    [
        ({"kind": "rain", "snrDb": 10}, "kind must be"),
        ({"kind": "car"}, "snrDb must be"),
        ({"kind": "car", "snrDb": "10"}, "snrDb must be"),
        ({"kind": "car", "snrDb": True}, "snrDb must be"),
        ({"kind": "car", "snrDb": 99}, "snrDb must be"),
        ({"kind": "car", "snrDb": math.inf}, "snrDb must be"),
        ("car", "expected a JSON object"),
    ],
)
def test_bad_noise_fails_with_the_file_name(tmp_path: Path, noise: object, message: str) -> None:
    with pytest.raises(rd.RenderError, match=rf"d001\.json noise.*{message}"):
        rd.load_script(write_script(tmp_path, noise))


def test_render_shares_one_babble_bank_across_scripts(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    made: list[str] = []
    make_loop = rd.BabbleBank._make_loop  # pyright: ignore[reportPrivateUsage]

    def counting(self: dn.BabbleBank, name: str) -> NDArray[np.float64]:
        made.append(name)
        return make_loop(self, name)

    monkeypatch.setattr(rd.BabbleBank, "_make_loop", counting)
    scripts = [
        noisy("cafe", 10.0, rd.Script(f"d00{k}", "am_liam", 1.0, (rd.Turn(text, 800),)))
        for k, text in enumerate(("Send the deck.", "Log the call.", "Book a demo."), start=1)
    ]
    rd.render(
        scripts,
        tmp_path / "wavs",
        model_sha256=STUB_MODEL,
        packages=STUB_PACKAGES,
        synthesizer=SpeechLikeVoice,
        log=lambda _line: None,
    )
    # Three cafe scripts draw 9 to 15 talkers from the pool, but each voice's loop is made once.
    assert made
    assert len(made) == len(set(made))
    assert len(list((tmp_path / "wavs").glob("*.wav"))) == 3
