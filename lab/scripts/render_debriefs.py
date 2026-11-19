"""Render the eval debriefs to the WAVs Chrome's fake microphone plays (Phase 3 spec, WP11).

Each script in packages/evals/debriefs/ becomes lab/.cache/wavs/<hash>.wav, mono 16-bit PCM at
48 kHz, with <hash>.timing.json beside it and manifest.json mapping script ids to both.

- Kokoro speaks each turn at 24 kHz. The turns are joined, each after its pause, with a 1.0 s
  silent tail so the fake microphone's last buffer is all zeros, then upsampled exactly 2x with
  scipy's polyphase resampler.
- Chrome rejects 24-bit WAV, so samples are clipped to [-1, 1] and written as 16-bit integers.
- Kokoro reports no word timings, so timing.json spreads each turn's span over its words by
  character count, by the same rule as @earshot/voice/testing's fake adapter.
- The hash covers everything that shapes the audio: the turns and their pauses, the voice and
  speed, this renderer's version, the model files' SHA-256s, and the audio packages' versions.
  A script whose WAV is already there isn't rendered again, and then the model isn't loaded.

The model files are downloaded on first use from the URLs pinned in kokoro_files.json, and
checked against the pinned size and SHA-256 before anything reads them. espeak-ng needs no apt
package: kokoro-onnx phonemizes through espeakng-loader, whose wheels bundle the library.

    uv sync --project lab --group tts
    uv run --project lab --group tts python lab/scripts/render_debriefs.py --prune
"""

from __future__ import annotations

import argparse
import hashlib
import importlib
import importlib.metadata
import json
import math
import os
import re
import sys
import time
import urllib.error
import urllib.request
import wave
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol, cast

import numpy as np
from numpy.typing import NDArray

# scipy ships no type stubs, and scipy-stubs isn't worth a dependency for one call.
from scipy import signal  # pyright: ignore[reportMissingTypeStubs]

# Bump when the audio or the files change for the same inputs; it's part of every hash.
RENDERER_VERSION = 1
SOURCE_RATE = 24_000
TARGET_RATE = 48_000
TAIL_MS = 1_000
SAMPLE_WIDTH_BYTES = 2
TIMING_VERSION = 1
MANIFEST_VERSION = 1

LAB = Path(__file__).resolve().parents[1]
ROOT = LAB.parent
DEBRIEFS = ROOT / "packages" / "evals" / "debriefs"
WAVS = LAB / ".cache" / "wavs"
MODELS = LAB / ".cache" / "kokoro"
PINS = Path(__file__).resolve().with_name("kokoro_files.json")

# The installed packages whose versions can change the audio, and so the hash.
TTS_PACKAGES = ("kokoro-onnx", "onnxruntime", "espeakng-loader", "phonemizer", "numpy", "scipy")

VOICE_PATTERN = re.compile(r"^[ab][fm]_[a-z]+$")
SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")

type FloatArray = NDArray[np.float32]
type PcmArray = NDArray[np.int16]
type JsonObject = dict[str, Any]


class RenderError(Exception):
    """A script, a model file, or the environment isn't what rendering needs."""


@dataclass(frozen=True)
class Turn:
    text: str
    pause_before_ms: int


@dataclass(frozen=True)
class Script:
    id: str
    voice: str
    speed: float
    turns: tuple[Turn, ...]


@dataclass(frozen=True)
class TimedTurn:
    """Where a turn's speech starts and ends in the WAV, in ms."""

    index: int
    start_ms: int
    end_ms: int
    text: str


@dataclass(frozen=True)
class PinnedFile:
    name: str
    url: str
    size: int
    sha256: str


class Synthesizer(Protocol):
    def synthesize(self, text: str, voice: str, speed: float) -> FloatArray:
        """One turn's speech: mono samples at 24 kHz, roughly in [-1, 1]."""
        ...


# --- Scripts ---------------------------------------------------------------------------------


def _get[T](data: Mapping[str, object], key: str, kind: type[T], where: str) -> T:
    value = data.get(key)
    if not isinstance(value, kind) or (isinstance(value, bool) and kind is not bool):
        raise RenderError(f"{where}: {key} must be a {kind.__name__}")
    return value


def _object(value: object, where: str) -> dict[str, object]:
    if not isinstance(value, dict):
        raise RenderError(f"{where}: expected a JSON object")
    return cast(dict[str, object], value)


