import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowRight, ArrowUpRight } from 'lucide-react';

export type LibraryTrack = {
  id: string;
  title: string;
  artist: string;
  artwork: string | null;
  duration: number;
};

type LandingPageProps = {
  onEnter: (track: LibraryTrack) => void;
  onOpenArtwork: () => void;
};

const TITLE_TREATMENTS = [
  'condensed', 'rounded', 'blackletter', 'industrial', 'dotted', 'script', 'wide',
] as const;

type Point = readonly [number, number];

function cubic(a: Point, b: Point, c: Point, d: Point): Point[] {
  return Array.from({ length: 33 }, (_, index) => {
    const t = index / 32;
    const u = 1 - t;
    return [
      u * u * u * a[0] + 3 * u * u * t * b[0] + 3 * u * t * t * c[0] + t * t * t * d[0],
      u * u * u * a[1] + 3 * u * u * t * b[1] + 3 * u * t * t * c[1] + t * t * t * d[1],
    ];
  });
}

function joined(...parts: Point[][]): Point[] {
  return parts.flatMap((part, index) => index === 0 ? part : part.slice(1));
}

function ellipse(cx: number, cy: number, rx: number, ry: number, start = 0, end = Math.PI * 2): Point[] {
  return Array.from({ length: 129 }, (_, index) => {
    const angle = start + (end - start) * index / 128;
    return [cx + Math.cos(angle) * rx, cy + Math.sin(angle) * ry];
  });
}

const DOTTED_GLYPHS: Record<string, Point[][]> = {
  R: [
    [[6, 160], [6, 20]],
    joined([[6, 20], [48, 20]], cubic([48, 20], [101, 20], [101, 88], [48, 88]), [[48, 88], [6, 88]]),
    [[49, 88], [90, 160]],
  ],
  E: [
    [[86, 20], [6, 20], [6, 160], [86, 160]],
    [[6, 90], [70, 90]],
  ],
  S: [
    joined(
      cubic([85, 28], [58, 13], [11, 18], [8, 53]),
      cubic([8, 53], [3, 84], [86, 86], [86, 119]),
      cubic([86, 119], [91, 163], [39, 171], [7, 152]),
    ),
  ],
  O: [ellipse(47, 90, 42, 70)],
  N: [
    [[6, 160], [6, 20], [86, 160], [86, 20]],
  ],
  A: [
    [[4, 160], [46, 20], [88, 160]],
    [[20, 108], [72, 108]],
  ],
  C: [ellipse(47, 90, 42, 70, 0.63, Math.PI * 2 - 0.63)],
};

function sampleDots(points: Point[], spacing: number): Point[] {
  const lengths = [0];
  for (let index = 1; index < points.length; index += 1) {
    lengths.push(lengths[index - 1] + Math.hypot(points[index][0] - points[index - 1][0], points[index][1] - points[index - 1][1]));
  }
  const total = lengths[lengths.length - 1];
  const closed = Math.hypot(points[0][0] - points[points.length - 1][0], points[0][1] - points[points.length - 1][1]) < 0.01;
  const dots: Point[] = [];
  let segment = 1;
  for (let distance = 0; distance < total - (closed ? spacing * 0.6 : 0); distance += spacing) {
    while (segment < lengths.length - 1 && lengths[segment] < distance) segment += 1;
    const t = (distance - lengths[segment - 1]) / Math.max(0.001, lengths[segment] - lengths[segment - 1]);
    dots.push([
      points[segment - 1][0] + (points[segment][0] - points[segment - 1][0]) * t,
      points[segment - 1][1] + (points[segment][1] - points[segment - 1][1]) * t,
    ]);
  }
  if (!closed && Math.hypot(dots[dots.length - 1][0] - points[points.length - 1][0], dots[dots.length - 1][1] - points[points.length - 1][1]) > spacing * 0.55) {
    dots.push(points[points.length - 1]);
  }
  return dots;
}

const DOTTED_POINTS = Array.from('RESONANCE').flatMap((letter, letterIndex) =>
  DOTTED_GLYPHS[letter].flatMap((stroke) => sampleDots(stroke, 15).map(([x, y]) => [x + letterIndex * 116, y] as Point)))
  .filter(([x, y], index, points) => !points.slice(0, index).some(([otherX, otherY]) => Math.hypot(x - otherX, y - otherY) < 8.4));

function DottedWord() {
  return (
    <svg width="1020" height="180" viewBox="0 0 1020 180" fill="currentColor" focusable="false">
      {DOTTED_POINTS.map(([x, y], index) => {
        const variation = Math.sin(index * 19.37);
        return <circle key={index} cx={x + variation * 0.4} cy={y + Math.cos(index * 11.83) * 0.4} r={3.9 + variation * 0.28} />;
      })}
    </svg>
  );
}

