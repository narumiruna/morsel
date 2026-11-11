# Swipe to reveal

Swipe-to-reveal patterns let users slide a foreground row or content pane horizontally to expose hidden UI—such as contextual action buttons (*Pin*, *Mute*, *Archive*, *Delete*) or a secondary side menu—**without automatically activating any action**. Instead of committing an action during the swipe, the container snaps open to reveal interactive controls that the user can inspect and activate, or swipe back to close.

> For a full-width swipe gesture that immediately commits and dismisses an item past a threshold, see `swipe-to-remove` (via `DISABLE_TELEMETRY=1 node node_modules/modern-web-guidance/skills/modern-web-guidance/modern-web.mjs retrieve "swipe-to-remove"`). For revealing a hidden header at the top of a vertical scroll container, see `pull-to-reveal` (via `DISABLE_TELEMETRY=1 node node_modules/modern-web-guidance/skills/modern-web-guidance/modern-web.mjs retrieve "pull-to-reveal"`).

## How to implement

Whether you are revealing action buttons on a list item or a side menu next to a scrollable pane, the mechanics are identical: wrap the foreground content and the hidden panel inside an outer horizontal scroll container configured with **CSS Scroll Snap** (`scroll-snap-type: x mandatory`) and **`overscroll-behavior: chain`**. The browser's native scrolling engine handles momentum, snapping, keyboard focus scrolling, and scroll chaining without JavaScript gesture listeners.

### Step 1: Mark up the swipe wrapper, content, and revealed panel

Place the foreground content first and the revealed controls (action buttons or a side menu) second inside the `.SwipeReveal` scroll container. The content starts at scroll offset `0`. The panel is hidden at `inline-end`: right in LTR and left in RTL. For each swipe action, ensure that the accessible name includes the content that it relates to, so that people can differentiate between the available controls.

```html
<!-- Example A: List item with revealable action buttons -->
<div class="SwipeReveal">
  <div class="SwipeReveal-content">
    <strong>Design review notes</strong>
    <p>Updated component specs for the Q3 release.</p>
    <button aria-label="Design review notes actions" aria-expanded="false">…</button>
  </div>
  <div class="SwipeReveal-panel" role="group" aria-label="Item actions">
    <button type="button" tabindex="-1">Pin</button>
    <button type="button" tabindex="-1">Archive</button>
    <button type="button" tabindex="-1">Delete</button>
  </div>
</div>

<!-- Example B: Scrollable content pane with a revealable side menu -->
<div class="SwipeReveal" role="region" aria-label="Document preview with swipeable side menu">
  <div class="SwipeReveal-content is-scrollable" tabindex="0">
    <h2>Article Preview</h2>
    <p>Scroll vertically through this pane, or swipe left to reveal the side menu...</p>
    <button aria-label="Article actions" aria-expanded="false">…</button>
  </div>
  <nav class="SwipeReveal-panel" aria-label="Contextual menu">
    <a href="#share" tabindex="-1">Share</a>
    <a href="#bookmark" tabindex="-1">Bookmark</a>
    <a href="#export" tabindex="-1">Export PDF</a>
  </nav>
</div>
```

### Step 2: Configure the horizontal snap container and `overscroll-behavior: chain`

When you wrap an element in an outer scroll container solely to create a swipe-to-reveal effect, that outer wrapper becomes an intermediate scroller inside the document (or another parent scroll container).

The four keywords of `overscroll-behavior` independently control whether excess scroll propagates to an ancestor scroll container (**scroll chaining**) and whether the container displays local overscroll affordances such as elastic rubber-band stretching or edge glow (**local boundary effect**):

