package output

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestFormatTTSReadable(t *testing.T) {
	script := json.RawMessage(`{
		"changeType": "feature",
		"summary": "Add auth",
		"totalDurationSeconds": 30,
		"totalWordCount": 12,
		"scenes": [
			{"sceneNumber": 1, "sceneType": "overview", "durationSeconds": 30, "narration": "Line one\nLine two"}
		]
	}`)
	audio := json.RawMessage(`[
		{"sceneNumber": 1, "audioUrl": "https://x/a.mp3",
		 "wordTimings": [{"word": "Hello", "startTimeMs": 0, "endTimeMs": 150}],
		 "clipDurations": [30]}
	]`)

	got := FormatTTSReadable(script, audio)

	for _, want := range []string{
		"PR VIDEO SCRIPT — TTS Preview",
		"Change type: feature",
		"Summary: Add auth",
		"Total duration: 30s | Word count: 12 | Scenes: 1",
		"Scene 1 — overview (30s)",
		"  Line one",
		"  Line two",
		"  [0.000s – 0.150s] Hello",
		"Clip durations: 30s",
		"Audio URL: https://x/a.mp3",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("output missing %q\n---\n%s", want, got)
		}
	}
}

func TestFormatTTSReadableNoAudio(t *testing.T) {
	script := json.RawMessage(`{"scenes":[{"sceneNumber":1,"sceneType":"hook","durationSeconds":5,"narration":"hi"}]}`)
	got := FormatTTSReadable(script, nil)
	if !strings.Contains(got, "Change type: unknown") {
		t.Errorf("missing unknown change type:\n%s", got)
	}
	if !strings.Contains(got, "Audio: (no audio)") {
		t.Errorf("missing no-audio marker:\n%s", got)
	}
}
