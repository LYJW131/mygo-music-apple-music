// fakeapple stands in for a wrapper and Apple's CDN, so that amhelper can be
// run end to end without an Apple account: the wrapper's /status, /m3u8 and
// /key, an enhanced-HLS master playlist with one ALAC variant (and with
// -hires a second, at that rate and called 24-bit, as a Hi-Res Lossless
// song's: hires.m3u8, hires.mp4 and hires-plain.m4a), its media
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
// It also serves the AAC the web player plays, which the plugin gets the key
// of itself: /cdn/<id>/aac.mp4, AAC-LC in 10-second fragments encrypted with
// CENC under a key it prints, and /cdn/<id>/aac-plain.mp4 the same
// unencrypted. Its audio is testdata/tone.aac, two seconds of rising tones
// that ffmpeg made, over and over, without noise substitution, whose random
// noise would come out differently from a decoder started anywhere but the
// first packet:
//
//	ffmpeg -f lavfi -i "aevalsrc='0.3*sin(2*PI*(220+110*t)*t)|0.3*sin(2*PI*(330+55*t)*t)':s=44100:d=2" \
//	  -c:a aac -aac_pns 0 -b:a 128k -f adts tone.aac
//
//	go run ./cmd/fakeapple [-addr 127.0.0.1:0] [-seconds 40] [-rate 44100] [-hires 0] [-kbps 0] [-key-delay 0]
//
// It prints one JSON line, {"wrapper": URL, "master": URL of song 1, "aac":
// path of song 1's AAC, "aacKey": its key in hex, "aacSeconds": its length as
// the playlist would add it up}, and serves until killed. Give amhelper the
// wrapper URL as its wrapper, and ask it for any catalog ID without master=.
// For the AAC, run amhelper with AMHELPER_APPLE set to the base URL, so that
// it asks this for what it would ask Apple's CDN.
package main

import (
	"bytes"
	_ "embed"
	"encoding/hex"
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

	"github.com/Eyevinn/mp4ff/aac"
	"github.com/Eyevinn/mp4ff/mp4"
)

const (
	frames      = 4096 // per ALAC packet
	fragmentLen = 15.0 // seconds, as Apple's
	prefetchKey = "skd://itunes.apple.com/P000000000/s1/e1"

	aacFrames   = 1024 // per AAC packet
	aacFragment = 430  // packets, 10 s, as the web player's
)

// The AAC's key, and the IV its samples' counters start from.
var aacKey, aacIV = []byte("fakeapple aackey"), []byte("fakeiv08")

