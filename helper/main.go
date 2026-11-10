// amhelper plays Apple Music for the MyGo Music plugin, decrypting Apple's
// encrypted files as they come from its CDN and serving them, a fragment at
// a time, on 127.0.0.1, where the app plays them. The AAC the plugin gets the
// key of itself (aac.go). The ALAC it asks a wrapper for: the playlist and
// the key templates. It also keeps the covers of the listener's own
// playlists (cover.go), and fetches the songs they uploaded (upload.go).
//
// The plugin starts it and writes one JSON line to its stdin, {"wrapper",
// "token", "cache", "covers", "uploads"}, the wrapper empty when there is
// none; it answers one line, {"port", "secret"}, and serves under /<secret>/
// until its stdin closes:
//
//	POST /<secret>/aac/<id>            {media, key, seconds}: the song's AAC
//	GET /<secret>/aac/<id>.m4a         that song, decrypted, as fragmented MP4
//	POST /<secret>/cover/<name>        {url}: keeps a playlist cover in covers
//	POST /<secret>/upload/<id>         {url}: an uploaded song's link, answering {size}
//	GET /<secret>/upload/<id>.m4a      that song, as it comes, kept in uploads once whole
//	GET /<secret>/status               the wrapper's {ready, regions}
//	POST /<secret>/wake                wakes the wrapper (one on Cloudflare sleeps)
//	GET /<secret>/token?account=       an account's {token, region, next, account} (account.go)
//	GET /<secret>/find/<id>            resolves the song only, without its keys
//	GET /<secret>/prepare/<id>         resolves the song and fetches its keys
//	GET /<secret>/song/<id>.m4a        the song's ALAC, decrypted, as fragmented MP4
//
// find, prepare and song take maxRate and maxBits, limits on the variant chosen;
// ahead=1, for a song worked out before it's played, which waits behind the
// songs played (queue.go);
// and master, the song's master playlist as Apple's catalog lists it
// (extendedAssetUrls.enhancedHls). With master and without device=1 the
// wrapper is asked for the keys only. device=1 asks the wrapper for its
// device playlist first, which lists the 88.2, 96 and 192 kHz ALAC that the
// catalog's sometimes leaves out, and falls back to master. prepare answers
// the variant and how long each step took. Errors are {code, message}: code
// "noALAC" when the song has none, "account" when the wrapper doesn't hold
// the account named, "wrapper" when the wrapper failed or there is none.
package main

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/LYJW131/mygo-music-apple-music/helper/internal/fairplay"
)

type config struct {
	Wrapper string `json:"wrapper"`
	Token   string `json:"token"`
	Cache   string `json:"cache"`   // a folder to keep keys and songs in; "" for none
	Covers  string `json:"covers"`  // a folder to keep playlist covers in; "" for none
	Uploads string `json:"uploads"` // a folder to keep uploaded songs in; "" for none
}

