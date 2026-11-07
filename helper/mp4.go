package main

// Decrypting Apple's fragmented MP4 as it comes. The init segment's rewrite
// follows amdl's internal/media/mp4.go.

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"log"
	"runtime"
	"sync"

	"github.com/Eyevinn/mp4ff/mp4"
)

// sampleDecrypter decrypts one sample in place. It must be safe for
// concurrent use.
type sampleDecrypter interface{ DecryptSample(sample []byte) }

// keySource returns the key of a sample description, 1-based; fresh asks
// for one other than the one given before, which decrypted to noise.
type keySource func(desc int, fresh bool) (sampleDecrypter, error)

// decryptStream reads Apple's encrypted fragmented MP4 from r and writes it
// to w in the clear as it comes: the init segment without its encryption,
// then the samples decrypted with the key of their sample description, a
// second of them to a fragment. Apple's fragments are 15 seconds, 5 MB of
// Hi-Res, which the app would wait for whole before it could play the first.
// flush is called after each fragment.
//
// check, if not nil, is asked whether the first samples each key decrypts
// came out right (decryptsALAC); when not, keyOf is asked for the key again,
// fresh, and the samples are decrypted anew before any of them is written.
func decryptStream(r io.Reader, w io.Writer, keyOf keySource, check func([][]byte) bool, flush func()) error {
	init, _, err := readInitSegment(r, 0)
	if err != nil {
		return fmt.Errorf("read init segment: %w", err)
	}
	if len(init.Moov.Traks) != 1 {
		return fmt.Errorf("%d tracks, not one", len(init.Moov.Traks))
	}
	trak := init.Moov.Traks[0]
	trackID := trak.Tkhd.TrackID
	timescale := uint64(trak.Mdia.Mdhd.Timescale)
	// The default description is read before prepareInit points every
	// fragment at the first.
	var trex *mp4.TrexBox
	if init.Moov.Mvex != nil {
		for _, x := range init.Moov.Mvex.Trexs {
			if x.TrackID == trackID {
				trex = x
			}
		}
	}
	defaultDesc := 1
	if trex != nil && trex.DefaultSampleDescriptionIndex > 0 {
		defaultDesc = int(trex.DefaultSampleDescriptionIndex)
	}
	if err := prepareInit(init); err != nil {
		return err
	}
	if err := init.Encode(w); err != nil {
		return err
	}
	flush()

	out := &fragmenter{w: w, flush: flush, trackID: trackID, every: max(timescale, 1), check: check, checked: map[int]bool{}}
	var moof *mp4.MoofBox
	var moofSize uint64
	for {
		hdr, err := mp4.DecodeHeader(r)
		if errors.Is(err, io.EOF) {
			if out.seq == 0 {
				return errors.New("the media has no samples")
			}
			return nil
		}
		if err != nil {
			return err
		}
		if hdr.Size < uint64(hdr.Hdrlen) {
			return fmt.Errorf("box %s of %d bytes", hdr.Name, hdr.Size)
		}
		payload := hdr.Size - uint64(hdr.Hdrlen)
		switch hdr.Name {
		case "moof":
			box, err := mp4.DecodeBox(0, io.MultiReader(bytes.NewReader(headerBytes(hdr)), io.LimitReader(r, int64(payload))))
			if err != nil {
				return fmt.Errorf("moof: %w", err)
			}
			moof, moofSize = box.(*mp4.MoofBox), hdr.Size
		case "mdat":
			if moof == nil {
				return errors.New("mdat without moof")
			}
			if err := out.mdat(r, moof, moofSize, hdr, trex, defaultDesc, keyOf); err != nil {
				return err
			}
			moof = nil
		default:
			if _, err := io.CopyN(io.Discard, r, int64(payload)); err != nil {
				return err
			}
		}
	}
}