function HeroTitle() {
  const titleRef = useRef<HTMLHeadingElement>(null);
  const wordRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const [frame, setFrame] = useState(0);
  const [scales, setScales] = useState<number[]>(TITLE_TREATMENTS.map(() => 1));
  const [fontsReady, setFontsReady] = useState(false);
  const [cycleReady, setCycleReady] = useState(false);
  const [framesMeasured, setFramesMeasured] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  useEffect(() => {
    let cancelled = false;
    const faces = [
      '400 200px Anton', '800 200px Nunito', '700 200px Astloch',
      '900 200px "Azeret Mono"',
      '400 200px "Pinyon Script"', '760 200px Archivo',
    ];
    void Promise.allSettled(faces.map((face) => document.fonts.load(face, 'Resonance')))
      .then((results) => {
        if (cancelled) return;
        setCycleReady(results.every((result, index) =>
          result.status === 'fulfilled' && result.value.length > 0 && document.fonts.check(faces[index], 'Resonance')));
        setFontsReady(true);
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const changed = () => {
      setReducedMotion(media.matches);
      if (media.matches) setFrame(0);
    };
    media.addEventListener('change', changed);
    return () => media.removeEventListener('change', changed);
  }, []);

  useEffect(() => {
    if (reducedMotion || !cycleReady || !framesMeasured) return;
    const timer = window.setInterval(() => setFrame((current) => (current + 1) % TITLE_TREATMENTS.length), 210);
    return () => window.clearInterval(timer);
  }, [cycleReady, framesMeasured, reducedMotion]);

  useLayoutEffect(() => {
    const title = titleRef.current;
    if (!title) return;
    let cancelled = false;
    let animationFrame = 0;
    const measure = () => {
      if (cancelled) return;
      const heroStyle = window.getComputedStyle(title.parentElement!);
      const viewportWidth = title.clientWidth + parseFloat(heroStyle.paddingLeft) + parseFloat(heroStyle.paddingRight);
      const width = Math.min(viewportWidth * 0.78, title.clientWidth * 0.98);
      const height = title.clientHeight * 0.95;
      setScales(wordRefs.current.map((word) => word
        ? Math.min(width / Math.max(1, word.offsetWidth), height / Math.max(1, word.offsetHeight))
        : 1));
      if (fontsReady) setFramesMeasured(true);
    };
    const scheduleMeasure = () => {
      if (cancelled) return;
      window.cancelAnimationFrame(animationFrame);
      animationFrame = window.requestAnimationFrame(measure);
    };
    const observer = new ResizeObserver(scheduleMeasure);
    observer.observe(title);
    window.addEventListener('resize', scheduleMeasure);
    void document.fonts.ready.then(scheduleMeasure);
    measure();
    scheduleMeasure();
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(animationFrame);
      window.removeEventListener('resize', scheduleMeasure);
      observer.disconnect();
    };
  }, [fontsReady]);

  return (
    <h1 className="hero-title" ref={titleRef} aria-label="Resonance">
      <span className="sr-only">Resonance</span>
      {TITLE_TREATMENTS.map((treatment, index) => (
        <span key={treatment}
          ref={(element) => { wordRefs.current[index] = element; }}
          className={`hero-word hero-word--${treatment}${framesMeasured && frame === index ? ' is-active' : ''}`}
          style={{ transform: `translate(-50%, -50%) scale(${scales[index] ?? 1})` }}
          aria-hidden="true">
          {treatment === 'dotted' ? <DottedWord /> : 'Resonance'}
        </span>
      ))}
    </h1>
  );
}

function searchMatches(track: LibraryTrack, query: string) {
  const normalized = query.toLocaleLowerCase();
  return `${track.title} ${track.artist}`.toLocaleLowerCase().includes(normalized);
}

export function LandingPage({ onEnter, onOpenArtwork }: LandingPageProps) {
  const [featured, setFeatured] = useState<LibraryTrack[]>([]);
  const [featuredError, setFeaturedError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<LibraryTrack[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/library/featured').then(async (response) => {
      const data = await response.json() as { tracks?: LibraryTrack[]; error?: string };
      if (!response.ok) throw new Error(data.error ?? 'The collection is unavailable.');
      if (!cancelled) setFeatured(data.tracks ?? []);
    }).catch((reason: unknown) => {
      if (!cancelled) setFeaturedError(reason instanceof Error ? reason.message : 'The collection is unavailable.');
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setResults([]);
      setSearchError(null);
      setSearching(false);
      return;
    }
    const local = featured.filter((track) => searchMatches(track, trimmed));
    setResults(local);
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setSearching(true);
      setSearchError(null);
      try {
        const response = await fetch(`/api/library/search?q=${encodeURIComponent(trimmed)}`, { signal: controller.signal });
        if (response.status === 404) throw new Error('Restart the local app to enable song search.');
        const data = await response.json() as { tracks?: LibraryTrack[]; error?: string };
        if (!response.ok) throw new Error(data.error ?? 'Search is unavailable.');
        const ids = new Set(local.map((track) => track.id));
        setResults([...local, ...(data.tracks ?? []).filter((track) => !ids.has(track.id))]);
      } catch (reason) {
        if (!controller.signal.aborted) setSearchError(reason instanceof Error ? reason.message : 'Search is unavailable.');
      } finally {
        if (!controller.signal.aborted) setSearching(false);
      }
    }, 260);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [featured, query]);

  const selectTrack = (track: LibraryTrack) => {
    setQuery('');
    onEnter(track);
  };

  const submitSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (results[0]) selectTrack(results[0]);
    else searchRef.current?.focus();
  };

  const nav = (
    <header className="landing-nav">
      <button className="landing-brand" type="button" onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}>RESONANCE</button>
      <nav aria-label="Main navigation">
        <a href="/canvas" onClick={(event) => { event.preventDefault(); onOpenArtwork(); }}>CANVAS</a>
        <a href="#about">ABOUT</a>
      </nav>
    </header>
  );

  return (
    <main className="landing-shell">
      {nav}
      <section className="landing-hero" id="top" aria-label="Resonance introduction">
        <p className="hero-eyebrow">AN INTERACTIVE AUDIOVISUAL EXPERIENCE</p>
        <HeroTitle />
        <div className="hero-search-wrap">
          <form className="hero-search" role="search" onSubmit={submitSearch}>
            <label className="sr-only" htmlFor="song-search">Search for a song</label>
            <input id="song-search" ref={searchRef} type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="SEARCH FOR A SONG" autoComplete="off" aria-controls="song-search-results" aria-expanded={query.trim().length >= 2} />
            <button type="submit" aria-label="Choose first search result"><ArrowRight size={29} strokeWidth={1.6} aria-hidden="true" /></button>
          </form>
          {query.trim().length >= 2 && (
            <div className="hero-search-results" id="song-search-results" aria-live="polite">
              {results.map((track) => (
                <button key={track.id} type="button" onClick={() => selectTrack(track)}>
                  {track.artwork && <img src={track.artwork} alt="" loading="lazy" />}
                  <span><strong>{track.title}</strong><small>{track.artist}</small></span>
                  <ArrowUpRight size={17} aria-hidden="true" />
                </button>
              ))}
              {searching && <p>SEARCHING…</p>}
              {searchError && results.length === 0 && <p>{searchError}</p>}
              {!searching && !searchError && results.length === 0 && <p>NO MATCHES IN THE AUDIUS CATALOG</p>}
            </div>
          )}
        </div>
      </section>
      <section className="collection" id="collection" aria-labelledby="collection-heading">
        {featuredError && <p className="collection-error" role="status">{featuredError}</p>}
        {!featuredError && featured.length === 0 && <p className="collection-loading">LOADING THE COLLECTION…</p>}
        <div className="collection-grid">
          {featured.map((track, index) => (
            <button className="gallery-card" key={track.id} type="button" onClick={() => selectTrack(track)} aria-label={`Open ${track.title} by ${track.artist} in the canvas`}>
              <span className="gallery-print">{track.artwork && <img src={track.artwork} alt="" loading="lazy" />}</span>
              <span className="gallery-caption"><strong>{track.title}</strong><span>{String(index + 1).padStart(2, '0')}</span></span>
            </button>
          ))}
        </div>
      </section>
      <section className="landing-about" id="about" aria-labelledby="about-heading">
        <p> </p>
        <h2 id="about-heading">SOUND<br />GIVEN FORM.</h2>
        <div className="about-copy">
          <p>An album cover can feel like a still from a film that doesn’t exist. It gives you a color, a place, the suggestion of a story continuing just outside the frame. You return to it each time the song plays. The picture is always waiting, exactly as you left it.</p>
          <p>Then it moves.</p>
          <p>Its colors loosen and drift into the dark. The music draws them into forms that gather, break, and disappear. You move, and the picture takes another turn. There is no final image. Only the one taking shape while you’re here.</p>
          <p className="about-signoff">This is Resonance.</p>
          <button type="button" onClick={onOpenArtwork}>FOLLOW THE SOUND<ArrowUpRight size={18} aria-hidden="true" /></button>
        </div>
      </section>
      <footer className="landing-footer"><span>RESONANCE</span><span>AN AUDIOVISUAL STUDY</span></footer>
    </main>
  );
}
