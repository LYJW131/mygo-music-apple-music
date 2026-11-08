//go:build applemusic_e2e

package player

// The plugin end to end, without an Apple account: MyGo Music's own plugin
// host loads the built plugin, which starts amhelper, and MyGo's own player
// fetches and decodes what the plugin answers, as the app does. cmd/fakeapple
// stands in for Apple's CDN and a wrapper. scripts/e2e.ts copies this file
// into a checkout of MyGo (internal/player, for the player's unexported
// download and decoders) and runs it; it compiles nowhere else.
//
// What's played is checked against the same audio, unencrypted, decoded by
// the same player: AAC less the 2112 frames of priming amhelper's edit list
// skips, ALAC whole.

import (
	"bufio"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"mygo-music/internal/plugin"
)

const (
	aacID  = "1440000001"
	alacID = "1440000002"
	// fakeapple's ALAC song is 431 packets of 4096 frames; its AAC 1723 of 1024.
	songSeconds = 40
)

type fake struct {
	Wrapper    string  `json:"wrapper"`
	AAC        string  `json:"aac"`
	AACKey     string  `json:"aacKey"`
	AACSeconds float64 `json:"aacSeconds"`
}

func TestAppleMusicEndToEnd(t *testing.T) {
	dir, fakeapple, testdata := os.Getenv("AM_E2E_PLUGIN"), os.Getenv("AM_E2E_FAKEAPPLE"), os.Getenv("AM_E2E_TESTDATA")
	if dir == "" || fakeapple == "" || testdata == "" {
		t.Skip("AM_E2E_PLUGIN, AM_E2E_FAKEAPPLE and AM_E2E_TESTDATA are set by scripts/e2e.ts")
	}
	if v := os.Getenv("AM_E2E_APP_VERSION"); v != "" {
		plugin.SetAppVersion(v)
	}

	cmd := exec.Command(fakeapple, "-seconds", fmt.Sprint(songSeconds), "-testdata", testdata)
	cmd.Stderr = os.Stderr
	out, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cmd.Process.Kill(); _ = cmd.Wait() })
	line, err := bufio.NewReader(out).ReadString('\n')
	if err != nil {
		t.Fatalf("fakeapple: %v", err)
	}
	var f fake
	if err := json.Unmarshal([]byte(line), &f); err != nil {
		t.Fatalf("fakeapple said %q: %v", line, err)
	}
	// amhelper inherits it from the app, and asks fakeapple for what it would
	// ask Apple's CDN.
	t.Setenv("AMHELPER_APPLE", f.Wrapper)

	// What the plugin keeps between runs, as though it had played both songs
	// before: the AAC's file, key and length, and that the other is ALAC. So
	// it asks Apple nothing, and the wrapper only for the ALAC's keys.
	// Not t.TempDir: on Windows amhelper, which keeps files here, may not have
	// exited yet when the test ends, and the folder can't go until it has.
	data, err := os.MkdirTemp("", "applemusic-e2e-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(data) })
	keep := filepath.Join(data, "apple-music")
	write := func(name string, v any) {
		b, _ := json.Marshal(v)
		if err := os.MkdirAll(keep, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(keep, name), b, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("storage.json", map[string]any{
		"mediaUserToken": "e2e",
		"storefront":     "us",
		"resolved": map[string]any{
			aacID: map[string]any{"m": "https://aod-ssl.itunes.apple.com" + f.AAC, "k": f.AACKey, "s": f.AACSeconds},
		},
		"lossless": map[string]any{
			alacID: map[string]any{
				"q":  map[string]any{"sampleRate": 44100, "bitDepth": 16, "bandwidth": 1100000, "query": ""},
				"at": time.Now().UnixMilli(),
			},
		},
	})
	write("granted.json", true)

	p, err := plugin.Load(dir, data)
	if err != nil {
		t.Fatal(err)
	}
	defer p.Close()
	if err := p.SetSetting("wrapper", f.Wrapper); err != nil {
		t.Fatal(err)
	}

	aacFrames := int64(math.Round(f.AACSeconds*44100)) - 2112
	t.Run("aac", func(t *testing.T) {
		got := play(t, p, aacID, "high", f.AACKey, aacFrames)
		want := decode(t, f.Wrapper+"/cdn/1/aac-plain.mp4", int64(f.AACSeconds*1000))
		same(t, got, want[2112*2:])
	})
	t.Run("alac", func(t *testing.T) {
		got := play(t, p, alacID, "lossless", "", 431*4096)
		want := decode(t, f.Wrapper+"/cdn/1/plain.m4a", songSeconds*1000)
		same(t, got, want)
	})
}

// play asks the plugin for the song as the app does, and plays it with the
// app's player: its length as it opens, a seek to three quarters, and then
// the whole song from the start, which it answers.
func play(t *testing.T, p *plugin.Plugin, id, quality, key string, frames int64) []float32 {
	t0 := time.Now()
	st, err := p.Stream(id, quality)
	if err != nil {
		t.Fatalf("stream: %v", err)
	}
	asked := time.Since(t0)
	if st.Type != "m4a" || !strings.HasPrefix(st.URL, "http://127.0.0.1:") {
		t.Fatalf("stream %s at %s, want m4a from amhelper", st.Type, redact(st.URL))
	}
	if key != "" && strings.Contains(strings.ToLower(st.URL), key) {
		t.Fatal("the song's key is in the address the app is given")
	}
	dl := startDownload(st.URL, st.Size, st.Headers, nil, nil)
	s, err := openStream(dl, songSeconds*1000)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer s.Close()
	opened := time.Since(t0)
	if s.SampleRate() != 44100 {
		t.Errorf("sample rate %d, want 44100", s.SampleRate())
	}
	if s.Len() != frames {
		t.Errorf("%d frames long as it opens, want %d", s.Len(), frames)
	}

	buf := make([]float32, 8192)
	if err := s.SetPosition(s.Len() * 3 / 4); err != nil {
		t.Fatalf("seek: %v", err)
	}
	var heard int
	for heard < 44100*2 {
		n, err := s.Read(buf)
		heard += n
		if err != nil {
			break
		}
	}
	if heard < 44100*2 {
		t.Errorf("a second after a seek to three quarters gave %d samples", heard)
	}

	if err := s.SetPosition(0); err != nil {
		t.Fatalf("seek to the start: %v", err)
	}
	pcm := readAll(t, s)
	t.Logf("%s: asked %v, opened %v, played whole %v; %d frames", quality, asked.Round(time.Millisecond),
		opened.Round(time.Millisecond), time.Since(t0).Round(time.Millisecond), len(pcm)/2)
	if int64(len(pcm)/2) != frames {
		t.Errorf("played %d frames, want %d", len(pcm)/2, frames)
	}
	return pcm
}

// decode plays an unencrypted file straight from fakeapple, to compare with.
func decode(t *testing.T, url string, durationMs int64) []float32 {
	s, err := openStream(startDownload(url, 0, nil, nil, nil), durationMs)
	if err != nil {
		t.Fatalf("open %s: %v", url, err)
	}
	defer s.Close()
	return readAll(t, s)
}

func readAll(t *testing.T, s stream) []float32 {
	var pcm []float32
	buf := make([]float32, 8192)
	for {
		n, err := s.Read(buf)
		pcm = append(pcm, buf[:n]...)
		if errors.Is(err, io.EOF) {
			return pcm
		}
		if err != nil {
			t.Fatalf("read: %v", err)
		}
	}
}

func same(t *testing.T, got, want []float32) {
	t.Helper()
	if len(want) < len(got) {
		t.Fatalf("played %d samples, more than the %d there are", len(got), len(want))
	}
	first, last, worst := -1, -1, float32(0)
	for i := range got {
		if d := got[i] - want[i]; d != 0 {
			if first < 0 {
				first = i
			}
			last, worst = i, max(worst, d, -d)
		}
	}
	if first >= 0 {
		t.Errorf("frames %d to %d differ, by up to %v", first/2, last/2, worst)
	}
	var loud float32
	for _, v := range got {
		loud = max(loud, v, -v)
	}
	if loud < 0.1 {
		t.Fatalf("played silence (peak %v)", loud)
	}
}

func redact(u string) string {
	parts := strings.Split(u, "/")
	for i, part := range parts {
		if _, err := hex.DecodeString(part); err == nil && len(part) == 32 {
			parts[i] = "<secret>"
		}
	}
	return strings.Join(parts, "/")
}