def load_script(path: Path) -> Script:
    """The parts of a debrief script that shape its audio. Zod validates the rest, in Vitest."""
    where = path.name
    try:
        record = _object(json.loads(path.read_text(encoding="utf-8")), where)
    except json.JSONDecodeError as error:
        raise RenderError(f"{where}: not JSON ({error})") from error
    voice = _get(record, "voice", str, where)
    if not VOICE_PATTERN.match(voice):
        raise RenderError(f"{where}: {voice!r} isn't a Kokoro English voice")
    speed = record.get("speed", 1.0)
    if not isinstance(speed, int | float) or isinstance(speed, bool):
        raise RenderError(f"{where}: speed must be a number")
    raw_turns = record.get("turns")
    if not isinstance(raw_turns, list) or not raw_turns:
        raise RenderError(f"{where}: turns must be a non-empty list")
    turns: list[Turn] = []
    for index, item in enumerate(cast(list[object], raw_turns)):
        turn_where = f"{where} turn {index + 1}"
        turn = _object(item, turn_where)
        text = _get(turn, "text", str, turn_where)
        pause = _get(turn, "pauseBeforeMs", int, turn_where)
        if not text.strip() or pause < 0:
            raise RenderError(f"{turn_where}: needs text and a non-negative pause")
        turns.append(Turn(text=text, pause_before_ms=pause))
    return Script(
        id=_get(record, "id", str, where),
        voice=voice,
        speed=float(speed),
        turns=tuple(turns),
    )


def load_scripts(directory: Path, only: Iterable[str] | None = None) -> list[Script]:
    scripts = [load_script(path) for path in sorted(directory.glob("d*.json"))]
    if not scripts:
        raise RenderError(f"no debrief scripts in {directory}")
    if only is not None:
        wanted = set(only)
        missing = wanted - {script.id for script in scripts}
        if missing:
            raise RenderError(f"no such scripts: {', '.join(sorted(missing))}")
        scripts = [script for script in scripts if script.id in wanted]
    return scripts


# --- Hashing and timing ------------------------------------------------------------------------


def render_hash(
    script: Script, *, model_sha256: Mapping[str, str], packages: Mapping[str, str]
) -> str:
    """32 hex digits of SHA-256 over everything that shapes the audio, as canonical JSON."""
    payload = {
        "renderer": RENDERER_VERSION,
        "rates": [SOURCE_RATE, TARGET_RATE],
        "tailMs": TAIL_MS,
        "model": dict(sorted(model_sha256.items())),
        "packages": dict(sorted(packages.items())),
        "voice": script.voice,
        "speed": script.speed,
        "turns": [{"text": t.text, "pauseBeforeMs": t.pause_before_ms} for t in script.turns],
    }
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:32]


def _round_half_up(value: float) -> int:
    """JavaScript's Math.round, so word times match @earshot/voice/testing's spreadWords."""
    return math.floor(value + 0.5)


def spread_words(text: str, start_ms: int, end_ms: int) -> list[JsonObject]:
    """A turn's span spread over its words by character count, each word's share counting one
    character of gap after it: a port of spreadWords in packages/voice/src/testing/fake-stt.ts."""
    words = text.split()
    weight = sum(len(word) + 1 for word in words)
    span = max(0, end_ms - start_ms)
    out: list[JsonObject] = []
    at = 0.0
    for word in words:
        share = (len(word) + 1) / weight * span
        word_start = start_ms + at
        out.append(
            {
                "w": word,
                "startMs": _round_half_up(word_start),
                "endMs": _round_half_up(word_start + share * (len(word) / (len(word) + 1))),
            }
        )
        at += share
    return out


def _ms(samples: int, rate: int) -> int:
    return _round_half_up(samples * 1000 / rate)


# --- Audio ---------------------------------------------------------------------------------------


def upsample_2x(audio: FloatArray) -> NDArray[np.float64]:
    """Exactly twice the sample rate, through scipy's polyphase FIR (no fractional resampling)."""
    resampled = cast(
        NDArray[np.float64],
        signal.resample_poly(audio.astype(np.float64), 2, 1),  # pyright: ignore[reportUnknownMemberType]
    )
    return resampled.astype(np.float64)


def to_pcm16(audio: NDArray[np.float64]) -> PcmArray:
    """Clipped to [-1, 1] and scaled to 16-bit integers: never 24-bit, which Chrome rejects."""
    return (np.clip(audio, -1.0, 1.0) * 32767.0).astype(np.int16)


