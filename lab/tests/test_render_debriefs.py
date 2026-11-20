"""The eval renderer (scripts/render_debriefs.py), with stand-in voices instead of Kokoro.

Nothing here downloads a model or needs the tts group: the voices below synthesize tones and
loud noise at Kokoro's 24 kHz, and model downloads come from file:// URLs in a temporary folder.
"""

from __future__ import annotations

import hashlib
import itertools
import json
import os
import struct
import wave
from pathlib import Path
from typing import Any, cast

import numpy as np
import pytest
import render_debriefs as rd
from numpy.typing import NDArray

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / "packages" / "evals" / "fixtures"
UPDATE_GOLDEN = os.environ.get("UPDATE_GOLDEN") == "1"

# Fixed stand-ins for the model's checksums and the package versions, so hashes are stable.
STUB_MODEL = {"kokoro-v1.0.onnx": "0" * 64, "voices-v1.0.bin": "1" * 64}
STUB_PACKAGES = {"kokoro-onnx": "0.6.1", "numpy": "2.5.5", "onnxruntime": "1.32.0"}
SAMPLE = rd.Script(
    id="d000",
    voice="af_heart",
    speed=1.0,
    turns=(
        rd.Turn(text="I owe Dana Lee a revised quote by Friday.", pause_before_ms=1_500),
        rd.Turn(text="That's all for Acme.", pause_before_ms=1_200),
    ),
)
# 60 ms of tone per character, so durations are easy to predict.
SAMPLES_PER_CHAR = 60 * rd.SOURCE_RATE // 1000


class ToneVoice:
    """A 220 Hz tone that starts and stops at full amplitude, so any click or ringing shows."""

    def __init__(self, amplitude: float = 0.5) -> None:
        self.amplitude = amplitude
        self.calls: list[tuple[str, str, float]] = []

    def synthesize(self, text: str, voice: str, speed: float) -> NDArray[np.float32]:
        self.calls.append((text, voice, speed))
        t = np.arange(len(text) * SAMPLES_PER_CHAR) / rd.SOURCE_RATE
        return (self.amplitude * np.cos(2 * np.pi * 220 * t)).astype(np.float32)


class LoudNoiseVoice:
    """White noise at 1.5x full scale: the renderer has to clip it, never wrap it."""

    def synthesize(self, text: str, voice: str, speed: float) -> NDArray[np.float32]:
        rng = np.random.default_rng(len(text))
        return rng.uniform(-1.5, 1.5, len(text) * SAMPLES_PER_CHAR).astype(np.float32)


def render_sample(
    tmp_path: Path, voice: rd.Synthesizer | None = None, script: rd.Script = SAMPLE
) -> tuple[rd.RenderResult, Path]:
    out = tmp_path / "wavs"
    result = rd.render(
        [script],
        out,
        model_sha256=STUB_MODEL,
        packages=STUB_PACKAGES,
        synthesizer=lambda: voice or ToneVoice(),
        log=lambda _line: None,
    )
    return result, out


def read_pcm(path: Path) -> NDArray[np.int16]:
    with wave.open(str(path), "rb") as wav:
        return np.frombuffer(wav.readframes(wav.getnframes()), dtype="<i2").astype(np.int16)


