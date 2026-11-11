# Fluid Scaling

## Overview

Fluid scaling lets components adjust their spacing based on their current dimensions. Use font-relative text sizes so text follows the user's text scale.

While fluid scaling was historically achieved using viewport units (scaling based on the screen size), modern container query units allow components to scale relative to their parent container instead. This ensures components look good regardless of where they are placed in a layout, promoting better component isolation and reusability.

## Implementation

### 1. Define a container

To use container query units, you must first define a containment context on a parent element.

```css
.component-wrapper {
  /* Define the container type. Use 'inline-size' for width-based scaling. */
  /* You can also use 'size' for both width and height, but it requires explicit sizing. */
  container-type: inline-size;

  /* Optional: Name the container for specific targeting */
  container-name: fluid-card;
}
```

### 2. Use container query units

Use container query units (`cqi`, `cqb`, etc.) for spacing relative to the container's dimensions. Use `rem` or `em` for text sizes.

*   `cqi`: 1% of the container's inline size (width in horizontal writing modes).
*   `cqb`: 1% of the container's block size (height in horizontal writing modes).

**Note**: Container units can be used directly on any property without needing an `@container` query rule. They automatically resolve based on the nearest ancestor with a defined `container-type`.

```css
.component-title {
  /* Follow the user's text scale, not the container width */
  font-size: 1.5rem;
}

.component-body {
  /* Scale padding based on container width */
  padding: 5cqi;
}
```

### 3. Constrain values with `clamp()`

Use the CSS `clamp()` function to keep spacing within minimum and maximum values. Keep text sizes in `rem` or `em`. A font-relative term or bound does not guarantee that fluid text follows the user's text scale.

For example, in a fixed `600px` container, `clamp(1rem, 5cqi, 2.5rem)` gives a font size of `30px` with a `16px` root font size, but only `32px` with a `32px` root font size. Continuous fluid typography does not guarantee proportional text scaling. Use font-relative text sizes and keep container-fluid values for spacing:

```css
.component-body {
  /* Keep padding between 1rem and 2.5rem, based on 5% of the container width */
  padding: clamp(1rem, 5cqi, 2.5rem);
}
```

Test operating system text scaling and browser zoom. Text must resize to at least 200% of its default size without loss of content or functionality (WCAG 1.4.4 Resize Text, Level AA).

### Fallback strategies

Baseline status for Container queries (size): Widely available. It's been Baseline since 2023-02-14.
Supported by: Chrome 105 (Sep 2022), Edge 105 (Sep 2022), Firefox 110 (Feb 2023), and Safari 16 (Sep 2022).

If container query units are not supported, use font-relative spacing as a fallback.

```css
.component-body {
  /* Fallback for browsers that do not support container units */
  padding: 1.5rem;
}

@supports (padding: 1cqi) {
  .component-body {
    /* Use container units for padding where supported */
    padding: clamp(1rem, 5cqi, 2.5rem);
  }
}
```

The text keeps its font-relative size in both cases. Test that the layout can contain enlarged text with both spacing rules.