def assemble(script: Script, synthesizer: Synthesizer) -> tuple[PcmArray, list[TimedTurn]]:
    """The whole fixture at 48 kHz, and where each turn's speech sits in it."""
    parts: list[FloatArray] = []
    timed: list[TimedTurn] = []
    cursor = 0
    for index, turn in enumerate(script.turns):
        pause = turn.pause_before_ms * SOURCE_RATE // 1000
        parts.append(np.zeros(pause, dtype=np.float32))
        cursor += pause
        speech = np.asarray(
            synthesizer.synthesize(turn.text, script.voice, script.speed), dtype=np.float32
        ).reshape(-1)
        if speech.size == 0:
            raise RenderError(f"{script.id} turn {index + 1}: the voice produced no audio")
        parts.append(speech)
        timed.append(
            TimedTurn(
                index=index,
                start_ms=_ms(cursor, SOURCE_RATE),
                end_ms=_ms(cursor + speech.size, SOURCE_RATE),
                text=turn.text,
            )
        )
        cursor += speech.size
    parts.append(np.zeros(TAIL_MS * SOURCE_RATE // 1000, dtype=np.float32))
    audio24 = np.concatenate(parts).astype(np.float32)
    return to_pcm16(upsample_2x(audio24)), timed


def write_wav(path: Path, pcm: PcmArray, sample_rate: int = TARGET_RATE) -> None:
    """A mono 16-bit PCM WAV, written to a temporary name first so a crash leaves no half file."""
    if pcm.dtype != np.int16 or pcm.ndim != 1:
        raise TypeError("write_wav takes mono 16-bit samples only")
    partial = path.with_name(f"{path.name}.tmp")
    with wave.open(str(partial), "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(SAMPLE_WIDTH_BYTES)
        out.setframerate(sample_rate)
        out.writeframes(pcm.astype("<i2").tobytes())
    os.replace(partial, path)


def write_json(path: Path, document: Mapping[str, object]) -> None:
    partial = path.with_name(f"{path.name}.tmp")
    partial.write_text(json.dumps(document, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    os.replace(partial, path)


def timing_document(
    script: Script, digest: str, frames: int, turns: Sequence[TimedTurn]
) -> JsonObject:
    return {
        "version": TIMING_VERSION,
        "hash": digest,
        "voice": script.voice,
        "sampleRate": TARGET_RATE,
        "durationMs": _ms(frames, TARGET_RATE),
        "tailMs": TAIL_MS,
        "turns": [
            {
                "index": turn.index,
                "startMs": turn.start_ms,
                "endMs": turn.end_ms,
                "text": turn.text,
                "words": spread_words(turn.text, turn.start_ms, turn.end_ms),
            }
            for turn in turns
        ],
    }


# --- Rendering -----------------------------------------------------------------------------------


@dataclass(frozen=True)
class RenderResult:
    manifest: JsonObject
    # Per script id: "rendered" or "cached".
    statuses: dict[str, str]


def render(
    scripts: Sequence[Script],
    out_dir: Path,
    *,
    model_sha256: Mapping[str, str],
    packages: Mapping[str, str],
    synthesizer: Callable[[], Synthesizer],
    prune: bool = False,
    log: Callable[[str], None] = print,
) -> RenderResult:
    """Renders every script whose WAV isn't in out_dir yet, then writes manifest.json.

    `synthesizer` is called at most once, and only if something needs rendering, so a warm cache
    never loads (or downloads) the model.
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    voice: Synthesizer | None = None
    entries: dict[str, JsonObject] = {}
    statuses: dict[str, str] = {}
    for script in scripts:
        digest = render_hash(script, model_sha256=model_sha256, packages=packages)
        wav_path = out_dir / f"{digest}.wav"
        timing_path = out_dir / f"{digest}.timing.json"
        if wav_path.is_file() and timing_path.is_file():
            timing = _object(json.loads(timing_path.read_text(encoding="utf-8")), timing_path.name)
            statuses[script.id] = "cached"
            note = "cached"
        else:
            if voice is None:
                voice = synthesizer()
            started = time.monotonic()
            pcm, turns = assemble(script, voice)
            timing = timing_document(script, digest, int(pcm.size), turns)
            write_wav(wav_path, pcm)
            write_json(timing_path, timing)
            statuses[script.id] = "rendered"
            note = f"rendered in {time.monotonic() - started:.1f} s"
        duration = _get(timing, "durationMs", int, timing_path.name)
        entries[script.id] = {
            "hash": digest,
            "wav": wav_path.name,
            "timing": timing_path.name,
            "durationMs": duration,
        }
        log(f"{script.id} {digest} {duration / 1000:.1f} s of audio, {note}")
    manifest: JsonObject = {
        "version": MANIFEST_VERSION,
        "renderer": RENDERER_VERSION,
        "model": dict(sorted(model_sha256.items())),
        "packages": dict(sorted(packages.items())),
        "scripts": entries,
    }
    write_json(out_dir / "manifest.json", manifest)
    if prune:
        keep = {name for entry in entries.values() for name in (entry["wav"], entry["timing"])}
        for path in out_dir.iterdir():
            stale = path.name.endswith((".wav", ".timing.json", ".tmp")) and path.name not in keep
            if stale and path.is_file():
                path.unlink()
                log(f"pruned {path.name}")
    return RenderResult(manifest=manifest, statuses=statuses)


def summary_markdown(scripts: Sequence[Script], result: RenderResult) -> str:
    """A table for the GitHub job summary."""
    entries = cast(dict[str, JsonObject], result.manifest["scripts"])
    rows = [
        "| Script | Voice | Turns | Audio | WAV | |",
        "|---|---|---|---|---|---|",
    ]
    for script in scripts:
        entry = entries[script.id]
        seconds = cast(int, entry["durationMs"]) / 1000
        rows.append(
            f"| {script.id} | {script.voice} | {len(script.turns)} | {seconds:.1f} s "
            f"| `{entry['wav']}` | {result.statuses[script.id]} |"
        )
    rendered = sum(status == "rendered" for status in result.statuses.values())
    total = sum(cast(int, entry["durationMs"]) for entry in entries.values()) / 1000
    head = f"### Eval WAVs\n\n{len(scripts)} scripts, {total:.0f} s of audio, {rendered} rendered."
    return "\n".join([head, "", *rows, ""])


# --- Model files -------------------------------------------------------------------------------


def load_pins(path: Path = PINS) -> dict[str, PinnedFile]:
    """The pinned model files, by role (`model`, `voices`)."""
    document = _object(json.loads(path.read_text(encoding="utf-8")), path.name)
    files = _object(document.get("files"), f"{path.name} files")
    pins: dict[str, PinnedFile] = {}
    for role, raw in files.items():
        entry = _object(raw, f"{path.name} {role}")
        pin = PinnedFile(
            name=_get(entry, "name", str, role),
            url=_get(entry, "url", str, role),
            size=_get(entry, "size", int, role),
            sha256=_get(entry, "sha256", str, role),
        )
        if not pin.url.startswith("https://") or pin.size <= 0:
            raise RenderError(f"{role}: needs an https URL and a positive size")
        if not SHA256_PATTERN.match(pin.sha256) or "/" in pin.name:
            raise RenderError(f"{role}: needs a lowercase hex SHA-256 and a plain file name")
        pins[role] = pin
    for role in ("model", "voices"):
        if role not in pins:
            raise RenderError(f"{path.name} pins no {role} file")
    return pins


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1 << 20):
            digest.update(chunk)
    return digest.hexdigest()


def _download(url: str, partial: Path, limit: int, timeout: float) -> tuple[str, int]:
    digest = hashlib.sha256()
    size = 0
    response: Any
    with urllib.request.urlopen(url, timeout=timeout) as response, partial.open("wb") as out:
        while chunk := cast(bytes, response.read(1 << 20)):
            size += len(chunk)
            if size > limit:
                break  # Longer than pinned: stop here; the size check refuses it.
            digest.update(chunk)
            out.write(chunk)
    return digest.hexdigest(), size


def fetch_verified(
    pin: PinnedFile,
    directory: Path,
    *,
    attempts: int = 3,
    timeout: float = 60.0,
    log: Callable[[str], None] = print,
) -> Path:
    """The pinned file in `directory`, downloaded first unless a copy with the pinned size and
    SHA-256 is already there. Network errors are retried; a checksum mismatch is not."""
    directory.mkdir(parents=True, exist_ok=True)
    target = directory / pin.name
    if target.is_file():
        if target.stat().st_size == pin.size and sha256_of(target) == pin.sha256:
            return target
        log(f"{pin.name}: the cached copy doesn't match its pin; downloading it again")
        target.unlink()
    partial = target.with_name(f"{target.name}.part")
    for attempt in range(1, attempts + 1):
        log(f"{pin.name}: downloading {pin.size / 1e6:.1f} MB")
        try:
            digest, size = _download(pin.url, partial, pin.size, timeout)
        except (urllib.error.URLError, OSError) as error:
            partial.unlink(missing_ok=True)
            if attempt == attempts:
                raise RenderError(f"{pin.name}: download failed: {error}") from error
            time.sleep(2**attempt)
            continue
        if size != pin.size or digest != pin.sha256:
            partial.unlink(missing_ok=True)
            raise RenderError(
                f"{pin.name}: got {size} bytes with SHA-256 {digest}, "
                f"but the pin is {pin.size} bytes with {pin.sha256}"
            )
        os.replace(partial, target)
        return target
    raise AssertionError("unreachable")


# --- Kokoro ------------------------------------------------------------------------------------


class _KokoroModel(Protocol):
    def create(
        self, text: str, voice: str, speed: float = 1.0, lang: str = "en-us"
    ) -> tuple[FloatArray, int]: ...

    def get_voices(self) -> list[str]: ...


class KokoroSynthesizer:
    """kokoro-onnx, imported on first use: it lives in the tts group, not the default sync."""

    def __init__(self, model: Path, voices: Path) -> None:
        try:
            module = importlib.import_module("kokoro_onnx")
        except ImportError as error:
            raise RenderError(
                "kokoro-onnx isn't installed; run `uv sync --project lab --group tts`"
            ) from error
        factory = cast(Callable[[str, str], _KokoroModel], module.Kokoro)
        self._model = factory(str(model), str(voices))
        self.voices = frozenset(self._model.get_voices())

    def synthesize(self, text: str, voice: str, speed: float) -> FloatArray:
        if voice not in self.voices:
            raise RenderError(f"Kokoro has no voice {voice}")
        lang = "en-gb" if voice.startswith("b") else "en-us"
        audio, rate = self._model.create(text, voice=voice, speed=speed, lang=lang)
        if rate != SOURCE_RATE:
            raise RenderError(f"Kokoro returned {rate} Hz audio, not {SOURCE_RATE} Hz")
        return np.asarray(audio, dtype=np.float32).reshape(-1)


def installed_versions(names: Iterable[str]) -> dict[str, str]:
    versions: dict[str, str] = {}
    for name in names:
        try:
            versions[name] = importlib.metadata.version(name)
        except importlib.metadata.PackageNotFoundError as error:
            raise RenderError(
                f"{name} isn't installed; run `uv sync --project lab --group tts`"
            ) from error
    return versions


# --- Command line ------------------------------------------------------------------------------


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0] if __doc__ else None)
    parser.add_argument("--debriefs", type=Path, default=DEBRIEFS, help="script directory")
    parser.add_argument("--out", type=Path, default=WAVS, help="where WAVs and timing go")
    parser.add_argument("--models", type=Path, default=MODELS, help="model file cache")
    parser.add_argument("--pins", type=Path, default=PINS, help="pinned model files (JSON)")
    parser.add_argument("--only", help="comma-separated script ids, such as d001,d002")
    parser.add_argument("--prune", action="store_true", help="delete WAVs no script uses")
    parser.add_argument("--summary", type=Path, help="append a Markdown table to this file")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    only = cast(str | None, args.only)
    prune = cast(bool, args.prune)
    if only and prune:
        print(
            "render_debriefs: --prune needs every script, so it can't go with --only",
            file=sys.stderr,
        )
        return 2
    try:
        scripts = load_scripts(cast(Path, args.debriefs), only.split(",") if only else None)
        pins = load_pins(cast(Path, args.pins))
        models = cast(Path, args.models)

        def kokoro() -> Synthesizer:
            files = {role: fetch_verified(pin, models) for role, pin in pins.items()}
            return KokoroSynthesizer(files["model"], files["voices"])

        result = render(
            scripts,
            cast(Path, args.out),
            model_sha256={pin.name: pin.sha256 for pin in pins.values()},
            packages=installed_versions(TTS_PACKAGES),
            synthesizer=kokoro,
            prune=prune,
        )
    except RenderError as error:
        print(f"render_debriefs: {error}", file=sys.stderr)
        return 1
    summary = cast(Path | None, args.summary)
    if summary is not None:
        with summary.open("a", encoding="utf-8") as handle:
            handle.write(summary_markdown(scripts, result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
