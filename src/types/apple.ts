// What Apple's API answers, as far as the plugin reads it.

export interface Artwork {
  url?: string;
  width?: number;
  height?: number;
}

export interface PlayParams {
  id?: string;
  kind?: string;
  catalogId?: string | number;
  reportingId?: string;
  globalId?: string;
  isLibrary?: boolean;
  /** false for a song the listener uploaded, whose plays Apple isn't told of. */
  reporting?: boolean;
}

export interface Attributes {
  name?: string;
  artistName?: string;
  albumName?: string;
  albumArtistName?: string;
  artwork?: Artwork;
  durationInMillis?: number;
  url?: string;
  playParams?: PlayParams;
  releaseDate?: string;
  description?: { standard?: string; short?: string };
  editorialNotes?: { short?: string };
  curatorName?: string;
  trackCount?: number;
  canEdit?: boolean;
  canDelete?: boolean;
  hasCatalog?: boolean;
  lastModifiedDate?: string;
  isLive?: boolean;
  title?: { stringForDisplay?: string };
  value?: number;
  ttml?: string;
  ttmlLocalizations?: string;
  /** Such as lossless, hi-res-lossless, atmos. */
  audioTraits?: string[];
  /** An account's picture, at /v1/me/account. */
  avatarArtwork?: Artwork;
  /** With extend=extendedAssetUrls. */
  extendedAssetUrls?: { enhancedHls?: string };
}

export interface Relationship {
  data?: Resource[];
  next?: string;
}

export interface Resource {
  id: string;
  type: string;
  href?: string;
  attributes?: Attributes;
  relationships?: Record<string, Relationship | undefined>;
  views?: Record<string, Relationship | undefined>;
}

/** Most answers: a page of resources. */
export interface Body {
  data?: Resource[];
  next?: string;
}

export interface SearchBody {
  results?: Record<string, Relationship | undefined>;
}

export interface SuggestionsBody {
  results?: { suggestions?: { displayTerm?: string; searchTerm?: string }[] };
}

export interface Chart {
  name?: string;
  data: Resource[];
}

export interface ChartsBody {
  results?: { songs?: Chart[]; albums?: Chart[]; playlists?: Chart[] };
}

export interface WebPlaybackBody {
  failureType?: string | number;
  customerMessage?: string;
  songList?: {
    "hls-playlist-url"?: string;
    assets?: { flavor?: string; URL?: string; metadata?: { fileExtension?: string } }[];
  }[];
}

export interface LicenseBody {
  failureType?: string | number;
  license?: string;
  status?: number;
}