func headerBytes(hdr mp4.BoxHeader) []byte {
	if hdr.Hdrlen == 16 {
		b := make([]byte, 16)
		binary.BigEndian.PutUint32(b, 1)
		copy(b[4:8], hdr.Name)
		binary.BigEndian.PutUint64(b[8:], hdr.Size)
		return b
	}
	b := make([]byte, 8)
	binary.BigEndian.PutUint32(b, uint32(hdr.Size))
	copy(b[4:8], hdr.Name)
	return b
}

// fragmenter writes the samples it's given as fragments of a second or so.
type fragmenter struct {
	w       io.Writer
	flush   func()
	trackID uint32
	every   uint64 // a fragment's duration, in the track's timescale
	seq     uint32
	check   func([][]byte) bool
	checked map[int]bool // the sample descriptions whose key was checked
}

// mdat reads an mdat's samples as they come, as the moof before it lays them
// out, and writes them decrypted.
func (f *fragmenter) mdat(r io.Reader, moof *mp4.MoofBox, moofSize uint64, hdr mp4.BoxHeader,
	trex *mp4.TrexBox, defaultDesc int, keyOf keySource,
) error {
	if len(moof.Trafs) != 1 {
		return fmt.Errorf("a fragment of %d tracks", len(moof.Trafs))
	}
	traf := moof.Traf
	if traf.Tfhd.HasBaseDataOffset() || !traf.Tfhd.DefaultBaseIfMoof() {
		return errors.New("a fragment whose data doesn't count from its moof")
	}
	desc := defaultDesc
	if traf.Tfhd.HasSampleDescriptionIndex() {
		desc = int(traf.Tfhd.SampleDescriptionIndex)
	}
	dec, err := keyOf(desc, false)
	if err != nil {
		return err
	}
	write := func(batch []mp4.FullSample) error {
		dec, err = f.write(desc, dec, keyOf, batch)
		return err
	}
	var t uint64
	if traf.Tfdt != nil {
		t = traf.Tfdt.BaseMediaDecodeTime()
	}
	payload := hdr.Size - uint64(hdr.Hdrlen)
	// Data offsets count from the moof; the payload starts after the mdat's header.
	start := moofSize + uint64(hdr.Hdrlen)
	var at uint64 // read of the payload
	var batch []mp4.FullSample
	var batchDur uint64
	for _, trun := range traf.Truns {
		trun.AddSampleDefaultValues(traf.Tfhd, trex)
		if trun.HasDataOffset() {
			off := uint64(int64(trun.DataOffset))
			if trun.DataOffset < 0 || off < start+at {
				return errors.New("samples out of order in the mdat")
			}
			if _, err := io.CopyN(io.Discard, r, int64(off-start-at)); err != nil {
				return err
			}
			at = off - start
		}
		for _, s := range trun.GetSamples() {
			if at+uint64(s.Size) > payload {
				return errors.New("a sample past the end of the mdat")
			}
			data := make([]byte, s.Size)
			if _, err := io.ReadFull(r, data); err != nil {
				return err
			}
			at += uint64(s.Size)
			batch = append(batch, mp4.FullSample{Sample: s, DecodeTime: t, Data: data})
			t += uint64(s.Dur)
			batchDur += uint64(s.Dur)
			if batchDur >= f.every {
				if err := write(batch); err != nil {
					return err
				}
				batch, batchDur = batch[:0], 0
			}
		}
	}
	if len(batch) > 0 {
		if err := write(batch); err != nil {
			return err
		}
	}
	_, err = io.CopyN(io.Discard, r, int64(payload-at))
	return err
}