def sample_frames() -> int:
    pauses = sum(t.pause_before_ms * rd.SOURCE_RATE // 1000 for t in SAMPLE.turns)
    speech = sum(len(t.text) * SAMPLES_PER_CHAR for t in SAMPLE.turns)
    return 2 * (pauses + speech + rd.TAIL_MS * rd.SOURCE_RATE // 1000)


# --- The WAV -------------------------------------------------------------------------------------


def test_the_wav_is_48_khz_mono_16_bit_pcm(tmp_path: Path) -> None:
    result, out = render_sample(tmp_path)
    wav_path = out / result.manifest["scripts"]["d000"]["wav"]
    with wave.open(str(wav_path), "rb") as wav:
        assert wav.getnchannels() == 1
        assert wav.getsampwidth() == 2
        assert wav.getframerate() == 48_000
        assert wav.getcomptype() == "NONE"
    # The header itself, as Chrome's WavAudioHandler reads it: plain PCM (format 1), not
    # WAVE_FORMAT_EXTENSIBLE, 16 bits per sample, never 24.
    header = wav_path.read_bytes()[:44]
    assert header[0:4] == b"RIFF" and header[8:16] == b"WAVEfmt "
    fmt, channels, rate, byte_rate, block_align, bits = struct.unpack("<HHIIHH", header[20:36])
    assert (fmt, channels, rate, byte_rate, block_align, bits) == (1, 1, 48_000, 96_000, 2, 16)
    assert header[36:40] == b"data"


def test_the_duration_is_pauses_speech_and_tail_exactly_doubled(tmp_path: Path) -> None:
    result, out = render_sample(tmp_path)
    pcm = read_pcm(out / result.manifest["scripts"]["d000"]["wav"])
    assert pcm.size == sample_frames()
    assert result.manifest["scripts"]["d000"]["durationMs"] == round(pcm.size / 48)


def test_the_tail_is_a_full_second_of_digital_silence(tmp_path: Path) -> None:
    result, out = render_sample(tmp_path)
    pcm = read_pcm(out / result.manifest["scripts"]["d000"]["wav"])
    # The resampler's filter rings for well under a millisecond after the last loud sample, so
    # all but the first few ms of the 1.0 s tail are exact zeros, and so is the fake
    # microphone's last 1,024-frame buffer.
    assert not pcm[-47_000:].any()
    assert not pcm[-1_024:].any()
    assert pcm[-48_000 - 200 : -48_000].any()
    # The lead-in before the first turn is silent too.
    assert not pcm[: 2 * 1_500 * 24 - 100].any()


def test_the_upsampling_is_an_exact_2x_that_keeps_the_signal(tmp_path: Path) -> None:
    tone = ToneVoice().synthesize("x" * 50, "af_heart", 1.0)
    up = rd.upsample_2x(tone)
    assert up.size == 2 * tone.size
    # A 220 Hz tone is far below both Nyquist rates, so every other output sample is the input,
    # away from the edges where the filter sees the implied zeros.
    middle = slice(200, tone.size - 200)
    assert np.max(np.abs(up[::2][middle] - tone[middle])) < 1e-3


def test_loud_input_clips_instead_of_wrapping(tmp_path: Path) -> None:
    result, out = render_sample(tmp_path, voice=LoudNoiseVoice())
    pcm = read_pcm(out / result.manifest["scripts"]["d000"]["wav"])
    assert pcm.dtype == np.int16
    assert pcm.max() == 32_767
    assert pcm.min() == -32_767


def test_write_wav_takes_only_16_bit_mono(tmp_path: Path) -> None:
    for wrong in (
        np.zeros(10, dtype=np.float32),
        np.zeros(10, dtype=np.int32),
        np.zeros((10, 2), dtype=np.int16),
    ):
        with pytest.raises(TypeError):
            rd.write_wav(tmp_path / "x.wav", wrong)  # pyright: ignore[reportArgumentType]
    assert not (tmp_path / "x.wav").exists()


# --- Hashes --------------------------------------------------------------------------------------


def sample_hash(script: rd.Script = SAMPLE, **overrides: dict[str, str]) -> str:
    return rd.render_hash(
        script,
        model_sha256=overrides.get("model", STUB_MODEL),
        packages=overrides.get("packages", STUB_PACKAGES),
    )


def test_the_hash_is_stable(tmp_path: Path) -> None:
    # A golden value: if this changes, every cached WAV in CI is rendered again. Change it only
    # with a reason, and bump RENDERER_VERSION when the audio changes for the same inputs.
    assert sample_hash() == "23c17aacd864bf333b9fa81750612244"
    assert sample_hash() == sample_hash()
    shuffled = {"voices-v1.0.bin": "1" * 64, "kokoro-v1.0.onnx": "0" * 64}
    assert sample_hash(model=shuffled) == sample_hash()


def test_the_hash_covers_everything_that_shapes_the_audio(monkeypatch: pytest.MonkeyPatch) -> None:
    base = sample_hash()
    first, second = SAMPLE.turns
    variants = [
        rd.Script("d000", SAMPLE.voice, SAMPLE.speed, (rd.Turn("I owe Dana Lee.", 1_500), second)),
        rd.Script("d000", SAMPLE.voice, SAMPLE.speed, (rd.Turn(first.text, 1_600), second)),
        rd.Script("d000", "bm_george", SAMPLE.speed, SAMPLE.turns),
        rd.Script("d000", SAMPLE.voice, 1.05, SAMPLE.turns),
    ]
    hashes = {sample_hash(variant) for variant in variants}
    hashes.add(sample_hash(model={**STUB_MODEL, "kokoro-v1.0.onnx": "2" * 64}))
    hashes.add(sample_hash(packages={**STUB_PACKAGES, "onnxruntime": "1.32.1"}))
    monkeypatch.setattr(rd, "RENDERER_VERSION", rd.RENDERER_VERSION + 1)
    hashes.add(sample_hash())
    assert base not in hashes
    assert len(hashes) == 7


def test_the_hash_ignores_what_never_reaches_the_audio(tmp_path: Path) -> None:
    script = json.loads((rd.DEBRIEFS / "d001.json").read_text(encoding="utf-8"))
    (tmp_path / "a.json").write_text(json.dumps(script), encoding="utf-8")
    script["title"] = "A different title"
    script["id"] = "d099"
    for turn in script["turns"]:
        turn["expect"] = []
        turn.pop("tags", None)
    (tmp_path / "b.json").write_text(json.dumps(script), encoding="utf-8")
    a, b = (rd.load_script(tmp_path / name) for name in ("a.json", "b.json"))
    assert sample_hash(a) == sample_hash(b)


# --- timing.json and the manifest ----------------------------------------------------------------


def golden(name: str, document: object) -> None:
    path = FIXTURES / name
    text = json.dumps(document, indent=2, ensure_ascii=False) + "\n"
    if UPDATE_GOLDEN:
        path.write_text(text, encoding="utf-8")
    assert path.read_text(encoding="utf-8") == text, f"run with UPDATE_GOLDEN=1 to rewrite {name}"


def test_timing_and_manifest_match_the_committed_samples(tmp_path: Path) -> None:
    # packages/evals checks these same files against its Zod schemas (DebriefTiming and
    # RenderManifest), so the two languages agree on the format.
    result, out = render_sample(tmp_path)
    entry = result.manifest["scripts"]["d000"]
    timing = json.loads((out / entry["timing"]).read_text(encoding="utf-8"))
    golden("timing.sample.json", timing)
    golden("manifest.sample.json", json.loads((out / "manifest.json").read_text(encoding="utf-8")))
    assert entry["hash"] == timing["hash"] == sample_hash()
    assert entry["wav"] == f"{sample_hash()}.wav"


def test_timing_marks_each_turn_and_spreads_its_words(tmp_path: Path) -> None:
    result, out = render_sample(tmp_path)
    timing = json.loads((out / result.manifest["scripts"]["d000"]["timing"]).read_text("utf-8"))
    first, second = timing["turns"]
    first_chars, second_chars = (len(t.text) for t in SAMPLE.turns)
    assert first["startMs"] == 1_500
    assert first["endMs"] == 1_500 + 60 * first_chars
    assert second["startMs"] == first["endMs"] + 1_200
    assert second["endMs"] == second["startMs"] + 60 * second_chars
    assert timing["durationMs"] == second["endMs"] + 1_000
    for turn, script_turn in zip(timing["turns"], SAMPLE.turns, strict=True):
        words = turn["words"]
        assert [word["w"] for word in words] == script_turn.text.split()
        assert words[0]["startMs"] == turn["startMs"]
        assert all(w["startMs"] <= w["endMs"] <= turn["endMs"] for w in words)
        assert all(a["endMs"] <= b["startMs"] for a, b in itertools.pairwise(words))


@pytest.mark.parametrize(
    ("text", "start", "end", "expected"),
    [
        # Computed by spreadWords in packages/voice/src/testing/fake-stt.ts.
        (
            "I owe Dana Lee a revised quote by Friday.",
            1500,
            4380,
            [
                ("I", 1500, 1569),
                ("owe", 1637, 1843),
                ("Dana", 1911, 2186),
                ("Lee", 2254, 2460),
                ("a", 2529, 2597),
                ("revised", 2666, 3146),
                ("quote", 3214, 3557),
                ("by", 3626, 3763),
                ("Friday.", 3831, 4311),
            ],
        ),
        (
            "That's all for Acme.",
            9001,
            10203,
            [
                ("That's", 9001, 9344),
                ("all", 9402, 9573),
                ("for", 9631, 9802),
                ("Acme.", 9860, 10146),
            ],
        ),
        (
            "Move  the deal\tto contract sent.",
            0,
            1999,
            [
                ("Move", 0, 250),
                ("the", 312, 500),
                ("deal", 562, 812),
                ("to", 875, 1000),
                ("contract", 1062, 1562),
                ("sent.", 1624, 1937),
            ],
        ),
    ],
)
def test_spread_words_matches_the_fake_adapter(
    text: str, start: int, end: int, expected: list[tuple[str, int, int]]
) -> None:
    words = rd.spread_words(text, start, end)
    assert [(w["w"], w["startMs"], w["endMs"]) for w in words] == expected


def test_a_warm_cache_never_loads_the_voice(tmp_path: Path) -> None:
    voice = ToneVoice()
    first, out = render_sample(tmp_path, voice=voice)
    assert first.statuses == {"d000": "rendered"}
    assert len(voice.calls) == len(SAMPLE.turns)

    def no_voice() -> rd.Synthesizer:
        raise AssertionError("the voice was loaded for a cached WAV")

    second = rd.render(
        [SAMPLE],
        out,
        model_sha256=STUB_MODEL,
        packages=STUB_PACKAGES,
        synthesizer=no_voice,
        log=lambda _line: None,
    )
    assert second.statuses == {"d000": "cached"}
    assert second.manifest == first.manifest


def test_prune_removes_only_stale_renders(tmp_path: Path) -> None:
    out = tmp_path / "wavs"
    out.mkdir()
    for name in ("0" * 32 + ".wav", "0" * 32 + ".timing.json", "x.wav.tmp"):
        (out / name).write_bytes(b"stale")
    (out / "notes.txt").write_text("kept", encoding="utf-8")
    rd.render(
        [SAMPLE],
        out,
        model_sha256=STUB_MODEL,
        packages=STUB_PACKAGES,
        synthesizer=ToneVoice,
        prune=True,
        log=lambda _line: None,
    )
    names = sorted(path.name for path in out.iterdir())
    assert names == sorted(
        ["manifest.json", "notes.txt", f"{sample_hash()}.wav", f"{sample_hash()}.timing.json"]
    )


def test_it_renders_the_real_debriefs(tmp_path: Path) -> None:
    scripts = rd.load_scripts(rd.DEBRIEFS)
    assert [script.id for script in scripts] == [f"d{n:03d}" for n in range(1, 31)]
    assert all(2 <= len(script.turns) <= 5 for script in scripts)
    subset = rd.load_scripts(rd.DEBRIEFS, only=["d001", "d030"])
    out = tmp_path / "wavs"
    result = rd.render(
        subset,
        out,
        model_sha256=STUB_MODEL,
        packages=STUB_PACKAGES,
        synthesizer=ToneVoice,
        log=lambda _line: None,
    )
    assert sorted(result.manifest["scripts"]) == ["d001", "d030"]
    summary = rd.summary_markdown(subset, result)
    assert "| d030 | am_liam | 5 |" in summary
    with pytest.raises(rd.RenderError, match="no such scripts: d999"):
        rd.load_scripts(rd.DEBRIEFS, only=["d999"])


def test_bad_scripts_fail_with_their_file_name(tmp_path: Path) -> None:
    path = tmp_path / "d001.json"
    path.write_text(json.dumps({"id": "d001", "voice": "en_unknown", "turns": []}), "utf-8")
    with pytest.raises(rd.RenderError, match=r"d001\.json"):
        rd.load_script(path)
    path.write_text(json.dumps({"id": "d001", "voice": "af_heart", "turns": [{"text": "x"}]}))
    with pytest.raises(rd.RenderError, match="pauseBeforeMs"):
        rd.load_script(path)


# --- Model files ---------------------------------------------------------------------------------


def test_the_pins_point_at_kokoro_onnx_release_assets() -> None:
    pins = rd.load_pins()
    assert set(pins) == {"model", "voices"}
    prefix = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.1/"
    for pin in pins.values():
        assert pin.url == prefix + pin.name
        assert len(pin.sha256) == 64 and pin.size > 1_000_000
    assert pins["model"].name == "kokoro-v1.0.onnx"
    assert pins["voices"].name == "voices-v1.0.bin"


def make_source(tmp_path: Path, content: bytes) -> tuple[rd.PinnedFile, Path]:
    source = tmp_path / "source" / "model.onnx"
    source.parent.mkdir(parents=True, exist_ok=True)
    source.write_bytes(content)
    pin = rd.PinnedFile(
        name="model.onnx",
        url=source.as_uri(),
        size=len(content),
        sha256=hashlib.sha256(content).hexdigest(),
    )
    return pin, source


def test_fetch_verified_downloads_a_matching_file_once(tmp_path: Path) -> None:
    pin, source = make_source(tmp_path, b"weights" * 1000)
    cache = tmp_path / "cache"
    got = rd.fetch_verified(pin, cache, attempts=1, log=lambda _line: None)
    assert got.read_bytes() == b"weights" * 1000
    # A verified copy is reused without touching the source.
    source.unlink()
    assert rd.fetch_verified(pin, cache, attempts=1, log=lambda _line: None) == got


def test_fetch_verified_refuses_a_checksum_mismatch_and_leaves_nothing(tmp_path: Path) -> None:
    pin, _source = make_source(tmp_path, b"weights")
    bad = rd.PinnedFile(pin.name, pin.url, pin.size, "f" * 64)
    cache = tmp_path / "cache"
    with pytest.raises(rd.RenderError, match="SHA-256"):
        rd.fetch_verified(bad, cache, attempts=3, log=lambda _line: None)
    assert list(cache.iterdir()) == []
    longer = rd.PinnedFile(pin.name, pin.url, pin.size - 1, pin.sha256)
    with pytest.raises(rd.RenderError, match="bytes"):
        rd.fetch_verified(longer, cache, attempts=1, log=lambda _line: None)
    assert list(cache.iterdir()) == []


def test_fetch_verified_replaces_a_corrupt_cached_copy(tmp_path: Path) -> None:
    pin, _source = make_source(tmp_path, b"weights")
    cache = tmp_path / "cache"
    cache.mkdir()
    (cache / pin.name).write_bytes(b"tampered")
    got = rd.fetch_verified(pin, cache, attempts=1, log=lambda _line: None)
    assert got.read_bytes() == b"weights"


def test_fetch_verified_reports_an_unreachable_source(tmp_path: Path) -> None:
    pin = rd.PinnedFile("gone.onnx", (tmp_path / "gone.onnx").as_uri(), 10, "0" * 64)
    with pytest.raises(rd.RenderError, match="download failed"):
        rd.fetch_verified(pin, tmp_path / "cache", attempts=1, log=lambda _line: None)


# --- The environment -----------------------------------------------------------------------------


def test_missing_tts_packages_say_how_to_install_them() -> None:
    with pytest.raises(rd.RenderError, match="--group tts"):
        rd.installed_versions(["earshot-no-such-package"])


def test_prune_cannot_go_with_a_subset() -> None:
    assert rd.main(["--only", "d001", "--prune"]) == 2


# --- --stub (NOT FOR EVALUATION) -----------------------------------------------------------------


def write_sample_script(directory: Path) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "d000.json").write_text(
        json.dumps(
            {
                "id": SAMPLE.id,
                "voice": SAMPLE.voice,
                "turns": [
                    {"text": turn.text, "pauseBeforeMs": turn.pause_before_ms}
                    for turn in SAMPLE.turns
                ],
            }
        ),
        encoding="utf-8",
    )
    return directory


def rms(samples: NDArray[np.int16]) -> float:
    return float(np.sqrt(np.mean(samples.astype(np.float64) ** 2)))


def test_stub_renders_a_tone_per_word_where_timing_puts_it(tmp_path: Path) -> None:
    debriefs = write_sample_script(tmp_path / "debriefs")
    out = tmp_path / "stub"
    assert rd.main(["--stub", "--debriefs", str(debriefs), "--out", str(out)]) == 0

    manifest = json.loads((out / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["model"] == {rd.STUB_MODEL_NAME: rd.STUB_SHA256}
    assert rd.is_stub_manifest(manifest)
    assert set(manifest["packages"]) == set(rd.STUB_PACKAGES)
    entry = manifest["scripts"]["d000"]
    pcm = read_pcm(out / entry["wav"])
    timing = json.loads((out / entry["timing"]).read_text(encoding="utf-8"))
    per_ms = rd.TARGET_RATE // 1000

    turns = cast(list[dict[str, Any]], timing["turns"])
    for turn in turns:
        # 60 ms per character, a space after each word counted.
        text = cast(str, turn["text"])
        span = cast(int, turn["endMs"]) - cast(int, turn["startMs"])
        assert span == sum(len(w) + 1 for w in text.split()) * 60
        spans = [(cast(int, w["startMs"]), cast(int, w["endMs"])) for w in turn["words"]]
        for (start, end), (next_start, _) in itertools.pairwise([*spans, (-1, -1)]):
            assert rms(pcm[(start + 10) * per_ms : (end - 10) * per_ms]) > 3_000, (start, end)
            if next_start >= 0:
                gap = next_start - end
                quiet = pcm[(end + gap // 4) * per_ms : (next_start - gap // 4) * per_ms]
                assert rms(quiet) < 50, (end, next_start)
    # The renderer's own silence is untouched: the lead-in and the tail.
    assert not pcm[: cast(int, turns[0]["startMs"]) * per_ms - 5 * per_ms].any()
    assert not pcm[-rd.TAIL_MS * per_ms + 5 * per_ms :].any()


def test_stub_renders_never_pass_for_kokoro_ones(tmp_path: Path) -> None:
    stub_hash = rd.render_hash(
        SAMPLE,
        model_sha256={rd.STUB_MODEL_NAME: rd.STUB_SHA256},
        packages={"numpy": "2.5.5", "scipy": "1.18.1"},
    )
    assert stub_hash != sample_hash()
    # Never into Kokoro's directory, where CI's cache would keep them.
    assert rd.main(["--stub", "--out", str(rd.WAVS)]) == 2
