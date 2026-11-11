# Lazy load video and audio

Media elements (`<video>` and `<audio>`) and their associated resources (such as `<video poster>` images and preloaded metadata) consume significant network and storage bandwidth during initial page load. Even when `preload="metadata"` or `preload="none"` is set on a `<video>`, the browser eagerly fetches its `poster` image immediately, and `preload="metadata"` still initiates range requests for media headers across every player on the page.

Adding `loading="lazy"` to offscreen `<video>` and `<audio>` elements instructs the browser to defer all media network requests—including `poster` image downloads, `preload` hints, and `autoplay` execution—until the element reaches a browser-calculated distance from the visual viewport.

## How to implement

1. **Add `loading="lazy"` to offscreen media**: Apply `loading="lazy"` to `<video>` and `<audio>` elements positioned below the fold. Omit the `loading` attribute on above-the-fold media so it defaults to `eager`.
2. **Set explicit `width` and `height` on `<video>` elements**: Always specify integer `width` and `height` attributes (in CSS pixels) on `<video>`. Unloaded videos default to `300`×`150` dimensions; without explicit sizing, a lazy-loaded video may fail to intersect the visible viewport and never load, or cause disruptive layout shifts (CLS) when it loads.
3. **Include the `controls` attribute on `<audio>` elements**: Always include `controls` on `<audio loading="lazy">`. Because `<audio>` elements have no intrinsic visual box without browser controls, an `<audio loading="lazy">` element without `controls` cannot visibly intersect the viewport and will never load or autoplay.
4. **Coordinate `preload` and `poster` attributes**:
   - On `<video loading="lazy">`, both the `poster` image fetch and the `preload` behavior (`none`, `metadata`, or `auto`) are deferred until the video approaches the viewport.
   - Pair `loading="lazy"` with `preload="none"` when the user must explicitly press play after scrolling to the media, or `preload="metadata"` when duration and initial frame data should populate automatically once the player enters the viewport.
5. **Handle lazy `autoplay` safely**: When `loading="lazy"` is combined with `autoplay` on a muted `<video>` (or an opt-in `<audio controls>`), playback and downloading wait until the element approaches the viewport. Always respect `@media (prefers-reduced-motion: reduce)` before autoplaying motion media.

## Example code

```html
<!-- Above-the-fold hero video: DO NOT use loading="lazy".
     Omit loading (defaults to "eager") so the poster and initial media load immediately. -->
<video
  controls
  width="1280"
  height="720"
  poster="/images/hero-poster.jpg"
  preload="metadata"
>
  <source src="/media/keynote.webm" type="video/webm">
  <source src="/media/keynote.mp4" type="video/mp4">
  <track src="/media/keynote-en.vtt" kind="captions" srclang="en" label="English">
</video>

<!-- Below-the-fold video player:
     MANDATORY: Specify integer width and height attributes so the unloaded video
     has a non-zero layout box to intersect the viewport and avoids layout shift.
     Both the poster image and preload="metadata" are deferred until near the viewport. -->
<video
  controls
  loading="lazy"
  width="800"
  height="450"
  poster="/images/tutorial-poster.jpg"
  preload="metadata"
>
  <source src="/media/tutorial.webm" type="video/webm">
  <source src="/media/tutorial.mp4" type="video/mp4">
  <track src="/media/tutorial-en.vtt" kind="captions" srclang="en" label="English">
</video>

<!-- Below-the-fold inline product loop:
     With native media lazy-loading support, downloading and playback wait until
     the video approaches the viewport. Include muted and playsinline for autoplay.
     Unsupported browsers may download and play this video before it reaches the viewport. -->
<video
  controls
  loading="lazy"
  autoplay
  loop
  muted
  playsinline
  width="640"
  height="360"
  poster="/images/feature-loop-poster.jpg"
>
  <source src="/media/feature-loop.webm" type="video/webm">
  <source src="/media/feature-loop.mp4" type="video/mp4">
  <track src="/media/feature-loop-en.vtt" kind="captions" srclang="en" label="English">
</video>

<!-- Below-the-fold audio player:
     MANDATORY: Include the controls attribute. Lazy-loaded <audio> without
     controls is invisible, cannot intersect the viewport, and will never load. -->
<figure>
  <figcaption id="episode-title">Episode 42: Browser Architecture Deep Dive</figcaption>
  <audio
    controls
    loading="lazy"
    preload="metadata"
    src="/media/episode-42.mp3"
    aria-labelledby="episode-title"
    aria-details="episode-transcript"
  ></audio>
  <details id="episode-transcript">
    <summary>View transcript</summary>
    <p>Transcript content for Episode 42...</p>
  </details>
</figure>
```

```javascript
// Pause autoplaying videos when the user prefers reduced motion
const reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');

function syncReducedMotion(prefersReducedMotion) {
  for (const video of document.querySelectorAll('video[autoplay]')) {
    if (prefersReducedMotion) {
      video.removeAttribute('autoplay');
      video.pause();
    }
  }
}

syncReducedMotion(reducedMotionQuery.matches);
reducedMotionQuery.addEventListener('change', (event) => {
  syncReducedMotion(event.matches);
});
```