// write decrypts the samples and writes them as a fragment, and returns the
// key the rest of the description's samples are to be decrypted with: dec,
// or, if dec was found wrong on them, the fresh one.
func (f *fragmenter) write(desc int, dec sampleDecrypter, keyOf keySource, samples []mp4.FullSample) (sampleDecrypter, error) {
	data := make([][]byte, len(samples))
	for i := range samples {
		data[i] = samples[i].Data
	}
	if f.check == nil || f.checked[desc] {
		decryptAll(dec, data)
	} else {
		encrypted := make([][]byte, len(data))
		for i, d := range data {
			encrypted[i] = bytes.Clone(d)
		}
		decryptAll(dec, data)
		if !f.check(data) {
			log.Printf("the key of sample description %d decrypts to noise; asking for it again", desc)
			fresh, err := keyOf(desc, true)
			if err != nil {
				return dec, err
			}
			for i := range data {
				copy(data[i], encrypted[i])
			}
			decryptAll(fresh, data)
			if !f.check(data) {
				return dec, fmt.Errorf("sample description %d: the key, even asked for again, decrypts to noise", desc)
			}
			dec = fresh
		}
		f.checked[desc] = true
	}
	f.seq++
	frag, err := mp4.CreateFragment(f.seq, f.trackID)
	if err != nil {
		return dec, err
	}
	frag.AddFullSamples(samples)
	if err := frag.Encode(f.w); err != nil {
		return dec, err
	}
	f.flush()
	return dec, nil
}

// decryptAll spreads the samples over the CPUs: a fragment of 24-bit/192 kHz
// is a few MB, and the white-box rounds are slow.
func decryptAll(dec sampleDecrypter, samples [][]byte) {
	workers := min(runtime.NumCPU(), 4)
	if workers <= 1 || len(samples) < workers*4 {
		for _, s := range samples {
			dec.DecryptSample(s)
		}
		return
	}
	var wg sync.WaitGroup
	for w := range workers {
		wg.Go(func() {
			for i := w; i < len(samples); i += workers {
				dec.DecryptSample(samples[i])
			}
		})
	}
	wg.Wait()
}

// prepareInit turns the encrypted sample entries back into ALAC, drops the
// encryption sample groups, and keeps one of Apple's two sample entries,
// which are the same once decrypted.
func prepareInit(init *mp4.InitSegment) error {
	if _, err := mp4.DecryptInit(init); err != nil {
		return fmt.Errorf("decrypt init: %w", err)
	}
	for _, trak := range init.Moov.Traks {
		if trak.Mdia == nil || trak.Mdia.Minf == nil || trak.Mdia.Minf.Stbl == nil {
			continue
		}
		stbl := trak.Mdia.Minf.Stbl
		stbl.Children = withoutEncryptionGroups(stbl.Children)
		if stsd := stbl.Stsd; stsd != nil && len(stsd.Children) > 1 {
			stsd.Children = stsd.Children[:1]
			stsd.SampleCount = 1
			if init.Moov.Mvex != nil && trak.Tkhd != nil {
				for _, trex := range init.Moov.Mvex.Trexs {
					if trex.TrackID == trak.Tkhd.TrackID {
						trex.DefaultSampleDescriptionIndex = 1
					}
				}
			}
		}
	}
	return nil
}

func withoutEncryptionGroups(children []mp4.Box) []mp4.Box {
	out := make([]mp4.Box, 0, len(children))
	for _, child := range children {
		switch box := child.(type) {
		case *mp4.SbgpBox:
			if box.GroupingType == "seig" || box.GroupingType == "seam" {
				continue
			}
		case *mp4.SgpdBox:
			if box.GroupingType == "seig" || box.GroupingType == "seam" {
				continue
			}
		}
		out = append(out, child)
	}
	return out
}

func readInitSegment(r io.Reader, offset uint64) (*mp4.InitSegment, uint64, error) {
	init := mp4.NewMP4Init()
	for {
		box, err := mp4.DecodeBox(offset, r)
		if err != nil {
			return nil, offset, err
		}
		if init.Ftyp == nil && box.Type() != "ftyp" {
			return nil, offset, fmt.Errorf("starts with %s, not ftyp", box.Type())
		}
		init.AddChild(box)
		offset += box.Size()
		if box.Type() == "moov" {
			return init, offset, nil
		}
	}
}