| Value | Scroll Chaining (Propagates to Ancestor) | Local Boundary Effect (Rubber-band / Glow) | Role in Swipe-to-Reveal |
| :--- | :--- | :--- | :--- |
| `auto` | Yes | Yes | Default behavior; keep this on inner content scrollers where normal bounce feedback is desired, but avoid on the outer swipe wrapper where it causes the menu to bounce |
| `chain` | **Yes** | **No** | **Use on the outer `.SwipeReveal` scroller so excess scroll chains into the parent scroller (such as the document) without the menu or action strip bouncing** |
| `contain` | No | Yes | Traps scroll inside the container while still bouncing locally |
| `none` | No | No | Blocks both local bounce and scroll chaining to ancestors |

Make `.SwipeReveal` a two-column grid (`grid-template-columns: 100% max-content`) where `.SwipeReveal-content` snaps to `start` and `.SwipeReveal-panel` snaps to `end`:

```css
.SwipeReveal {
  /* Column 1: full-width content. Column 2: auto-sized actions or side menu. */
  display: grid;
  grid-template-columns: 100% max-content;
  overflow-x: auto;
  scroll-snap-type: x mandatory;
  scrollbar-width: none;

  /* Prevent the swipe wrapper and revealed panel from bouncing locally while
     still chaining excess scroll into the parent scroller (the document). */
  overscroll-behavior: chain;
}

@media (prefers-reduced-motion: no-preference) {
  .SwipeReveal {
    scroll-behavior: smooth;
  }
}

.SwipeReveal-content {
  scroll-snap-align: start;
  scroll-initial-target: nearest;
  background: Canvas;
}

.SwipeReveal-content:focus-visible {
  outline: auto;
  outline-offset: -2px;
}

.SwipeReveal-content.is-scrollable {
  block-size: 20rem;
  overflow: auto;
  /* Keeps default `overscroll-behavior: auto` so the content pane retains
     its normal bounce effect while chaining horizontal swipes to `.SwipeReveal`. */
}

.SwipeReveal-panel {
  /* Snapping a trailing panel to `end` (or a leading panel to `start`) brings
     all controls fully into view while keeping the adjacent edge of the content visible. */
  scroll-snap-align: end;
  display: flex;

  &:first-child {
    scroll-snap-align: start;
  }
}
```

> To reveal controls at `inline-start` (left in LTR and right in RTL), use three columns (`grid-template-columns: max-content 100% max-content`) or two columns (`max-content 100%`). Place the leading `.SwipeReveal-panel` before `.SwipeReveal-content`. Because `.SwipeReveal-content` has `scroll-initial-target: nearest`, the scroll container initially rests on the content column rather than the leading panel.

### Step 3: Reveal controls when trigger button is activated

Keep panel controls at `tabindex="-1"` until the scroller reaches the requested target and the panel is fully visible. Then set those controls to `tabindex="0"` and set the selected trigger to `aria-expanded="true"`. Close the panel when the same trigger is activated again, including during an opening animation. Disable all panel controls when closing starts.

Calculate each target from the panel or content bounds and the scroller's direction. Clamp `scrollLeft` to `[0, max]` in LTR or `[-max, 0]` in RTL. Use `instant` scrolling when `prefers-reduced-motion: reduce` matches, and `smooth` otherwise. Keep one request and one scroll listener per scroller.

