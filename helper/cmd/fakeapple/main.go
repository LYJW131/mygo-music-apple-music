// fakeapple stands in for a wrapper and Apple's CDN, so that amhelper can be
// run end to end without an Apple account: the wrapper's /status, /m3u8 and
// /key, an enhanced-HLS master playlist with one ALAC variant, its media
// playlist, and the encrypted file, laid out as Apple's are (sample
// descriptions taking turns by fragment, 15-second fragments, no length in
// the header).
//
// FairPlay's white-box only decrypts, so nothing new can be encrypted for it:
// every sample is the one encrypted sample Temari publishes with its key
// template (internal/fairplay/testdata), which decrypts to one packet of
// 16-bit stereo ALAC, 4096 frames long. The song is that packet over and
// over, as long as asked. /cdn/<id>/plain.m4a is the same song unencrypted,
// to compare what comes out of amhelper with.
//
//	go run ./cmd/fakeapple [-addr 127.0.0.1:0] [-seconds 40] [-rate 44100] [-kbps 0] [-key-delay 0]
//
// It prints one JSON line, {"wrapper": URL, "master": URL of song 1}, and
// serves until killed. Give amhelper the wrapper URL as its wrapper, and ask
// it for any catalog ID without master=.
package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"math"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/Eyevinn/mp4ff/mp4"
)

const (
	frames      = 4096 // per ALAC packet
	fragmentLen = 15.0 // seconds, as Apple's
	prefetchKey = "skd://itunes.apple.com/P000000000/s1/e1"
)

func main() {
	addr := flag.String("addr", "127.0.0.1:0", "address to listen on")
	seconds := flag.Float64("seconds", 40, "how long the song is")
	rate := flag.Int("rate", 44100, "the sample rate the files claim (the packet decodes at any)")
	kbps := flag.Int("kbps", 0, "serve the media file at most this fast, in kilobytes a second; 0 for no limit")
	keyDelay := flag.Duration("key-delay", 0, "how long /key takes, as a remote wrapper's does")
	testdata := flag.String("testdata", defaultTestdata(), "the folder with track_1720704575_s1.{json,ct,pt}")
	flag.Parse()

	read := func(ext string) []byte {
		b, err := os.ReadFile(filepath.Join(*testdata, "track_1720704575_s1."+ext))
		if err != nil {
			log.Fatal(err)
		}
		return b
	}
	template, ct, pt := read("json"), read("ct"), read("pt")
	packets := int(math.Ceil(*seconds * float64(*rate) / frames))
	encrypted := song(ct, packets, *rate, true)
	plain := song(pt, packets, *rate, false)
	playlist := mediaPlaylist(packets, *rate)

	ln, err := net.Listen("tcp", *addr)
	if err != nil {
		log.Fatal(err)
	}
	base := "http://" + ln.Addr().String()
	mux := http.NewServeMux()
	wrapperReply := func(w http.ResponseWriter, data any) {
		_ = json.NewEncoder(w).Encode(map[string]any{"code": 0, "msg": "ok", "data": data})
	}
	mux.HandleFunc("GET /status", func(w http.ResponseWriter, _ *http.Request) {
		wrapperReply(w, map[string]any{"ready": true, "regions": []string{"us"}})
	})
	mux.HandleFunc("GET /m3u8", func(w http.ResponseWriter, r *http.Request) {
		wrapperReply(w, map[string]string{"m3u8": fmt.Sprintf("%s/cdn/%s/master.m3u8", base, r.URL.Query().Get("adamId"))})
	})
	mux.HandleFunc("GET /key", func(w http.ResponseWriter, _ *http.Request) {
		time.Sleep(*keyDelay)
		wrapperReply(w, json.RawMessage(template))
	})
	mux.HandleFunc("GET /cdn/{id}/master.m3u8", func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprintf(w, `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio-stereo-256",NAME="AAC",SAMPLE-RATE="44100",BIT-DEPTH="16"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio-alac-stereo-%[1]d-16",NAME="ALAC",SAMPLE-RATE="%[1]d",BIT-DEPTH="16"
#EXT-X-STREAM-INF:AVERAGE-BANDWIDTH=262000,BANDWIDTH=270000,CODECS="mp4a.40.2",AUDIO="audio-stereo-256"
aac.m3u8
#EXT-X-STREAM-INF:AVERAGE-BANDWIDTH=1000000,BANDWIDTH=1100000,CODECS="alac",AUDIO="audio-alac-stereo-%[1]d-16"
alac.m3u8
`, *rate)
	})
	mux.HandleFunc("GET /cdn/{id}/alac.m3u8", func(w http.ResponseWriter, _ *http.Request) { _, _ = io.WriteString(w, playlist) })
	mux.HandleFunc("GET /cdn/{id}/media.mp4", func(w http.ResponseWriter, r *http.Request) { serve(w, r, encrypted, *kbps) })
	mux.HandleFunc("GET /cdn/{id}/plain.m4a", func(w http.ResponseWriter, r *http.Request) { serve(w, r, plain, 0) })

	line, _ := json.Marshal(map[string]string{"wrapper": base, "master": base + "/cdn/1/master.m3u8"})
	fmt.Println(string(line))
	log.Fatal(http.Serve(ln, mux))
}