func main() {
	log.SetFlags(log.Ltime)
	log.SetPrefix("amhelper ")
	in := bufio.NewReader(os.Stdin)
	line, err := in.ReadBytes('\n')
	if err != nil && len(line) == 0 {
		log.Fatal("no config on stdin")
	}
	var cfg config
	if err := json.Unmarshal(line, &cfg); err != nil {
		log.Fatalf("config: %v", err)
	}
	st := &store{dir: cfg.Cache}
	// Without a wrapper there's AAC and covers, and no ALAC.
	var w *wrapper
	if strings.TrimSpace(cfg.Wrapper) != "" {
		if w, err = newWrapper(cfg.Wrapper, cfg.Token, st); err != nil {
			log.Fatal(err)
		}
	}
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		log.Fatal(err)
	}
	secret := make([]byte, 16)
	_, _ = rand.Read(secret)
	cdn := cdnClient(os.Getenv("AMHELPER_APPLE"))
	s := &server{wrapper: w, store: st, cdn: cdn, tracks: newLRU[cachedTrack](tracksKept), resolving: map[string]*resolveCall{},
		aac: newLRU[aacSong](aacKept), aacOpened: map[string]*openedMedia{}, covers: newCovers(cfg.Covers),
		uploads: newUploads(context.Background(), cfg.Uploads, cdn)}
	for k, t := range st.tracks() {
		s.tracks.put(k, t)
	}
	prefix := "/" + hex.EncodeToString(secret)
	mux := http.NewServeMux()
	mux.HandleFunc("POST "+prefix+"/aac/{id}", s.aacRegister)
	mux.HandleFunc("GET "+prefix+"/aac/{file}", s.aacSongFile)
	mux.HandleFunc("POST "+prefix+"/cover/{name}", s.cover)
	mux.HandleFunc("POST "+prefix+"/upload/{id}", s.uploadRegister)
	mux.HandleFunc("GET "+prefix+"/upload/{file}", s.uploadFile)
	needsWrapper := func(h http.HandlerFunc) http.HandlerFunc {
		return func(rw http.ResponseWriter, r *http.Request) {
			if s.wrapper == nil {
				reply(rw, http.StatusBadGateway, errorBody{"wrapper", "no wrapper set"})
				return
			}
			h(rw, r)
		}
	}
	mux.HandleFunc("GET "+prefix+"/status", needsWrapper(s.status))
	mux.HandleFunc("POST "+prefix+"/wake", needsWrapper(s.wake))
	mux.HandleFunc("GET "+prefix+"/token", needsWrapper(s.token))
	mux.HandleFunc("GET "+prefix+"/find/{id}", needsWrapper(s.findOnly))
	mux.HandleFunc("GET "+prefix+"/prepare/{id}", needsWrapper(s.prepare))
	mux.HandleFunc("GET "+prefix+"/song/{file}", needsWrapper(s.song))
	go func() { log.Fatal(http.Serve(l, mux)) }()

	hello, _ := json.Marshal(map[string]any{"port": l.Addr().(*net.TCPAddr).Port, "secret": hex.EncodeToString(secret)})
	fmt.Printf("%s\n", hello)
	// The plugin ending closes stdin; so do we.
	_, _ = io.Copy(io.Discard, in)
}

type server struct {
	wrapper *wrapper // nil without one
	store   *store
	cdn     *http.Client
	covers  *covers
	uploads *uploads

	mu        sync.Mutex
	tracks    *lru[cachedTrack]
	resolving map[string]*resolveCall
	aac       *lru[aacSong]           // the songs handed over as AAC
	aacOpened map[string]*openedMedia // their files, opened ahead of the app's request
}

type resolveCall struct {
	done chan struct{}
	t    track
	tm   timings
	err  error
}

type cachedTrack struct {
	t  track
	at time.Time
}

func (s *server) status(w http.ResponseWriter, r *http.Request) {
	st, err := s.wrapper.status(r.Context())
	if err != nil {
		fail(w, err)
		return
	}
	reply(w, http.StatusOK, st)
}

func (s *server) token(w http.ResponseWriter, r *http.Request) {
	t, err := s.wrapper.accountToken(r.Context(), r.URL.Query().Get("account"))
	if err != nil {
		fail(w, err)
		return
	}
	reply(w, http.StatusOK, t)
}

func (s *server) wake(w http.ResponseWriter, _ *http.Request) {
	reply(w, http.StatusOK, map[string]bool{"woke": s.wrapper.wake()})
}

// request is what prepare and song are asked: the song and how to find it.
type request struct {
	id               string
	ahead            bool   // worked out before it's played
	master           string // the catalog's master playlist, if the plugin has it
	device           bool   // ask the wrapper for its playlist first
	maxRate, maxBits int
}

func parseRequest(r *http.Request, id string) (request, error) {
	q := r.URL.Query()
	req := request{id: id, master: q.Get("master"), device: q.Get("device") == "1", ahead: q.Get("ahead") == "1"}
	req.maxRate, _ = strconv.Atoi(q.Get("maxRate"))
	req.maxBits, _ = strconv.Atoi(q.Get("maxBits"))
	if !catalogID(id) {
		return req, errors.New("not a catalog ID")
	}
	if req.master != "" && !appleURL(req.master) {
		return req, errors.New("not one of Apple's playlists")
	}
	return req, nil
}