## Best practices

- **MANDATORY**: Always set explicit `width` and `height` attributes on `<video>` elements. Unloaded videos have a `300`×`150` intrinsic size and will never load if they do not intersect a visible part of the page.
- **MANDATORY**: Always include the `controls` attribute on `<audio loading="lazy">` elements. Lazy-loaded `<audio>` elements without `controls` are not rendered visibly and will never load or autoplay.
- **DO NOT** apply `loading="lazy"` to above-the-fold or Largest Contentful Paint (LCP) `<video>` elements, as it delays fetching both the `poster` image and video data.
- **DO** omit the `loading` attribute when default eager loading is desired rather than explicitly writing `loading="eager"`.
- **DO NOT** rely on the `window` `load` event to detect when lazy-loaded `<video>` or `<audio>` elements have loaded. The `load` event fires based only on eager-loaded media, even if a `loading="lazy"` media element is initially inside the visual viewport.
- **DO** note that browsers only defer `loading="lazy"` media when JavaScript is enabled (an anti-tracking measure to prevent servers from inferring scroll position via media requests when scripting is disabled).

## Fallback strategy

Browser support for Lazy-loading media: Limited availability.
Supported by: Chrome 150 (Jun 2026) and Edge 150 (Jul 2026).
Unsupported in: Firefox and Safari.

If your Baseline target does not support `loading="lazy"` on `<video>` and `<audio>`, choose between progressive enhancement and an `IntersectionObserver` fallback based on how strictly bandwidth must be conserved:

### Progressive enhancement (recommended default)

Browsers without native media lazy-loading support ignore `loading="lazy"`. Without `autoplay`, `preload="none"` or `preload="metadata"` can reduce initial media requests, but `preload` is only a hint. Poster images and metadata can still load immediately. With `autoplay`, the browser can ignore `preload` and download or play media before it approaches the viewport. Use the strict fallback below if those requests and playback must wait.

### Custom code fallback (`IntersectionObserver`)

For strict deferral, use separate markup with `data-src`, `data-poster`, and `data-autoplay` from the start. Do not move real `src`, `poster`, or `autoplay` attributes into data attributes after parsing: requests or playback can already have started.

Use this markup instead of the offscreen examples above. Omit `data-autoplay` for media that the user must start. These resources require JavaScript to load.

```html
<video
  controls
  loading="lazy"
  data-autoplay
  loop
  muted
  playsinline
  width="640"
  height="360"
  preload="none"
  data-preload="metadata"
  data-poster="/images/feature-loop-poster.jpg"
>
  <source data-src="/media/feature-loop.webm" type="video/webm">
  <source data-src="/media/feature-loop.mp4" type="video/mp4">
  <track data-src="/media/feature-loop-en.vtt" kind="captions" srclang="en" label="English">
</video>

<figure>
  <figcaption id="deferred-episode-title">Episode 42: Browser Architecture Deep Dive</figcaption>
  <audio
    controls
    loading="lazy"
    preload="none"
    data-preload="metadata"
    data-src="/media/episode-42.mp3"
    aria-labelledby="deferred-episode-title"
    aria-details="deferred-episode-transcript"
  ></audio>
  <details id="deferred-episode-transcript">
    <summary>View transcript</summary>
    <p>Transcript content for Episode 42...</p>
  </details>
</figure>
```

Restore the attributes in both paths. With native support, `loading="lazy"` controls requests and autoplay. Without native support, restore the attributes only when the media approaches the viewport.

```javascript
const supportsLazyMedia = Object.hasOwn(HTMLMediaElement.prototype, 'loading');
const lazyMediaElements = document.querySelectorAll(
  'video[loading="lazy"], audio[loading="lazy"][controls]',
);

function restoreMedia(media) {
  if (media.dataset.poster) {
    media.poster = media.dataset.poster;
    delete media.dataset.poster;
  }
  if (media.dataset.preload) {
    media.preload = media.dataset.preload;
    delete media.dataset.preload;
  }
  if (media.hasAttribute('data-autoplay')) {
    media.autoplay = media.localName !== 'video' ||
      !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    media.removeAttribute('data-autoplay');
  }
  if (media.dataset.src) {
    media.src = media.dataset.src;
    delete media.dataset.src;
  }
  for (const resource of media.querySelectorAll('source[data-src], track[data-src]')) {
    resource.src = resource.dataset.src;
    delete resource.dataset.src;
  }
  media.load();
}

if (supportsLazyMedia) {
  for (const media of lazyMediaElements) {
    restoreMedia(media);
  }
} else {
  // Example distance threshold; adjust it for your layout.
  const mediaObserver = new IntersectionObserver(
    (entries, observer) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const media = entry.target;
        restoreMedia(media);
        if (media.autoplay) {
          media.play().catch(() => {
            // Autoplay can be blocked. The controls remain available.
          });
        }
        observer.unobserve(media);
      }
    },
    { rootMargin: '200px 0px' },
  );

  for (const media of lazyMediaElements) {
    mediaObserver.observe(media);
  }
}
```
