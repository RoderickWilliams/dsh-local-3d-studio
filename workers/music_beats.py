"""Call librosa's existing beat/onset algorithms; candidates need musical judgement."""
import json
import pathlib
import sys
try:
    import librosa
except ImportError as error:
    raise RuntimeError("当前 aiPython 环境未安装 librosa；请先配置已有媒体环境或安装可选媒体依赖。") from error

audio, rate = librosa.load(sys.argv[1], sr=22050, mono=True)
tempo, beats = librosa.beat.beat_track(y=audio, sr=rate, units="time")
onsets = librosa.onset.onset_detect(y=audio, sr=rate, units="time")
result = {"duration": len(audio) / rate, "bpm_candidate": float(tempo.item() if hasattr(tempo, "item") else tempo),
          "beats": beats.tolist(), "onsets": onsets.tolist(),
          "note": "自动候选点；不等同于强拍、高潮或最终剪辑点。以这份音频起点为零点，按帧率统一量化。"}
pathlib.Path(sys.argv[2]).write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