// appleURL: the helper fetches only what Apple serves.
func appleURL(s string) bool {
	u, err := url.Parse(s)
	return err == nil && u.Scheme == "https" && (u.Hostname() == "apple.com" || strings.HasSuffix(u.Hostname(), ".apple.com"))
}

// cdnClient fetches from Apple's CDN, or, given AMHELPER_APPLE, a base URL,
// from there instead: the end-to-end tests set it to cmd/fakeapple's, as they
// have no account. The plugin never sets it.
func cdnClient(stand string) *http.Client {
	if stand == "" {
		return &http.Client{}
	}
	base, err := url.Parse(stand)
	if err != nil || base.Host == "" {
		log.Fatalf("AMHELPER_APPLE: not a URL: %q", stand)
	}
	log.Printf("asking %s for Apple's files", base.Host)
	return &http.Client{Transport: standIn{base, http.DefaultTransport}}
}

type standIn struct {
	base *url.URL
	next http.RoundTripper
}

func (s standIn) RoundTrip(r *http.Request) (*http.Response, error) {
	if appleURL(r.URL.String()) {
		r = r.Clone(r.Context())
		r.URL.Scheme, r.URL.Host, r.Host = s.base.Scheme, s.base.Host, ""
	}
	return s.next.RoundTrip(r)
}

// timings is how long each step of working a song out took, in ms.
type timings struct {
	M3U8   int64  `json:"m3u8,omitempty"`   // the wrapper's device playlist
	Master int64  `json:"master,omitempty"` // the master playlist, from Apple
	Media  int64  `json:"media,omitempty"`  // the variant's media playlist
	Keys   int64  `json:"keys,omitempty"`   // the key templates, at once
	Source string `json:"source,omitempty"` // where the master came from: wrapper, catalog or cache
}

// context is the request's, marked ahead or the song marked played.
func (s *server) context(r *http.Request, req request) context.Context {
	if req.ahead {
		return ahead(r.Context())
	}
	s.wrapper.queue.play(req.id)
	return r.Context()
}

// resolve returns the song's ALAC within the limits, from the cache, or from
// the master playlist the plugin gave or the wrapper's. Asked for again while
// it's worked out, as when the listener plays a song worked out ahead, the
// one answer does for both.
func (s *server) resolve(ctx context.Context, req request, tm *timings) (track, error) {
	cacheKey := req.cacheKey()
	s.mu.Lock()
	if c, ok := s.tracks.get(cacheKey); ok && time.Since(c.at) < trackTTL {
		s.mu.Unlock()
		tm.Source = "cache"
		return c.t, nil
	}
	call, ok := s.resolving[cacheKey]
	if !ok {
		call = &resolveCall{done: make(chan struct{})}
		s.resolving[cacheKey] = call
		go func() {
			// Detached, as a key is: the song is likely to be asked for again.
			base := context.Background()
			if isAhead(ctx) {
				base = ahead(base)
			}
			c, cancel := context.WithTimeout(base, time.Minute)
			defer cancel()
			call.t, call.err = s.find(c, req, &call.tm)
			s.mu.Lock()
			delete(s.resolving, cacheKey)
			if call.err == nil {
				s.tracks.put(cacheKey, cachedTrack{call.t, time.Now()})
				s.store.saveTracks(s.allTracks)
			}
			s.mu.Unlock()
			close(call.done)
		}()
	}
	s.mu.Unlock()
	select {
	case <-call.done:
		*tm = call.tm
		return call.t, call.err
	case <-ctx.Done():
		return track{}, ctx.Err()
	}
}

func (r request) cacheKey() string {
	return fmt.Sprintf("%s/%d/%d/%t", r.id, r.maxRate, r.maxBits, r.device || r.master == "")
}

func (s *server) allTracks() map[string]cachedTrack {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.tracks.all()
}