func defaultTestdata() string {
	_, file, _, _ := runtime.Caller(0)
	return filepath.Join(filepath.Dir(file), "..", "..", "internal", "fairplay", "testdata")
}

// song is packets of sample, in 15-second fragments. Encrypted, it has
// Apple's two sample descriptions: the first fragment's opens with the
// prefetch key, the rest with the song's own.
func song(sample []byte, packets, rate int, encrypted bool) []byte {
	init := mp4.CreateEmptyInit()
	trak := init.AddEmptyTrack(uint32(rate), "audio", "und")
	entries := 1
	if encrypted {
		entries = 2
	}
	for range entries {
		alac := &mp4.AlacBox{FrameLength: frames, BitDepth: 16, Pb: 40, Mb: 10, Kb: 14, NumChannels: 2, MaxRun: 255,
			MaxFrameBytes: uint32(len(sample)), SampleRate: uint32(rate)}
		trak.Mdia.Minf.Stbl.Stsd.AddChild(mp4.CreateAudioSampleEntryBox("alac", 2, 16, uint16(min(rate, math.MaxUint16)), alac))
	}
	var buf bytes.Buffer
	if err := init.Encode(&buf); err != nil {
		log.Fatal(err)
	}
	perFragment := int(fragmentLen * float64(rate) / frames)
	for n, first := 0, 0; first < packets; n, first = n+1, first+perFragment {
		frag, err := mp4.CreateFragment(uint32(n+1), trak.Tkhd.TrackID)
		if err != nil {
			log.Fatal(err)
		}
		if encrypted {
			frag.Moof.Traf.Tfhd.Flags |= mp4.TfhdSampleDescriptionIndexPresentFlag
			frag.Moof.Traf.Tfhd.SampleDescriptionIndex = uint32(min(n+1, 2))
		}
		for i := first; i < min(first+perFragment, packets); i++ {
			frag.AddFullSample(mp4.FullSample{
				Sample:     mp4.NewSample(mp4.SyncSampleFlags, frames, uint32(len(sample)), 0),
				DecodeTime: uint64(i) * frames,
				Data:       sample,
			})
		}
		if err := frag.Encode(&buf); err != nil {
			log.Fatal(err)
		}
	}
	return buf.Bytes()
}

// mediaPlaylist lists the fragments with their lengths, which amhelper adds
// up into the song's, and the keys: the prefetch key, then the song's (c23).
func mediaPlaylist(packets, rate int) string {
	var b strings.Builder
	b.WriteString("#EXTM3U\n#EXT-X-TARGETDURATION:15\n#EXT-X-VERSION:7\n")
	fmt.Fprintf(&b, "#EXT-X-KEY:METHOD=SAMPLE-AES,URI=%q,KEYFORMAT=\"com.apple.streamingkeydelivery\"\n", prefetchKey)
	b.WriteString("#EXT-X-MAP:URI=\"media.mp4\"\n")
	perFragment := int(fragmentLen * float64(rate) / frames)
	for n, first := 0, 0; first < packets; n, first = n+1, first+perFragment {
		if n == 1 {
			b.WriteString("#EXT-X-KEY:METHOD=SAMPLE-AES,URI=\"skd://itunes.apple.com/p1720704575/c23\",KEYFORMAT=\"com.apple.streamingkeydelivery\"\n")
		}
		fmt.Fprintf(&b, "#EXTINF:%.5f,\nmedia.mp4\n", float64((min(first+perFragment, packets)-first)*frames)/float64(rate))
	}
	b.WriteString("#EXT-X-ENDLIST\n")
	return b.String()
}

// serve writes body, at most kbps kilobytes a second when kbps > 0, as a
// slow CDN would.
func serve(w http.ResponseWriter, r *http.Request, body []byte, kbps int) {
	w.Header().Set("Content-Type", "video/mp4")
	if kbps <= 0 {
		http.ServeContent(w, r, "", time.Time{}, bytes.NewReader(body))
		return
	}
	w.Header().Set("Content-Length", fmt.Sprint(len(body)))
	chunk := kbps * 1024 / 10
	for start := 0; start < len(body); start += chunk {
		if _, err := w.Write(body[start:min(start+chunk, len(body))]); err != nil {
			return
		}
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
		}
		time.Sleep(100 * time.Millisecond)
	}
}
