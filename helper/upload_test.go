package main

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"math/rand"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeBlobstore serves song by ranges, slowly, as Apple's blobstore does,
// noting the ranges asked for and how many came at once.
type fakeBlobstore struct {
	song []byte

	mu     sync.Mutex
	asked  []int64 // where each range started
	now    int
	most   int
	broken bool
}

func (f *fakeBlobstore) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	f.now++
	f.most = max(f.most, f.now)
	broken := f.broken
	f.mu.Unlock()
	defer func() {
		f.mu.Lock()
		f.now--
		f.mu.Unlock()
	}()
	if broken || !strings.HasPrefix(r.URL.Path, "/song.m4a") {
		http.Error(w, "gone", http.StatusForbidden)
		return
	}
	var from, to int64
	if _, err := fmt.Sscanf(r.Header.Get("Range"), "bytes=%d-%d", &from, &to); err != nil {
		http.Error(w, "ranges only", http.StatusBadRequest)
		return
	}
	f.mu.Lock()
	f.asked = append(f.asked, from)
	f.mu.Unlock()
	time.Sleep(20 * time.Millisecond)
	to = min(to, int64(len(f.song))-1)
	w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", from, to, len(f.song)))
	w.Header().Set("Content-Length", strconv.FormatInt(to-from+1, 10))
	w.WriteHeader(http.StatusPartialContent)
	w.Write(f.song[from : to+1])
}

// uploadServer is amhelper's upload routes, its blobstore stood in for by f.
func uploadServer(t *testing.T, f *fakeBlobstore, dir string) (*server, string) {
	t.Helper()
	origin := httptest.NewServer(f)
	t.Cleanup(origin.Close)
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	s := &server{uploads: newUploads(ctx, dir, cdnClient(origin.URL))}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /upload/{id}", s.uploadRegister)
	mux.HandleFunc("GET /upload/{file}", s.uploadFile)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return s, srv.URL
}

func handOver(t *testing.T, base, id, sig string) {
	t.Helper()
	body := `{"url":"https://store-033.blobstore.apple.com/song.m4a?sig=` + sig + `"}`
	res, err := http.Post(base+"/upload/"+id, "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatalf("handing over: %d %s", res.StatusCode, b)
	}
}

func getRange(t *testing.T, base, id, rng string) []byte {
	t.Helper()
	req, _ := http.NewRequest("GET", base+"/upload/"+id+".m4a", nil)
	if rng != "" {
		req.Header.Set("Range", rng)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	b, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// An uploaded song comes over several connections at once and is served
// whole and in order; once in, it's kept under its library ID, and served
// from here though its link has changed and no longer works.
func TestUploadComesInPartsAndIsKept(t *testing.T) {
	song := make([]byte, 2<<20+12345)
	rand.New(rand.NewSource(1)).Read(song)
	f := &fakeBlobstore{song: song}
	s, base := uploadServer(t, f, t.TempDir())
	handOver(t, base, "i.abc", "1")
	if got := getRange(t, base, "i.abc", ""); !bytes.Equal(got, song) {
		t.Fatalf("got %d bytes, not the song's %d", len(got), len(song))
	}
	f.mu.Lock()
	most, asked := f.most, len(f.asked)
	f.broken = true
	f.mu.Unlock()
	if most < 2 || most > uploadConnections {
		t.Errorf("%d parts came at once", most)
	}
	// The last reader gone, the song is kept as it all came in.
	deadline := time.Now().Add(5 * time.Second)
	for {
		s.uploads.mu.Lock()
		n := len(s.uploads.songs)
		s.uploads.mu.Unlock()
		if n == 0 || time.Now().After(deadline) {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	handOver(t, base, "i.abc", "2")
	if got := getRange(t, base, "i.abc", "bytes=100-199"); !bytes.Equal(got, song[100:200]) {
		t.Errorf("kept, a range of it is %d bytes", len(got))
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.asked) != asked {
		t.Errorf("asked Apple %d more times for a song kept", len(f.asked)-asked)
	}
}

// A request from the middle of a song still coming in has the part it
// starts at fetched first, rather than waiting for those before it.
func TestUploadRangeFetchedFirst(t *testing.T) {
	song := make([]byte, 4<<20)
	rand.New(rand.NewSource(2)).Read(song)
	f := &fakeBlobstore{song: song}
	_, base := uploadServer(t, f, "")
	handOver(t, base, "i.mid", "1")
	from := int64(3 << 20)
	got := getRange(t, base, "i.mid", fmt.Sprintf("bytes=%d-%d", from, from+999))
	if !bytes.Equal(got, song[from:from+1000]) {
		t.Fatalf("got %d bytes, not the range's", len(got))
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	// The start's parts are asked for as the song is handed over; the
	// connections opened next, at once, start with the range's part.
	starts := len(uploadParts(uploadStart))
	first := f.asked[starts:min(len(f.asked), starts+uploadConnections)]
	in := false
	for _, at := range first {
		in = in || at <= from && from < at+uploadPart
	}
	if !in {
		t.Errorf("parts asked for in order %v, the range at %d", f.asked, from)
	}
}

// Only a library song's ID and one of Apple's blobstore links are taken.
func TestUploadTakesOnlyItsOwn(t *testing.T) {
	_, base := uploadServer(t, &fakeBlobstore{}, "")
	for _, c := range []struct{ id, url string }{
		{"123", "https://store-033.blobstore.apple.com/song.m4a"},
		{"i.abc", "https://example.com/song.m4a"},
		{"i.a%2F..", "https://store-033.blobstore.apple.com/song.m4a"},
	} {
		res, err := http.Post(base+"/upload/"+c.id, "application/json", strings.NewReader(`{"url":"`+c.url+`"}`))
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		if res.StatusCode != http.StatusBadRequest {
			t.Errorf("%s %s: %d", c.id, c.url, res.StatusCode)
		}
	}
}