// forgetTrack drops what was worked out of the song, whose file is gone.
func (s *server) forgetTrack(req request) {
	s.mu.Lock()
	s.tracks.remove(req.cacheKey())
	s.mu.Unlock()
	s.store.saveTracks(s.allTracks)
}

// find works the song out: the master playlist, the variant, its keys' URIs.
func (s *server) find(ctx context.Context, req request, tm *timings) (track, error) {
	master, source := req.master, "catalog"
	if req.device || master == "" {
		start := time.Now()
		m, err := s.wrapper.master(ctx, req.id)
		tm.M3U8 = time.Since(start).Milliseconds()
		switch {
		case err == nil:
			master, source = m, "wrapper"
		case master == "" || ctx.Err() != nil:
			return track{}, err
		default:
			log.Printf("song %s: the wrapper's playlist didn't come, so the catalog's, which may lack Hi-Res: %v", req.id, err)
		}
	}
	tm.Source = source
	return resolveTrack(ctx, s.cdn, master, req.maxRate, req.maxBits, tm)
}

// findOnly reads the song's playlists from Apple, and keeps what they say, but
// asks the wrapper for no key: the plugin finds the songs on a page the
// listener opened, so the one they pick waits for its keys only. A song with
// device=1 still asks the wrapper for its playlist, behind the songs played.
func (s *server) findOnly(w http.ResponseWriter, r *http.Request) {
	req, err := parseRequest(r, r.PathValue("id"))
	if err != nil {
		reply(w, http.StatusBadRequest, errorBody{"badRequest", err.Error()})
		return
	}
	var tm timings
	t, err := s.resolve(s.context(r, req), req, &tm)
	if err != nil {
		fail(w, err)
		return
	}
	reply(w, http.StatusOK, struct {
		track
		Timings timings `json:"timings"`
	}{t, tm})
}

func (s *server) prepare(w http.ResponseWriter, r *http.Request) {
	req, err := parseRequest(r, r.PathValue("id"))
	if err != nil {
		reply(w, http.StatusBadRequest, errorBody{"badRequest", err.Error()})
		return
	}
	ctx := s.context(r, req)
	var tm timings
	// The key every track opens with is the same for all: it's asked for
	// while the playlists are read, once.
	go func() { _, _ = s.wrapper.template(context.Background(), "0", prefetchKey) }()
	t, err := s.resolve(ctx, req, &tm)
	if err != nil {
		fail(w, err)
		return
	}
	start := time.Now()
	if _, err := s.keys(ctx, req.id, t.Keys); err != nil {
		fail(w, err)
		return
	}
	tm.Keys = time.Since(start).Milliseconds()
	log.Printf("prepare %s%s: %d Hz / %d bit from the %s's playlist; m3u8 %dms, master %dms, media %dms, keys %dms",
		req.id, map[bool]string{true: " (ahead)"}[req.ahead], t.SampleRate, t.BitDepth, tm.Source, tm.M3U8, tm.Master, tm.Media, tm.Keys)
	reply(w, http.StatusOK, struct {
		track
		Timings timings `json:"timings"`
	}{t, tm})
}

// keys returns the templates of the track's keys, asked for at once.
func (s *server) keys(ctx context.Context, id string, uris []string) ([]*fairplay.Template, error) {
	keys := make([]*fairplay.Template, len(uris))
	errs := make([]error, len(uris))
	var wg sync.WaitGroup
	for i, key := range uris {
		wg.Go(func() { keys[i], errs[i] = s.wrapper.template(ctx, id, key) })
	}
	wg.Wait()
	return keys, errors.Join(errs...)
}