```js
function setActionTabIndexes(reveal, revealedPanel) {
  const controls = reveal.querySelectorAll('.SwipeReveal-panel button, .SwipeReveal-panel a[href]');
  for (const control of controls) {
    control.tabIndex = control.closest('.SwipeReveal-panel') === revealedPanel ? 0 : -1;
  }
}

function getScrollTarget(reveal, target, alignStart) {
  const rtl = getComputedStyle(reveal).direction === 'rtl';
  const viewportLeft = reveal.getBoundingClientRect().left + reveal.clientLeft;
  const viewportRight = viewportLeft + reveal.clientWidth;
  const rect = target.getBoundingClientRect();
  const alignRight = rtl ? alignStart : !alignStart;
  const delta = alignRight ? rect.right - viewportRight : rect.left - viewportLeft;
  const left = reveal.scrollLeft + delta;
  const max = Math.max(0, reveal.scrollWidth - reveal.clientWidth);
  return rtl ? Math.max(-max, Math.min(0, left)) : Math.max(0, Math.min(max, left));
}

for (const reveal of document.querySelectorAll('.SwipeReveal')) {
  const content = reveal.querySelector('.SwipeReveal-content');
  if (!content) continue;

  const triggers = Array.from(content.querySelectorAll('[aria-label$="actions"]'));
  const panels = Array.from(reveal.querySelectorAll('.SwipeReveal-panel'));
  if (panels.length === 0) continue;

  const leadingPanel = reveal.firstElementChild.matches('.SwipeReveal-panel')
    ? reveal.firstElementChild
    : null;
  let requestedTarget = null;

  function updateScrollState() {
    // Allow one CSS pixel for fractional scroll positions.
    const reached = requestedTarget && Math.abs(reveal.scrollLeft - requestedTarget.left) <= 1;
    if (reached) requestedTarget.pending = false;

    let revealedPanel = reached ? requestedTarget.panel : null;
    if (revealedPanel) {
      const viewportLeft = reveal.getBoundingClientRect().left + reveal.clientLeft;
      const rect = revealedPanel.getBoundingClientRect();
      if (rect.left < viewportLeft - 1 || rect.right > viewportLeft + reveal.clientWidth + 1) {
        revealedPanel = null;
      }
    }

    for (const trigger of triggers) {
      const expanded = revealedPanel && trigger === requestedTarget.trigger;
      trigger.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    }
    setActionTabIndexes(reveal, revealedPanel);
  }

  reveal.addEventListener('scroll', updateScrollState, { passive: true });
  updateScrollState();

  for (const trigger of triggers) {
    trigger.addEventListener('click', () => {
      const isExpanded = requestedTarget?.trigger === trigger &&
        (requestedTarget.pending || trigger.getAttribute('aria-expanded') === 'true');
      let panel = null;
      if (!isExpanded) {
        const label = (trigger.getAttribute('aria-label') || '').toLowerCase();
        if (label.includes('leading')) {
          panel = leadingPanel;
        } else if (label.includes('trailing')) {
          panel = panels[panels.length - 1];
        } else if (panels.length === 1) {
          panel = panels[0];
        } else {
          panel = trigger === triggers[0] ? leadingPanel : panels[panels.length - 1];
        }
        if (!panel) return;
      }

      requestedTarget = {
        left: getScrollTarget(reveal, panel ?? content, !panel || panel === leadingPanel),
        panel,
        trigger: panel ? trigger : null,
        pending: true,
      };
      reveal.scrollTo({
        left: requestedTarget.left,
        behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth',
      });
      updateScrollState();
    });
  }
}
```

Along with this, use `scroll-snap-realtime-feedback` (via `DISABLE_TELEMETRY=1 node node_modules/modern-web-guidance/skills/modern-web-guidance/modern-web.mjs retrieve "scroll-snap-realtime-feedback"`) to ensure that the accessibility state information is kept up to date, if someone swipes open the associated content, rather than triggering it directly with the button.

## Best practices and pitfalls

- **DO** use `scroll-snap-type: x mandatory` rather than `proximity`. With `proximity`, a light swipe can leave the action buttons or side menu partially exposed at rest.
- **DO** set `overscroll-behavior: chain` on the outer horizontal swipe-to-reveal scroller (`.SwipeReveal`) so scroll can chain into the parent scroller without the revealed menu or action strip bouncing.
- **DO** leave `overscroll-behavior: auto` (the default) on inner scrollable content panes (`.SwipeReveal-content.is-scrollable`) where you want normal bounce feedback to happen while still chaining horizontal swipes to the outer swipe scroller.
- **DO** implement revealed actions and side-menu items as real focusable DOM controls (`<button>`, `<a>`). When `.SwipeReveal-content` is focusable or contains focusable controls, use a `focusin` listener with `event.target.matches(':focus-visible')`. Close the panel with the same content target and scroller-only `scrollTo()` path. Do not use `scrollIntoView()` to close the panel, because it can also scroll the page.
- **DO NOT** intercept `wheel`, `touchmove`, or `pointermove` events in JavaScript to manually translate the content or emulate scroll chaining. Main-thread gesture interception blocks compositor-driven scrolling, breaks native scroll momentum, and degrades responsiveness.

