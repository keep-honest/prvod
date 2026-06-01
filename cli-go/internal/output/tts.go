// Package output renders the human-readable TTS preview, ported from
// formatTTSReadable in src/cli/local-test.ts.
package output

import (
	"encoding/json"
	"fmt"
	"strings"
)

type readableScene struct {
	SceneNumber     int     `json:"sceneNumber"`
	SceneType       string  `json:"sceneType"`
	DurationSeconds float64 `json:"durationSeconds"`
	Narration       string  `json:"narration"`
}

type readableScript struct {
	ChangeType           string          `json:"changeType"`
	Summary              string          `json:"summary"`
	TotalDurationSeconds float64         `json:"totalDurationSeconds"`
	TotalWordCount       float64         `json:"totalWordCount"`
	Scenes               []readableScene `json:"scenes"`
}

type wordTiming struct {
	Word        string  `json:"word"`
	StartTimeMs float64 `json:"startTimeMs"`
	EndTimeMs   float64 `json:"endTimeMs"`
}

type readableAudio struct {
	SceneNumber   int          `json:"sceneNumber"`
	WordTimings   []wordTiming `json:"wordTimings"`
	ClipDurations []float64    `json:"clipDurations"`
	AudioURL      string       `json:"audioUrl"`
}

// FormatTTSReadable builds the TTS preview text from raw scriptJson and
// ttsAudioJson. Unknown/missing fields degrade gracefully, matching the Node CLI.
func FormatTTSReadable(scriptJSON, ttsAudioJSON json.RawMessage) string {
	var script readableScript
	_ = json.Unmarshal(scriptJSON, &script)

	var audio []readableAudio
	if len(ttsAudioJSON) > 0 {
		_ = json.Unmarshal(ttsAudioJSON, &audio)
	}

	var lines []string
	rule := strings.Repeat("═", 55)
	sub := strings.Repeat("─", 55)

	changeType := script.ChangeType
	if changeType == "" {
		changeType = "unknown"
	}

	lines = append(lines, rule)
	lines = append(lines, "PR VIDEO SCRIPT — TTS Preview")
	lines = append(lines, rule)
	lines = append(lines, "Change type: "+changeType)
	lines = append(lines, "Summary: "+script.Summary)
	lines = append(lines, fmt.Sprintf(
		"Total duration: %ss | Word count: %s | Scenes: %d",
		num(script.TotalDurationSeconds), num(script.TotalWordCount), len(script.Scenes),
	))

	audioByScene := make(map[int]readableAudio, len(audio))
	for _, a := range audio {
		audioByScene[a.SceneNumber] = a
	}

	for _, scene := range script.Scenes {
		lines = append(lines, "")
		lines = append(lines, sub)
		lines = append(lines, fmt.Sprintf("Scene %d — %s (%ss)", scene.SceneNumber, scene.SceneType, num(scene.DurationSeconds)))
		lines = append(lines, sub)

		lines = append(lines, "Narration:")
		for _, l := range strings.Split(scene.Narration, "\n") {
			lines = append(lines, "  "+l)
		}

		a, ok := audioByScene[scene.SceneNumber]
		if ok && len(a.WordTimings) > 0 {
			lines = append(lines, "")
			lines = append(lines, "Word timings:")
			for _, wt := range a.WordTimings {
				lines = append(lines, fmt.Sprintf("  [%.3fs – %.3fs] %s", wt.StartTimeMs/1000, wt.EndTimeMs/1000, wt.Word))
			}
		}

		if ok && len(a.ClipDurations) > 0 {
			parts := make([]string, len(a.ClipDurations))
			for i, d := range a.ClipDurations {
				parts[i] = num(d) + "s"
			}
			lines = append(lines, "")
			lines = append(lines, "Clip durations: "+strings.Join(parts, " + "))
		}

		if ok && a.AudioURL != "" {
			lines = append(lines, "Audio URL: "+a.AudioURL)
		} else {
			lines = append(lines, "Audio: (no audio)")
		}
	}

	lines = append(lines, "")
	return strings.Join(lines, "\n")
}

// num formats a float without a trailing ".0" so integers print cleanly,
// matching JavaScript's default number-to-string behavior.
func num(f float64) string {
	return fmt.Sprintf("%g", f)
}