func (s *server) song(w http.ResponseWriter, r *http.Request) {
	start := time.Now()
	id, _ := strings.CutSuffix(r.PathValue("file"), ".m4a")
	req, err := parseRequest(r, id)
	if err != nil || !strings.HasSuffix(r.PathValue("file"), ".m4a") {
		reply(w, http.StatusBadRequest, errorBody{"badRequest", "not a song"})
		return
	}
	ctx := s.context(r, req)
	var t track
	var keys []*fairplay.Template
	var ready time.Duration
	var res *http.Response
	// A song worked out before, days ago maybe, whose file has since moved,
	// is worked out again, once.
	for attempt := 0; ; attempt++ {
		var tm timings
		t, err = s.resolve(ctx, req, &tm)
		if err != nil {
			fail(w, err)
			return
		}
		// The keys before the media: a key that won't come is an error the
		// app can still be told about, before the audio starts.
		keys, err = s.keys(ctx, id, t.Keys)
		if err != nil {
			fail(w, err)
			return
		}
		ready = time.Since(start)
		mediaReq, err := http.NewRequestWithContext(ctx, http.MethodGet, t.MediaURL, nil)
		if err != nil {
			fail(w, err)
			return
		}
		res, err = s.cdn.Do(mediaReq)
		if err != nil {
			fail(w, err)
			return
		}
		if res.StatusCode == http.StatusOK {
			break
		}
		res.Body.Close()
		if tm.Source != "cache" || attempt > 0 {
			fail(w, fmt.Errorf("media: HTTP %d", res.StatusCode))
			return
		}
		log.Printf("song %s: the file worked out before is gone (HTTP %d); working it out again", id, res.StatusCode)
		s.forgetTrack(req)
	}
	body := newResumingBody(ctx, s.cdn, t.MediaURL, id, res)
	defer body.Close()
	w.Header().Set("Content-Type", "audio/mp4")
	w.Header().Set("X-Sample-Rate", strconv.Itoa(t.SampleRate))
	w.Header().Set("X-Bit-Depth", strconv.Itoa(t.BitDepth))
	w.WriteHeader(http.StatusOK)
	flusher, _ := w.(http.Flusher)
	headers := time.Since(start)
	var firstAudio time.Duration
	err = decryptStream(bufio.NewReaderSize(body, 1<<20), w, func(desc int, fresh bool) (sampleDecrypter, error) {
		// Apple's sample descriptions are 1-based and keyed in playlist order;
		// one past the keys gets the first, as amdl does.
		i := desc - 1
		if i < 0 || i >= len(keys) {
			i = 0
		}
		if fresh {
			s.wrapper.forget(t.Keys[i])
			k, err := s.wrapper.template(ctx, id, t.Keys[i])
			if err != nil {
				return nil, err
			}
			keys[i] = k
		}
		return fairplayKey{keys[i]}, nil
	}, streamOptions{seconds: t.Seconds, check: decryptsALAC, flush: func() {
		if flusher != nil {
			flusher.Flush()
		}
		if firstAudio == 0 && time.Since(start) > headers {
			firstAudio = time.Since(start)
		}
	}})
	if err != nil && ctx.Err() == nil {
		log.Printf("song %s: %v", id, err)
		// Ending the answer as if the song were whole would have the app
		// play what came and move on to the next song: break it instead.
		panic(http.ErrAbortHandler)
	}
	if err == nil {
		ms := func(d time.Duration) int64 { return d.Milliseconds() }
		log.Printf("song %s: %d Hz / %d bit; keys ready %dms, Apple's headers %dms, first audio %dms, all %dms",
			id, t.SampleRate, t.BitDepth, ms(ready), ms(headers), ms(firstAudio), ms(time.Since(start)))
	}
}

func catalogID(id string) bool {
	if id == "" || len(id) > 20 {
		return false
	}
	for _, c := range id {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}

type errorBody struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func fail(w http.ResponseWriter, err error) {
	var re *replyError
	switch {
	case errors.Is(err, errAccount):
		reply(w, http.StatusNotFound, errorBody{"account", strings.TrimPrefix(err.Error(), errAccount.Error()+": ")})
	case errors.Is(err, errNoALAC):
		reply(w, http.StatusNotFound, errorBody{"noALAC", err.Error()})
	case errors.Is(err, errWrapper), errors.As(err, &re):
		reply(w, http.StatusBadGateway, errorBody{"wrapper", err.Error()})
	default:
		reply(w, http.StatusBadGateway, errorBody{"failed", err.Error()})
	}
}

func reply(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