func main() {
	addr := flag.String("addr", "127.0.0.1:0", "address to listen on")
	seconds := flag.Float64("seconds", 40, "how long the song is")
	rate := flag.Int("rate", 44100, "the sample rate the files claim (the packet decodes at any)")
	hires := flag.Int("hires", 0, "a second ALAC variant's sample rate, as a Hi-Res Lossless song has; 0 for none")
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
	playlist := mediaPlaylist(packets, *rate, "media.mp4")
	var hiresEncrypted, hiresPlain []byte
	var hiresPlaylist, hiresVariant string
	if *hires > 0 {
		n := int(math.Ceil(*seconds * float64(*hires) / frames))
		hiresEncrypted, hiresPlain = song(ct, n, *hires, true), song(pt, n, *hires, false)
		hiresPlaylist = mediaPlaylist(n, *hires, "hires.mp4")
		hiresVariant = fmt.Sprintf(`#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio-alac-stereo-%[1]d-24",NAME="ALAC",SAMPLE-RATE="%[1]d",BIT-DEPTH="24"
#EXT-X-STREAM-INF:AVERAGE-BANDWIDTH=3000000,BANDWIDTH=3300000,CODECS="alac",AUDIO="audio-alac-stereo-%[1]d-24"
hires.m3u8
`, *hires)
	}
	tone := adtsFrames(toneADTS)
	aacPackets := int(math.Ceil(*seconds * 44100 / aacFrames))
	aacEncrypted, aacPlain := aacSong(tone, aacPackets, true), aacSong(tone, aacPackets, false)

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
%[2]s`, *rate, hiresVariant)
	})
	if *hires > 0 {
		mux.HandleFunc("GET /cdn/{id}/hires.m3u8", func(w http.ResponseWriter, _ *http.Request) { _, _ = io.WriteString(w, hiresPlaylist) })
		mux.HandleFunc("GET /cdn/{id}/hires.mp4", func(w http.ResponseWriter, r *http.Request) { serve(w, r, hiresEncrypted, *kbps) })
		mux.HandleFunc("GET /cdn/{id}/hires-plain.m4a", func(w http.ResponseWriter, r *http.Request) { serve(w, r, hiresPlain, 0) })
	}
	mux.HandleFunc("GET /cdn/{id}/alac.m3u8", func(w http.ResponseWriter, _ *http.Request) { _, _ = io.WriteString(w, playlist) })
	mux.HandleFunc("GET /cdn/{id}/media.mp4", func(w http.ResponseWriter, r *http.Request) { serve(w, r, encrypted, *kbps) })
	mux.HandleFunc("GET /cdn/{id}/plain.m4a", func(w http.ResponseWriter, r *http.Request) { serve(w, r, plain, 0) })
	mux.HandleFunc("GET /cdn/{id}/aac.mp4", func(w http.ResponseWriter, r *http.Request) { serve(w, r, aacEncrypted, *kbps) })
	mux.HandleFunc("GET /cdn/{id}/aac-plain.mp4", func(w http.ResponseWriter, r *http.Request) { serve(w, r, aacPlain, 0) })

	line, _ := json.Marshal(map[string]any{"wrapper": base, "master": base + "/cdn/1/master.m3u8",
		"aac": "/cdn/1/aac.mp4", "aacKey": hex.EncodeToString(aacKey), "aacSeconds": float64(aacPackets*aacFrames) / 44100})
	fmt.Println(string(line))
	log.Fatal(http.Serve(ln, mux))
}

//go:embed testdata/tone.aac
var toneADTS []byte

// adtsFrames takes the raw AAC packets out of an ADTS stream.
func adtsFrames(b []byte) [][]byte {
	var out [][]byte
	for len(b) >= 7 {
		if b[0] != 0xff || b[1]&0xf0 != 0xf0 {
			log.Fatal("tone.aac: not ADTS")
		}
		header := 7
		if b[1]&1 == 0 {
			header = 9 // with a CRC
		}
		n := int(b[3]&3)<<11 | int(b[4])<<3 | int(b[5])>>5
		if n < header || n > len(b) {
			log.Fatal("tone.aac: a frame runs past the end")
		}
		out = append(out, b[header:n])
		b = b[n:]
	}
	return out
}

// aacSong is packets of the tone, over and over, in 10-second fragments as
// the web player's, encrypted with CENC or not. Like Apple's, the header
// gives no length.
func aacSong(tone [][]byte, packets int, encrypted bool) []byte {
	init := mp4.CreateEmptyInit()
	init.AddEmptyTrack(44100, "audio", "und")
	trak := init.Moov.Trak
	if err := trak.SetAACDescriptor(aac.AAClc, 44100); err != nil {
		log.Fatal(err)
	}
	var ipd *mp4.InitProtectData
	if encrypted {
		kid, _ := mp4.NewUUIDFromString("00112233-4455-6677-8899-aabbccddeeff")
		var err error
		if ipd, err = mp4.InitProtect(init, aacKey, aacIV, "cenc", kid, nil); err != nil {
			log.Fatal(err)
		}
	}
	var buf bytes.Buffer
	if err := init.Encode(&buf); err != nil {
		log.Fatal(err)
	}
	for n, first := 0, 0; first < packets; n, first = n+1, first+aacFragment {
		frag, err := mp4.CreateFragment(uint32(n+1), trak.Tkhd.TrackID)
		if err != nil {
			log.Fatal(err)
		}
		for i := first; i < min(first+aacFragment, packets); i++ {
			data := bytes.Clone(tone[i%len(tone)])
			frag.AddFullSample(mp4.FullSample{
				Sample:     mp4.NewSample(mp4.SyncSampleFlags, aacFrames, uint32(len(data)), 0),
				DecodeTime: uint64(i) * aacFrames,
				Data:       data,
			})
		}
		if encrypted {
			if _, err := mp4.EncryptFragment(frag, aacKey, aacIV, ipd); err != nil {
				log.Fatal(err)
			}
		}
		if err := frag.Encode(&buf); err != nil {
			log.Fatal(err)
		}
	}
	return buf.Bytes()
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
func mediaPlaylist(packets, rate int, file string) string {
	var b strings.Builder
	b.WriteString("#EXTM3U\n#EXT-X-TARGETDURATION:15\n#EXT-X-VERSION:7\n")
	fmt.Fprintf(&b, "#EXT-X-KEY:METHOD=SAMPLE-AES,URI=%q,KEYFORMAT=\"com.apple.streamingkeydelivery\"\n", prefetchKey)
	fmt.Fprintf(&b, "#EXT-X-MAP:URI=%q\n", file)
	perFragment := int(fragmentLen * float64(rate) / frames)
	for n, first := 0, 0; first < packets; n, first = n+1, first+perFragment {
		if n == 1 {
			b.WriteString("#EXT-X-KEY:METHOD=SAMPLE-AES,URI=\"skd://itunes.apple.com/p1720704575/c23\",KEYFORMAT=\"com.apple.streamingkeydelivery\"\n")
		}
		fmt.Fprintf(&b, "#EXTINF:%.5f,\n%s\n", float64((min(first+perFragment, packets)-first)*frames)/float64(rate), file)
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