## Accessibility considerations

To adhere to WCAG 2.5.1 Pointer Gestures, functionality must not be available solely through swiping gestures. Visible button elements are an accessible alternative way to activate the same functionality. Buttons provide people with disabilities, particularly people using voice control software, with a usable way of activating the same functionality. Make each button at least 24×24 CSS pixels (WCAG 2.5.8 Target Size (Minimum)) and ensure that there's a way of moving focus to the button and operating it using a keyboard alone.

Another way of adhering to the 2.5.1 Pointer Gestures success criterion is by ensuring that the functionality exists elsewhere. For example, in an email app's inbox, if the email can be swiped left to be favourited, but this can also be achieved via a "Favourite email" button after navigating to an email, this would be sufficient. If the intended use case may require many repeated actions, this approach will be less usable, as it would require people with disabilities to have to spend more time accessing the alternative control. Operating system or browser features (such as a long press on iOS) can also be a sufficient alternative, but are often not as discoverable as permanently visible buttons.

## Fallback

Browser support for scroll-initial-target: Limited availability.
Supported by: Chrome 133 (Feb 2025) and Edge 133 (Feb 2025).
Unsupported in: Firefox and Safari.

When a `.SwipeReveal` container places a `.SwipeReveal-panel` at `inline-start` before `.SwipeReveal-content`, browsers that do not support `scroll-initial-target: nearest` will initially render at scroll offset `0` with the leading panel exposed.

If your Baseline target does not support `scroll-initial-target`, detect support with `CSS.supports('scroll-initial-target', 'nearest')` and call `scrollTo()` with `behavior: 'instant'` on `load` so containers with a leading panel jump straight to `.SwipeReveal-content` without scrolling the page:


## Progressive enhancement

Browser support for overscroll-behavior: Limited availability.
Supported by: Chrome 144 (Jan 2026), Edge 144 (Jan 2026), and Firefox 150 (Apr 2026).
Unsupported in: Safari.

Baseline status for Scroll snap: Widely available. It's been Baseline since 2020-01-15.
Supported by: Chrome 69 (Sep 2018), Edge 79 (Jan 2020), Firefox 68 (Jul 2019), and Safari 11 (Sep 2017).

Baseline status for scrollbar-width: Newly available. It's been Baseline since 2024-12-11.
Supported by: Chrome 121 (Jan 2024), Edge 121 (Jan 2024), Firefox 64 (Dec 2018), and Safari 18.2 (Dec 2024).

Treat `overscroll-behavior: chain` and `scrollbar-width: none` as progressive enhancements without JavaScript fallbacks:

- **Automatic CSS cascade fallback**: The initial value of `overscroll-behavior` is `auto`. Browsers that do not yet recognize the `chain` keyword ignore `overscroll-behavior: chain` at parse time and retain `auto`. Because `auto` already allows scroll chaining to ancestor scroll containers, both the swipe-to-reveal gesture and scroll chaining to the parent work across all browsers out of the box; supporting browsers simply suppress the unwanted rubber-band bounce on the outer swipe wrapper.
- **Overriding `contain` or `none`**: If a base stylesheet or utility class sets `overscroll-behavior: contain` or `none`, declare `overscroll-behavior: auto` immediately before `overscroll-behavior: chain` so browsers that do not yet support `chain` still chain scrolling to the parent rather than trapping it.
- **Scrollbar hiding (`scrollbar-width: none`)**: Hiding the horizontal scrollbar track is purely cosmetic; if an older engine ignores `scrollbar-width: none`, the swipe-to-reveal container remains fully functional with a standard scrollbar.
